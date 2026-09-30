// mod-dashboard: snapshot of online characters for the web map, plus a small
// command path (pause / resume a random bot).
//
// Threading: the snapshot is built in WorldScript::OnUpdate, which World::Update
// calls after the map update, so every Player read happens on the world thread
// with maps idle. HTTP threads only copy a finished string or put a command on
// the queue; the queue is drained in the same OnUpdate. HTTP threads never
// touch a game object.

#include "mod_dashboard_settings.h"

#include "Config.h"
#include "DBCStores.h"
#include "Group.h"
#include "Log.h"
#include "Map.h"
#include "ObjectAccessor.h"
#include "Player.h"
#include "BuiltInConfig.h"
#include "ScriptMgr.h"
#include "UpdateTime.h"
#include "World.h"
#include "WorldSession.h"

#include "PlayerbotAI.h"
#include "PlayerbotMgr.h"
#include "Playerbots.h"
#include "PositionValue.h"
#include "RandomPlayerbotMgr.h"

#include "httplib.h"
#include "nlohmann/json.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <ctime>
#include <deque>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <future>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>
#include <unordered_map>
#include <vector>

// Loaded by core but not exported in DBCStores.h.
extern DBCStorage<WorldMapAreaEntry> sWorldMapAreaStore;

namespace
{
    using json = nlohmann::json;

    struct Listener
    {
        std::unique_ptr<httplib::Server> server;
        std::thread thread;
    };

    bool s_enable = true;
    uint32 s_intervalMs = 2000;
    uint32 s_elapsedMs = 0;
    uint32 s_pauseHoldSec = 86400;

    // Never destroyed: a joinable std::thread destructor at process exit would
    // terminate the server if OnShutdown was skipped.
    std::vector<Listener>& Listeners()
    {
        static auto* listeners = new std::vector<Listener>();
        return *listeners;
    }

    std::mutex s_dataLock;
    std::shared_ptr<std::string const> s_bots;
    std::shared_ptr<std::string const> s_worldmap;
    std::string s_token;
    std::deque<json> s_history;
    constexpr size_t HISTORY_SIZE = 50;

    std::shared_ptr<std::string const> Load(std::shared_ptr<std::string const> const& slot)
    {
        std::lock_guard<std::mutex> lock(s_dataLock);
        return slot;
    }

    void Store(std::shared_ptr<std::string const>& slot, std::string text)
    {
        auto value = std::make_shared<std::string const>(std::move(text));
        std::lock_guard<std::mutex> lock(s_dataLock);
        slot = std::move(value);
    }

    // Names can hold bytes that are not valid UTF-8; replace them rather than
    // let nlohmann throw on the world thread.
    std::string Dump(json const& doc)
    {
        return doc.dump(-1, ' ', false, json::error_handler_t::replace);
    }

    bool IsBot(Player* player, PlayerbotAI* ai)
    {
        if (WorldSession* session = player->GetSession())
            if (session->IsBot())
                return true;

        return ai && ai->IsBotAI();
    }

    std::string MapName(uint32 mapId)
    {
        MapEntry const* entry = sMapStore.LookupEntry(mapId);
        return entry ? entry->name[0] : "";
    }

    std::string AreaName(uint32 areaId)
    {
        AreaTableEntry const* entry = sAreaTableStore.LookupEntry(areaId);
        return entry ? entry->area_name[0] : "";
    }

    // ---- Commands --------------------------------------------------------

    struct Command
    {
        uint64 id = 0;
        std::string cmd;
        uint32 guid = 0;
        std::string key;     // "setting" only
        std::string value;   // "setting" only
        std::string from;
        std::promise<json> result;
    };

    std::mutex s_cmdLock;
    std::deque<std::shared_ptr<Command>> s_queue;
    std::atomic<size_t> s_pending{ 0 };
    std::atomic<uint64> s_nextId{ 1 };
    constexpr size_t QUEUE_LIMIT = 32;

    // ---- Settings (Dashboard.Settings.*) ---------------------------------
    //
    // A short list of config keys the page may show and, with the command
    // token, change. Values are read on the world thread only -- ConfigMgr's
    // getters take no lock, and a reload rewrites the map under them -- and
    // published as a finished string like /bots. A change rewrites the key in
    // Dashboard.Settings.File and queues Dashboard.Settings.ReloadCommand on the
    // console queue, the way a console or SOAP command runs.
    std::vector<std::string> s_settingKeys;   // guarded by s_dataLock
    struct SettingTarget
    {
        std::string file;
        std::string reload;
    };
    std::unordered_map<std::string, SettingTarget> s_settingTargets; // world thread
    std::unordered_map<std::string, std::string> s_savedSettings;   // pending reload, world thread
    std::shared_ptr<std::string const> s_settings;

    // World thread only.
    struct PauseState
    {
        std::vector<std::string> saved;   // non-combat strategies before the pause
        std::string name;
        time_t since = 0;
    };
    std::unordered_map<uint32, PauseState> s_paused;

    // Non-combat strategies a paused bot keeps: chat commands, packet handling,
    // eating/drinking, quest-log cleanup and mount state. Everything else
    // (new rpg, grind, quest, gather, loot, pvp, duel, lfg, bg, follow, buffs,
    // assists) can move the bot or start a fight, so it is removed. The combat
    // engine is untouched: a paused bot still fights back when attacked, and
    // "stay" walks it back afterwards.
    std::set<std::string> const PAUSE_KEEP = { "chat", "default", "nc", "food", "mount", "stay" };

    bool NeedsStrip(std::vector<std::string> const& current)
    {
        bool hasStay = false;
        for (std::string const& s : current)
        {
            if (s == "stay")
                hasStay = true;
            else if (!PAUSE_KEEP.count(s))
                return true;
        }
        return !hasStay;
    }

    // Same path as the bot's own "nc -x,+y" chat command (ChangeStrategy), but
    // without PlayerbotRepository::Save: a pause is never persisted, so a
    // logout or restart ends it cleanly.
    void ApplyPause(Player* player, PlayerbotAI* ai)
    {
        std::string change;
        for (std::string const& s : ai->GetStrategies(BOT_STATE_NON_COMBAT))
            if (!PAUSE_KEEP.count(s))
                change += "-" + s + ",";
        change += "+stay";
        ai->ChangeStrategy(change, BOT_STATE_NON_COMBAT);

        // Mirrors PositionsResetAction::SetStayPosition.
        PositionMap& posMap = ai->GetAiObjectContext()->GetValue<PositionMap&>("position")->Get();
        PositionInfo pos = posMap["stay"];
        pos.Set(player->GetPositionX(), player->GetPositionY(), player->GetPositionZ(), player->GetMapId());
        posMap["stay"] = pos;

        // Push the next random-bot teleport past the pause.
        sRandomPlayerbotMgr.ScheduleTeleport(player->GetGUID().GetCounter(), s_pauseHoldSec);
    }

    json Result(bool ok, std::string message, int status)
    {
        return { { "ok", ok }, { "message", std::move(message) }, { "status", status } };
    }

    json DoPause(uint32 guid)
    {
        Player* player = ObjectAccessor::FindPlayer(ObjectGuid::Create<HighGuid::Player>(guid));
        if (!player || !player->IsInWorld())
            return Result(false, "No online character with that GUID", 404);

        PlayerbotAI* ai = PlayerbotsMgr::instance().GetPlayerbotAI(player);
        if (!ai || !IsBot(player, ai))
            return Result(false, player->GetName() + " is not a bot", 409);
        if (!sRandomPlayerbotMgr.IsRandomBot(player))
            return Result(false, player->GetName() + " is not a random bot; only random bots can be paused", 409);
        if (s_paused.count(guid))
            return Result(true, player->GetName() + " is already paused", 200);
        if (player->InBattleground() || player->InArena())
            return Result(false, player->GetName() + " is in a battleground; try again after it leaves", 409);
        if (player->IsInFlight())
            return Result(false, player->GetName() + " is on a flight path; try again after it lands", 409);

        PauseState state;
        state.saved = ai->GetStrategies(BOT_STATE_NON_COMBAT);
        state.name = player->GetName();
        state.since = std::time(nullptr);

        ApplyPause(player, ai);
        size_t stashed = state.saved.size();
        s_paused[guid] = std::move(state);

        std::string note = player->isDead() ? " (dead: the random-bot revive will still move it)" : "";
        return Result(true, "Paused " + player->GetName() + "; " + std::to_string(stashed) + " strategies saved" + note, 200);
    }

    json DoResume(uint32 guid)
    {
        auto it = s_paused.find(guid);
        if (it == s_paused.end())
            return Result(false, "That bot is not paused", 409);

        Player* player = ObjectAccessor::FindPlayer(ObjectGuid::Create<HighGuid::Player>(guid));
        PlayerbotAI* ai = player ? PlayerbotsMgr::instance().GetPlayerbotAI(player) : nullptr;
        if (!player || !player->IsInWorld() || !ai)
        {
            std::string name = it->second.name;
            s_paused.erase(it);
            return Result(true, name + " is offline; the pause already ended at logout", 200);
        }

        std::vector<std::string> const& saved = it->second.saved;
        std::vector<std::string> current = ai->GetStrategies(BOT_STATE_NON_COMBAT);

        std::string change;
        for (std::string const& s : current)
            if (std::find(saved.begin(), saved.end(), s) == saved.end())
                change += "-" + s + ",";
        for (std::string const& s : saved)
            if (std::find(current.begin(), current.end(), s) == current.end())
                change += "+" + s + ",";
        if (!change.empty())
            ai->ChangeStrategy(change, BOT_STATE_NON_COMBAT);

        // Mirrors PositionsResetAction::ResetStayPosition.
        PositionMap& posMap = ai->GetAiObjectContext()->GetValue<PositionMap&>("position")->Get();
        PositionInfo pos = posMap["stay"];
        pos.Reset();
        posMap["stay"] = pos;

        // Back to a normal random teleport interval.
        sRandomPlayerbotMgr.ScheduleTeleport(guid);

        size_t restored = saved.size();
        s_paused.erase(it);
        return Result(true, "Resumed " + player->GetName() + "; " + std::to_string(restored) + " strategies restored", 200);
    }

    // World thread. Publish active values and any changes still awaiting activation.
    std::string BuildSettings()
    {
        bool commands;
        {
            std::lock_guard<std::mutex> lock(s_dataLock);
            commands = !s_token.empty();
        }
        json list = json::array();
        bool writable = false;
        for (auto const& [key, target] : s_settingTargets)
        {
            std::string active = sConfigMgr->GetOption<std::string>(key, "", false);
            auto saved = s_savedSettings.find(key);
            if (saved != s_savedSettings.end() && saved->second == active)
            {
                s_savedSettings.erase(saved);
                saved = s_savedSettings.end();
            }
            bool canWrite = commands && !target.file.empty();
            writable = writable || canWrite;
            json row = { { "key", key }, { "value", active }, { "writable", canWrite },
                         { "file", std::filesystem::path(target.file).filename().string() },
                         { "reload", target.reload } };
            if (saved != s_savedSettings.end())
                row["saved"] = saved->second;
            list.push_back(std::move(row));
        }
        return Dump({ { "enabled", !list.empty() }, { "writable", writable },
                      { "file", "" }, { "reload", "" }, { "settings", list } });
    }

    void PrintCliLine(void*, std::string_view text)
    {
        if (!text.empty())
            LOG_INFO("module", "[Dashboard] reload: {}", text);
    }

    void CliFinished(void*, bool success)
    {
        if (!success)
            LOG_WARN("module", "[Dashboard] the settings reload command did not succeed");
    }

    // World thread. Recheck the allowlist here: it may have changed since enqueue.
    json DoSetting(std::string const& key, std::string const& value)
    {
        {
            std::lock_guard<std::mutex> lock(s_dataLock);
            if (s_token.empty())
                return Result(false, "Commands have been disabled", 403);
        }
        auto found = s_settingTargets.find(key);
        if (found == s_settingTargets.end())
            return Result(false, "Setting is no longer allowed", 403);
        SettingTarget const target = found->second;
        if (target.file.empty())
            return Result(false, "This setting has no writable config file", 409);
        std::string error = DashboardSettings::Write(target.file, key, value);
        if (!error.empty())
            return Result(false, error, 500);
        s_savedSettings[key] = value;
        if (target.reload.empty())
            return Result(true, "Saved " + key + "; a reload or restart is required", 200);

        sWorld->QueueCliCommand(new CliCommandHolder(nullptr, target.reload.c_str(), &PrintCliLine, &CliFinished));
        return Result(true, "Saved " + key + "; queued '" + target.reload + "'. Check the active value after reload.", 200);
    }

    void Remember(json entry)
    {
        std::lock_guard<std::mutex> lock(s_dataLock);
        s_history.push_front(std::move(entry));
        while (s_history.size() > HISTORY_SIZE)
            s_history.pop_back();
    }

    void RecordSystemEvent(uint32 guid, std::string const& name, std::string const& message)
    {
        LOG_INFO("module", "[Dashboard] {} ({}): {}", name, guid, message);
        Remember({ { "id", 0 }, { "ts", static_cast<int64>(std::time(nullptr)) }, { "cmd", "system" },
                   { "guid", guid }, { "from", "world" }, { "ok", true }, { "message", message } });
    }

    // World thread. Something else may reset a paused bot's strategies
    // (group changes, talent or level randomization); put the pause back.
    // A bot that logged out loses its pause.
    void MaintainPauses()
    {
        for (auto it = s_paused.begin(); it != s_paused.end();)
        {
            uint32 guid = it->first;
            Player* player = ObjectAccessor::FindPlayer(ObjectGuid::Create<HighGuid::Player>(guid));
            PlayerbotAI* ai = player ? PlayerbotsMgr::instance().GetPlayerbotAI(player) : nullptr;
            if (!player || !player->IsInWorld() || !ai)
            {
                RecordSystemEvent(guid, it->second.name, "logged out; pause ended");
                it = s_paused.erase(it);
                continue;
            }

            PositionMap& posMap = ai->GetAiObjectContext()->GetValue<PositionMap&>("position")->Get();
            PositionInfo stay = posMap["stay"];
            bool lostStay = !stay.isSet() || stay.mapId != player->GetMapId();
            std::vector<std::string> current = ai->GetStrategies(BOT_STATE_NON_COMBAT);

            if (NeedsStrip(current) || lostStay)
            {
                // Say what changed, so a real reset can be told from a stray strategy.
                std::string reason;
                for (std::string const& s : current)
                    if (!PAUSE_KEEP.count(s))
                        reason += (reason.empty() ? "strategies came back: " : ",") + s;
                if (std::find(current.begin(), current.end(), "stay") == current.end())
                    reason += (reason.empty() ? "" : "; ") + std::string("stay strategy removed");
                if (lostStay)
                    reason += (reason.empty() ? "" : "; ") + std::string(stay.isSet() ? "changed map" : "stay position cleared");

                // After a revive or teleport the bot freezes where it is now.
                if (lostStay)
                    ApplyPause(player, ai);
                else
                {
                    std::string change;
                    for (std::string const& s : current)
                        if (!PAUSE_KEEP.count(s))
                            change += "-" + s + ",";
                    change += "+stay";
                    ai->ChangeStrategy(change, BOT_STATE_NON_COMBAT);
                }
                RecordSystemEvent(guid, it->second.name, reason + "; pause re-applied");
            }
            ++it;
        }
    }

    // World thread.
    void DrainCommands()
    {
        if (!s_pending.load(std::memory_order_relaxed))
            return;

        std::deque<std::shared_ptr<Command>> batch;
        {
            std::lock_guard<std::mutex> lock(s_cmdLock);
            batch.swap(s_queue);
            s_pending = 0;
        }

        for (std::shared_ptr<Command>& command : batch)
        {
            json result;
            try
            {
                if (command->cmd == "pause")
                    result = DoPause(command->guid);
                else if (command->cmd == "resume")
                    result = DoResume(command->guid);
                else if (command->cmd == "setting")
                    result = DoSetting(command->key, command->value);
                else
                    result = Result(false, "Unknown command", 400);
            }
            catch (std::exception const& e)
            {
                result = Result(false, std::string("Command failed: ") + e.what(), 500);
            }

            result["id"] = command->id;
            LOG_INFO("module", "[Dashboard] command #{} {} {} from {} -> {}: {}", command->id, command->cmd,
                command->cmd == "setting" ? command->key : "guid=" + std::to_string(command->guid),
                command->from, result["ok"].get<bool>() ? "ok" : "refused", result["message"].get<std::string>());

            json entry = { { "id", command->id }, { "ts", static_cast<int64>(std::time(nullptr)) },
                           { "cmd", command->cmd }, { "guid", command->guid }, { "from", command->from },
                           { "ok", result["ok"] }, { "message", result["message"] } };
            if (command->cmd == "setting")
                entry["key"] = command->key;
            Remember(std::move(entry));
            command->result.set_value(std::move(result));
        }
    }

    // ---- Snapshot --------------------------------------------------------

    // Zone rectangles in world coordinates, from WorldMapArea.dbc. Continent
    // rows (area 0) are not indexed by the store, so the page fits each
    // continent to the union of its zones.
    std::string BuildWorldMap()
    {
        json zones = json::array();
        for (uint32 i = 0; i < sWorldMapAreaStore.GetNumRows(); ++i)
        {
            WorldMapAreaEntry const* wma = sWorldMapAreaStore.LookupEntry(i);
            if (!wma || !wma->area_id)
                continue;

            zones.push_back({
                { "zone", wma->area_id },
                { "map", wma->map_id },
                { "virtual_map", wma->virtual_map_id },
                { "name", AreaName(wma->area_id) },
                { "left", wma->y1 }, { "right", wma->y2 },
                { "top", wma->x1 }, { "bottom", wma->x2 }
            });
        }

        json maps = json::object();
        for (uint32 mapId : { 0u, 1u, 530u, 571u })
            maps[std::to_string(mapId)] = MapName(mapId);

        return Dump({ { "zones", zones }, { "continents", maps } });
    }

    std::string BuildSnapshot()
    {
        json players = json::array();
        uint32 bots = 0, real = 0, active = 0;

        for (auto const& [guid, player] : ObjectAccessor::GetPlayers())
        {
            if (!player || !player->IsInWorld())
                continue;

            PlayerbotAI* ai = PlayerbotsMgr::instance().GetPlayerbotAI(player);
            bool bot = IsBot(player, ai);
            bot ? ++bots : ++real;

            Map* map = player->GetMap();
            Group* group = player->GetGroup();

            json p = {
                { "guid", player->GetGUID().GetCounter() },
                { "name", player->GetName() },
                { "bot", bot },
                { "level", player->GetLevel() },
                { "class", player->getClass() },
                { "race", player->getRace() },
                { "team", player->GetTeamId() },
                { "map", player->GetMapId() },
                { "zone", player->GetZoneId() },
                { "zone_name", AreaName(player->GetZoneId()) },
                { "area", player->GetAreaId() },
                { "x", player->GetPositionX() },
                { "y", player->GetPositionY() },
                { "z", player->GetPositionZ() },
                { "instance", map && map->Instanceable() },
                { "map_name", MapName(player->GetMapId()) },
                { "combat", player->IsInCombat() },
                { "dead", !player->IsAlive() },
                { "mounted", player->IsMounted() },
                { "flight", player->IsInFlight() },
                { "group_leader", group ? group->GetLeaderGUID().GetCounter() : 0 }
            };

            if (ai && bot)
            {
                bool isActive = ai->IsActivityAllowedCached();
                active += isActive ? 1 : 0;

                Player* master = ai->GetMaster();
                p["active"] = isActive;
                p["rpg"] = static_cast<int>(ai->rpgInfo.GetStatus());
                p["master"] = master ? master->GetGUID().GetCounter() : 0;
                p["strategies"] = ai->GetStrategies(BOT_STATE_NON_COMBAT);
                p["combat_strategies"] = ai->GetStrategies(BOT_STATE_COMBAT);

                auto paused = s_paused.find(player->GetGUID().GetCounter());
                p["paused"] = paused != s_paused.end();
                if (paused != s_paused.end())
                {
                    p["paused_since"] = static_cast<int64>(paused->second.since);
                    p["saved_strategies"] = paused->second.saved;
                }
            }

            players.push_back(std::move(p));
        }

        json doc = {
            { "ts", static_cast<int64>(std::time(nullptr)) },
            { "update_ms", {
                { "avg", sWorldUpdateTime.GetAverageUpdateTime() },
                { "max", sWorldUpdateTime.GetMaxUpdateTime() },
                { "last", sWorldUpdateTime.GetLastUpdateTime() } } },
            { "counts", { { "bots", bots }, { "real", real }, { "active", active }, { "paused", s_paused.size() } } },
            { "players", players }
        };

        return Dump(doc);
    }

    // ---- HTTP ------------------------------------------------------------

    void ServeString(httplib::Response& res, std::shared_ptr<std::string const> const& body)
    {
        res.set_header("Cache-Control", "no-store");
        if (!body)
        {
            res.status = 503;
            res.set_content("{\"error\":\"snapshot not ready\"}", "application/json");
            return;
        }
        res.set_content(*body, "application/json");
    }

    void SendJson(httplib::Response& res, int status, json const& body)
    {
        res.status = status;
        res.set_header("Cache-Control", "no-store");
        res.set_content(Dump(body), "application/json");
    }

    // Constant-time compare so the token can't be guessed byte by byte.
    bool TokenMatches(std::string const& given)
    {
        std::string expected;
        {
            std::lock_guard<std::mutex> lock(s_dataLock);
            expected = s_token;
        }
        if (expected.empty() || given.size() != expected.size())
            return false;

        unsigned char diff = 0;
        for (size_t i = 0; i < given.size(); ++i)
            diff |= static_cast<unsigned char>(given[i] ^ expected[i]);
        return diff == 0;
    }

    // HTTP thread. The token rides in a custom header, so a cross-origin page
    // can't send it without a CORS preflight, which this server never answers.
    void HandleCommand(std::string const& cmd, httplib::Request const& req, httplib::Response& res)
    {
        bool configured;
        {
            std::lock_guard<std::mutex> lock(s_dataLock);
            configured = !s_token.empty();
        }
        if (!configured)
            return SendJson(res, 403, Result(false, "Commands are off: Dashboard.CommandToken is empty", 403));

        if (!TokenMatches(req.get_header_value("X-Dashboard-Token")))
        {
            LOG_WARN("module", "[Dashboard] rejected {} from {}: bad or missing token", cmd, req.remote_addr);
            return SendJson(res, 401, Result(false, "Missing or wrong token", 401));
        }

        json body = json::parse(req.body, nullptr, false);
        if (body.is_discarded() || !body.is_object() || !body.contains("guid") || !body["guid"].is_number_unsigned())
            return SendJson(res, 400, Result(false, "Body must be JSON like {\"guid\": 123}", 400));

        auto command = std::make_shared<Command>();
        command->id = s_nextId++;
        command->cmd = cmd;
        command->guid = body["guid"].get<uint32>();
        command->from = req.remote_addr;
        std::future<json> future = command->result.get_future();

        {
            std::lock_guard<std::mutex> lock(s_cmdLock);
            if (s_queue.size() >= QUEUE_LIMIT)
                return SendJson(res, 429, Result(false, "Command queue is full; try again", 429));
            s_queue.push_back(command);
            s_pending = s_queue.size();
        }

        // A world tick is ~10-50 ms; a long wait means the world thread is stuck
        // or shutting down. The command still runs if it gets there later.
        if (future.wait_for(std::chrono::seconds(4)) != std::future_status::ready)
            return SendJson(res, 504, { { "ok", false }, { "id", command->id },
                { "message", "Queued, but the world thread did not answer within 4 s; check /commands" } });

        json result = future.get();
        int status = result.value("status", 200);
        SendJson(res, status, result);
    }

    // HTTP thread. Same token rule as the bot commands; the key must be one the
    // page was given, and the value one line with no double quote (the core's
    // parser strips every '"', so one could never be read back as written).
    void HandleSetting(httplib::Request const& req, httplib::Response& res)
    {
        std::vector<std::string> keys;
        bool configured;
        {
            std::lock_guard<std::mutex> lock(s_dataLock);
            configured = !s_token.empty();
            keys = s_settingKeys;
        }
        if (!configured)
            return SendJson(res, 403, Result(false, "Commands are off: Dashboard.CommandToken is empty", 403));
        if (!TokenMatches(req.get_header_value("X-Dashboard-Token")))
        {
            LOG_WARN("module", "[Dashboard] rejected setting from {}: bad or missing token", req.remote_addr);
            return SendJson(res, 401, Result(false, "Missing or wrong token", 401));
        }

        json body = json::parse(req.body, nullptr, false);
        if (body.is_discarded() || !body.is_object() || !body.contains("key") || !body["key"].is_string() ||
            !body.contains("value") || !(body["value"].is_string() || body["value"].is_number() || body["value"].is_boolean()))
            return SendJson(res, 400, Result(false, "Body must be JSON like {\"key\": \"Some.Key\", \"value\": \"1\"}", 400));

        std::string key = body["key"].get<std::string>();
        if (std::find(keys.begin(), keys.end(), key) == keys.end())
            return SendJson(res, 403, Result(false, key + " is not in Dashboard.Settings.Keys", 403));

        std::string value = body["value"].is_string() ? body["value"].get<std::string>()
                          : body["value"].is_boolean() ? (body["value"].get<bool>() ? "1" : "0")
                          : body["value"].dump();
        if (!DashboardSettings::ValidValue(value))
            return SendJson(res, 400, Result(false, "The value must be one line, without double quotes", 400));

        auto command = std::make_shared<Command>();
        command->id = s_nextId++;
        command->cmd = "setting";
        command->key = std::move(key);
        command->value = std::move(value);
        command->from = req.remote_addr;
        std::future<json> future = command->result.get_future();

        {
            std::lock_guard<std::mutex> lock(s_cmdLock);
            if (s_queue.size() >= QUEUE_LIMIT)
                return SendJson(res, 429, Result(false, "Command queue is full; try again", 429));
            s_queue.push_back(command);
            s_pending = s_queue.size();
        }

        if (future.wait_for(std::chrono::seconds(4)) != std::future_status::ready)
            return SendJson(res, 504, { { "ok", false }, { "id", command->id },
                { "message", "Queued, but the world thread did not answer within 4 s; check /commands" } });

        json result = future.get();
        SendJson(res, result.value("status", 200), result);
    }

    void StartListeners()
    {
        std::string bind = sConfigMgr->GetOption<std::string>("Dashboard.Bind", "127.0.0.1");
        int port = sConfigMgr->GetOption<int32>("Dashboard.Port", 8787);
        // Defaults must name no particular machine (plan 23 W11). The page ships inside this module,
        // so it is found from the core's source directory; the two generated-data roots sit under the
        // server's DataDir. Both stay overridable for a split install.
        std::string dataDir = sConfigMgr->GetOption<std::string>("DataDir", ".");
        std::string webRoot = sConfigMgr->GetOption<std::string>("Dashboard.WebRoot",
            BuiltInConfig::GetSourceDirectory() + "/modules/mod-dashboard/web");
        std::string mapRoot = sConfigMgr->GetOption<std::string>("Dashboard.MapRoot",
            dataDir + "/dashboard-maps");
        std::string dataRoot = sConfigMgr->GetOption<std::string>("Dashboard.DataRoot",
            dataDir + "/dashboard-data");

        std::stringstream ss(bind);
        std::string host;
        while (std::getline(ss, host, ','))
        {
            host.erase(0, host.find_first_not_of(" \t"));
            host.erase(host.find_last_not_of(" \t") + 1);
            if (host.empty())
                continue;

            auto server = std::make_unique<httplib::Server>();
            server->set_read_timeout(5, 0);
            server->set_write_timeout(5, 0);
            server->set_payload_max_length(4096);   // a setting's value can be a prompt line

            server->Get("/bots", [](httplib::Request const&, httplib::Response& res) { ServeString(res, Load(s_bots)); });
            server->Get("/worldmap", [](httplib::Request const&, httplib::Response& res) { ServeString(res, Load(s_worldmap)); });
            server->Get("/health", [](httplib::Request const&, httplib::Response& res)
            {
                res.set_content(Load(s_bots) ? "{\"ok\":true}" : "{\"ok\":false}", "application/json");
            });
            server->Get("/commands", [](httplib::Request const&, httplib::Response& res)
            {
                json list = json::array();
                bool enabled;
                {
                    std::lock_guard<std::mutex> lock(s_dataLock);
                    for (json const& entry : s_history)
                        list.push_back(entry);
                    enabled = !s_token.empty();
                }
                SendJson(res, 200, { { "enabled", enabled }, { "recent", list } });
            });
            server->Post("/cmd/pause", [](httplib::Request const& req, httplib::Response& res) { HandleCommand("pause", req, res); });
            server->Post("/cmd/resume", [](httplib::Request const& req, httplib::Response& res) { HandleCommand("resume", req, res); });
            server->Get("/settings", [](httplib::Request const&, httplib::Response& res) { ServeString(res, Load(s_settings)); });
            server->Post("/cmd/setting", [](httplib::Request const& req, httplib::Response& res) { HandleSetting(req, res); });

            // Blizzard-derived map images live outside the module source so they
            // can never be committed with it.
            if (std::filesystem::is_directory(mapRoot))
                server->set_mount_point("/maps", mapRoot);
            else
                LOG_INFO("module", "[Dashboard] MapRoot {} not found; the page falls back to zone outlines", mapRoot);

            // Files written by services outside the worldserver (regard.py's regard.json).
            // Mounted before "/", which would otherwise answer first.
            if (std::filesystem::is_directory(dataRoot))
                server->set_mount_point("/data", dataRoot);
            else
                LOG_INFO("module", "[Dashboard] DataRoot {} not found; the feelings panel stays empty", dataRoot);

            if (std::filesystem::is_directory(webRoot))
                server->set_mount_point("/", webRoot);
            else
                LOG_ERROR("module", "[Dashboard] WebRoot {} is not a directory; only JSON endpoints are served", webRoot);

            if (!server->bind_to_port(host, port))
            {
                LOG_ERROR("module", "[Dashboard] Could not bind {}:{}; that address is skipped", host, port);
                continue;
            }

            LOG_INFO("module", "[Dashboard] Listening on http://{}:{}/", host, port);
            httplib::Server* raw = server.get();
            Listeners().push_back({ std::move(server), std::thread([raw] { raw->listen_after_bind(); }) });
        }
    }
}

class DashboardWorldScript : public WorldScript
{
public:
    DashboardWorldScript() : WorldScript("DashboardWorldScript", {
        WORLDHOOK_ON_AFTER_CONFIG_LOAD,
        WORLDHOOK_ON_STARTUP,
        WORLDHOOK_ON_UPDATE,
        WORLDHOOK_ON_SHUTDOWN
    }) { }

    void OnAfterConfigLoad(bool /*reload*/) override
    {
        s_enable = sConfigMgr->GetOption<bool>("Dashboard.Enable", true);
        s_intervalMs = std::max<uint32>(500, sConfigMgr->GetOption<uint32>("Dashboard.SnapshotIntervalMs", 2000));
        s_pauseHoldSec = std::max<uint32>(600, sConfigMgr->GetOption<uint32>("Dashboard.PauseTeleportHoldSec", 86400));

        std::string token = sConfigMgr->GetOption<std::string>("Dashboard.CommandToken", "");
        if (!token.empty() && token.size() < 16)
        {
            LOG_ERROR("module", "[Dashboard] CommandToken is shorter than 16 characters; commands stay off");
            token.clear();
        }

        std::vector<std::string> keys;
        std::unordered_map<std::string, SettingTarget> targets;
        std::set<std::string> ambiguous;
        auto words = [](std::string const& text)
        {
            std::vector<std::string> result;
            std::stringstream stream(text);
            for (std::string word; std::getline(stream, word, ','); )
            {
                word.erase(0, word.find_first_not_of(" \t"));
                word.erase(word.find_last_not_of(" \t") + 1);
                if (!word.empty() && std::find(result.begin(), result.end(), word) == result.end())
                    result.push_back(std::move(word));
            }
            return result;
        };
        auto addGroup = [&](std::string const& prefix)
        {
            std::string file = sConfigMgr->GetOption<std::string>(prefix + ".File", "");
            if (!file.empty() && std::filesystem::path(file).is_relative())
                file = (std::filesystem::path(sConfigMgr->GetConfigPath()) / file).string();
            std::string reload = sConfigMgr->GetOption<std::string>(prefix + ".ReloadCommand", "");
            for (std::string const& key : words(sConfigMgr->GetOption<std::string>(prefix + ".Keys", "")))
            {
                if (!targets.emplace(key, SettingTarget{ file, reload }).second)
                    ambiguous.insert(key);
            }
        };
        addGroup("Dashboard.Settings"); // Single-file configuration remains supported.
        for (std::string const& group : words(sConfigMgr->GetOption<std::string>("Dashboard.Settings.Groups", "")))
        {
            if (!std::all_of(group.begin(), group.end(), [](unsigned char c) { return std::isalnum(c) || c == '_'; }))
            {
                LOG_ERROR("module", "[Dashboard] Invalid settings group '{}'", group);
                continue;
            }
            addGroup("Dashboard.Settings." + group);
        }
        for (std::string const& key : ambiguous)
        {
            targets.erase(key);
            LOG_ERROR("module", "[Dashboard] Setting '{}' belongs to multiple groups; excluded", key);
        }
        for (auto const& [key, target] : targets)
            keys.push_back(key);
        s_settingTargets = std::move(targets);

        std::lock_guard<std::mutex> lock(s_dataLock);
        s_token = std::move(token);
        s_settingKeys = std::move(keys);
    }

    void OnStartup() override
    {
        if (!s_enable)
            return;

        try
        {
            Store(s_worldmap, BuildWorldMap());
            StartListeners();
        }
        catch (std::exception const& e)
        {
            LOG_ERROR("module", "[Dashboard] Startup failed: {}", e.what());
        }
    }

    void OnUpdate(uint32 diff) override
    {
        if (!s_enable || Listeners().empty())
            return;

        DrainCommands();

        s_elapsedMs += diff;
        if (s_elapsedMs < s_intervalMs)
            return;
        s_elapsedMs = 0;

        try
        {
            MaintainPauses();
            Store(s_bots, BuildSnapshot());
            // Rebuilt every interval: a reload run from the console or another
            // module changes these values without telling this one.
            Store(s_settings, BuildSettings());
        }
        catch (std::exception const& e)
        {
            LOG_ERROR("module", "[Dashboard] Snapshot failed: {}", e.what());
        }
    }

    void OnShutdown() override
    {
        for (Listener& listener : Listeners())
        {
            listener.server->stop();
            if (listener.thread.joinable())
                listener.thread.join();
        }
        Listeners().clear();
    }
};

void Addmod_dashboardScripts()
{
    new DashboardWorldScript();
}
