# Settings panel

The optional Settings panel reads and changes an explicit allowlist of config
keys. It works in both the worldserver-hosted and standalone dashboard. The
realm must be running to read live settings or save changes. No settings are
exposed by default.

Configure `Dashboard.CommandToken` (at least 16 characters) and enter that token
in the dashboard's Commands panel. Keep tokens and model API keys out of the
settings allowlist. A group with no file is read-only.

For chat and playerbot settings in separate files:

```ini
Dashboard.Settings.Groups = chat,playerbots
Dashboard.Settings.chat.Keys = OllamaChat.Conversation.Enable,OllamaChat.Conversation.HoldSeconds,OllamaChat.Conversation.MaxDistance,OllamaChat.Conversation.HoldStill,OllamaChat.Delivery.Split,OllamaChat.Delivery.MaxMessages,OllamaChat.BlacklistMastersOnly
Dashboard.Settings.chat.File = modules/mod_ollama_chat.conf
Dashboard.Settings.chat.ReloadCommand = ollama reload
Dashboard.Settings.playerbots.Keys = AiPlayerbot.PersistentProgression,AiPlayerbot.LevelBrackets.Enabled,AiPlayerbot.ResetBotLevel.Enabled
Dashboard.Settings.playerbots.File = modules/playerbots.conf
Dashboard.Settings.playerbots.ReloadCommand = reload config
```

Use actual installed config paths, relative to the worldserver config directory
or absolute. These feature keys require the corresponding conversation and
persistence module changes. The conversation change also makes `ollama reload`
preserve unsaved conversation history, which is required for safe chat setting
changes during play. The dashboard does not implement those features.

Each group uses `Dashboard.Settings.<name>.Keys`, `.File` and `.ReloadCommand`.
Names contain letters, digits or underscores. A key assigned to multiple groups
is excluded with a log error. The single-file `Dashboard.Settings.Keys`, `.File`
and `.ReloadCommand` form also remains supported.

Saving updates all active assignments of a key, or appends it if absent. Comments,
UTF-8 BOM and line-ending style are preserved. The writer requires an existing
regular file, retains `<file>.dashboard.bak`, and atomically replaces the file.
A failed backup leaves the original untouched. The HTTP caller cannot choose a
file or reload command. Values must be at most 2000 characters with no quotes
or control characters. Record changes in any external config generator too.

The response confirms the file save and that a reload command was queued; it
does not confirm the command succeeded. The panel distinguishes saved values
from active ConfigMgr values until the reload completes. A blank reload command
leaves the change waiting for a manual reload or restart. Check server logs if a
queued reload fails. A timeout means delivery is unconfirmed; check Settings and
command history before retrying.

Persistent progression overrides level rebalancing and level resets in the
playerbot module. Their switches display configured values, even while that
override is active. Bots can still log out or teleport; the switch preserves
progression rather than fixing online population membership.

API: `GET /settings` returns `enabled`, `writable` and `settings`. Each entry
contains `key`, active `value`, `writable`, `file` (basename), `reload`, and an
optional pending `saved` value. `POST /cmd/setting` accepts `{ "key": "...",
"value": "..." }` and requires `X-Dashboard-Token`. Both endpoints are explicitly
proxied by the standalone host; the worldserver owns the allowlist and writes.

Checks: run `npm ci && npm run check` in `standalone`, then
`python tests/standalone_browser.py` from the module root. The browser test uses a
fake realm and makes no model requests. Compile the pure writer test with
`g++ -std=c++17 -Wall -Wextra -Isrc tests/settings_file_test.cpp src/mod_dashboard_settings.cpp -o /tmp/settings_file_test`
and run `/tmp/settings_file_test`. MSVC with `/std:c++17 /EHsc /utf-8` also works.
