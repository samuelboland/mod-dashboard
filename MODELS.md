# Models panel

The optional Models panel shows which language model each part of a Headless DM realm uses, and changes two
things: the model name a backend is told, and the order of a route's backends. It does not exist in a realm
that has not turned it on. It needs the Headless DM Python services; nothing in the worldserver module is
involved, and the C++ dashboard never sees these requests.

## Off by default

The panel's button is hidden unless the lore gate has published `"model_settings": true` in
`data/lore-edit.json`, which it does only when `MODEL_SETTINGS_ENABLED=1` is set in `site/site.env` and the gate
has been restarted. A gate with it off answers `GET /models` with `{"ok": true, "enabled": false}` and refuses
`POST /models-set` with 403. Without the lore gate the page shows no Models button.

## Where it talks

To the lore gate, directly from the browser, at `<dashboard host>:8788`, with the gate's own token in
`X-Lore-Token` (the token the Lore panel keeps in this browser as `dash.loreToken`). It does not use the
dashboard's command token, `/settings` or the worldserver. The reason is the Lore panel's: mod-dashboard caps a
request body at 1024 bytes, answers no CORS preflight and drains commands on the world thread. The gate's
`LORE_GATE_ORIGIN` must allow the dashboard's origin, as for the Lore panel.

## API (lore gate)

```
GET  /models        {"ok": true, "enabled": true, "fleet": {...}}
POST /models-set    {"models": {"<backend>": "<model>" | null},
                     "routes": {"<route>": ["<backend>", ...] | null},
                     "revision": <number the page last saw>}
```

`null` puts `fleet.toml`'s own value back. `revision` is optional; when given and out of date the answer is 409
with the current `fleet`. Anything else in the body, such as an address, a key or a new backend, is refused with
400. A route must list one to sixteen backends that `fleet.toml` defines, each once, with at least one whose API
key is set. A model name is `[A-Za-z0-9][A-Za-z0-9._:/@+=~-]{0,199}`. The body is at most 16 KiB.

`fleet` holds `backends` (name, model, `default_model`, `changed`, `key` as `set`, `missing` or `not needed`,
`key_name`, `usable`, `used_by`), `routes` (name, `chain`, `default_chain`, `changed`, `skipped`), `batch` and
`judge` (read-only), `revision`, `saved_at`, `problem`, and `router`, whose `state` is `live`, `waiting`, `error`,
`down` or `old`. A key's value is never in any of it. `GET` and `POST` are not ended by the gate's `PAUSE` file.

## What is saved

`site/fleet.override.json`, written whole and renamed into place, laid over `fleet.toml` by
`services/common/fleet_config.py`:

```json
{"version": 1, "revision": 3, "saved_at": "2026-10-17T12:45:22Z",
 "models": {"local": "qwen3-32b"}, "routes": {"ambient": ["spare", "local"]}}
```

The router follows it, and `fleet.toml`, within a few seconds; see `docs/WHATS-NEW.md` section 10 in Headless DM
for what each change needs (the judge's model is read once at start by regard, the chronicler and the Dungeon
Master).

## Checks

From the Headless DM repository root: `python3 -m unittest discover -s tests/fleet`. From this module root:
`node --test tests/models.test.mjs` (also part of `npm run check` in `standalone`).

`OllamaChat.Reply.Model`, in the Settings panel (`SETTINGS.md`), names a router route in Headless DM:
`ambient`, `quality`, `chronicle`, `prose`, `utility` or `moment`.
