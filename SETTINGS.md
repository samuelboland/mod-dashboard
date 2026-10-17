# Settings panel

The optional Settings panel reads and changes an explicit allowlist of config
keys. It works in both the worldserver-hosted and standalone dashboard. The
realm must be running to read live settings or save changes. No settings are
exposed by default.

Configure `Dashboard.CommandToken` (at least 16 characters) and enter that token
in the dashboard's Commands panel. Keep tokens and model API keys out of the
settings allowlist. C++ rejects `Dashboard.*` keys and names containing `Token`,
`Password`, `Secret`, `ApiKey` or `DatabaseInfo` (which holds a database
password), case-insensitively, before publishing values or
accepting writes. A group with no file is read-only.

For chat and playerbot settings in separate files:

```ini
Dashboard.Settings.Groups = chat,playerbots
Dashboard.Settings.chat.Keys = OllamaChat.Conversation.Enable,OllamaChat.Conversation.HoldSeconds,OllamaChat.Conversation.MaxDistance,OllamaChat.Conversation.HoldStill,OllamaChat.Delivery.Split,OllamaChat.Delivery.MaxMessages,OllamaChat.BlacklistMastersOnly
Dashboard.Settings.chat.Types = OllamaChat.Conversation.Enable:bool,OllamaChat.Conversation.HoldSeconds:int:10:3600,OllamaChat.Conversation.MaxDistance:number:5:100,OllamaChat.Conversation.HoldStill:bool,OllamaChat.Delivery.Split:bool,OllamaChat.Delivery.MaxMessages:int:0:4294967295,OllamaChat.BlacklistMastersOnly:bool
Dashboard.Settings.chat.File = modules/mod_ollama_chat.conf
Dashboard.Settings.chat.ReloadCommand = ollama reload
Dashboard.Settings.playerbots.Keys = AiPlayerbot.PersistentProgression,AiPlayerbot.PersistentProgression.AnchorOnMeeting,AiPlayerbot.PersistentProgression.FollowGap,AiPlayerbot.PersistentProgression.AnchorInterval,AiPlayerbot.LevelBrackets.Enabled,AiPlayerbot.ResetBotLevel.Enabled
Dashboard.Settings.playerbots.Types = AiPlayerbot.PersistentProgression:int:0:2,AiPlayerbot.PersistentProgression.AnchorOnMeeting:bool,AiPlayerbot.PersistentProgression.FollowGap:int:0:80,AiPlayerbot.PersistentProgression.AnchorInterval:int:30:4294967295,AiPlayerbot.LevelBrackets.Enabled:bool,AiPlayerbot.ResetBotLevel.Enabled:bool
Dashboard.Settings.playerbots.File = modules/playerbots.conf
Dashboard.Settings.playerbots.ReloadCommand = reload config
```

In Headless DM, `OllamaChat.Reply.Model` (type `text`) names a router route
(`ambient`, `quality`, `chronicle`, `prose`, `utility` or `moment`), not a model;
see [MODELS.md](MODELS.md) for the panel that shows and orders those routes.

Use actual installed config paths, relative to the worldserver config directory
or absolute. These feature keys require the corresponding conversation and
persistence module changes. The conversation change also makes `ollama reload`
preserve unsaved conversation history, which is required for safe chat setting
changes during play. The dashboard does not implement those features.

Each group uses `Dashboard.Settings.<name>.Keys`, `.File` and `.ReloadCommand`.
Optional `.Types` is a comma-separated list of `Key:type[:min[:max]]`. Types are
`bool`, `int` (whole numbers within ±9007199254740991), `number` (finite decimals),
and `text`. The integer limit keeps bounds and browser values exact. Numeric bounds are optional;
an empty bound is omitted. Malformed or duplicate rules exclude their key with a
log error. C++ validates the rule again on the world thread before any file write
or reload command. The API publishes explicit types and bounds so the panel
uses the same controls and limits.

Without a type rule, the server requires a value compatible with the current
active value: boolean words, whole numbers, finite decimals, or text. Numeric
`0` and `1` are inferred as integers because they may be modes, not switches.
Use explicit rules for booleans and numeric ranges, as in the examples above.

Names contain letters, digits or underscores. A key assigned to multiple groups
is excluded with a log error. The single-file `Dashboard.Settings.Keys`, `.File`
and `.ReloadCommand` form also remains supported.

Saving updates all active assignments of a key, or appends it if absent. Comments,
UTF-8 BOM and line-ending style are preserved. The writer requires an existing
regular file, retains `<file>.dashboard.bak`, and atomically replaces the file.
A failed backup leaves the original untouched. The HTTP caller cannot choose a
file or reload command. Values must be at most 2000 UTF-8 bytes with no quotes
or control characters. The panel warns that
regenerating config files can overwrite dashboard edits; record changes in any
external config generator too.

The response confirms the file save and that a reload command was queued; it
does not confirm the command succeeded. The panel distinguishes saved values
from active ConfigMgr values until the reload completes. A blank reload command
leaves the change waiting for a manual reload or restart. Check server logs if a
queued reload fails. A timeout means delivery is unconfirmed; check Settings and
command history before retrying.

`AiPlayerbot.PersistentProgression` is an upstream three-mode setting: `0` is off,
`1` protects all random bots after provisioning, and `2` protects only bots in
`playerbots_bot_anchor`. Protected bots are exempt from level rebalancing and
resets. Unprotected bots retain configured maintenance. Their switches display
configured values even when persistence overrides them. Bots can still log out
or teleport; persistence does not fix online population membership.

Upstream encounter tracking provides
`AiPlayerbot.PersistentProgression.AnchorOnMeeting`. With it enabled in mode `1`
or `2`, new human whispers, `/say` with a selected bot in hearing range, actual
party/raid membership (including LFG), completed trades and targeted friendly
emotes anchor the bot to the first human. Existing anchors are never replaced.
Use mode `2` for met bots only. See the playerbot config for qualifying emotes;
there is no history backfill. Protection survives logout, disband and restart.
The dashboard alone does not record encounters: expose this key only with that
module update installed.

Leave `AiPlayerbot.PersistentProgression.FollowGap = 0` for ordinary earned
leveling. A positive gap enables upstream level catch-up against the anchor
character in mode `2`. `AnchorInterval` controls periodic anchor-table refresh
and catch-up checks; newly recorded encounters take effect immediately. These
settings do not enable level rebalancing or resets.

API: `GET /settings` returns `enabled`, `writable` and `settings`. Each entry
contains `key`, active `value`, `writable`, `file` (basename), `reload`, and an
optional pending `saved` value. An explicit type rule adds `kind` and optional
`min`/`max`. `POST /cmd/setting` accepts `{ "key": "...",
"value": "..." }` and requires `X-Dashboard-Token`. Both endpoints are explicitly
proxied by the standalone host; the worldserver owns the allowlist and writes.

Checks: run `npm ci && npm run check` in `standalone`, then
`python tests/standalone_browser.py` from the module root. The browser test uses a
fake realm and makes no model requests. Compile the pure writer test with
`g++ -std=c++17 -Wall -Wextra -Isrc tests/settings_file_test.cpp src/mod_dashboard_settings.cpp -o /tmp/settings_file_test`
and run `/tmp/settings_file_test`. MSVC with `/std:c++17 /EHsc /utf-8` also works.
