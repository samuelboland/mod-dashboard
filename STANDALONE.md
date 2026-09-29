# Standalone dashboard

The optional Node host serves the existing Living Azeroth UI while the realm is
stopped. It reads published JSON and map files from disk and forwards the small
live API to mod-dashboard. It does not open databases, run generators, or start
and stop the realm. The C++ module and its existing hosting mode still work.

## Run

Requires Node 22.13+ (or Node 24+) and npm. From `standalone/`:

```sh
npm ci
npm run check
DASHBOARD_DATA_ROOT=/opt/wow/server/data/dashboard-data \
DASHBOARD_MAP_ROOT=/opt/wow/server/data/dashboard-maps \
npm start
```

On PowerShell, set variables before `npm start`:

```powershell
$env:DASHBOARD_DATA_ROOT = 'D:\path\to\dashboard-data'
$env:DASHBOARD_MAP_ROOT = 'D:\path\to\dashboard-maps'
npm start
```

Open `http://127.0.0.1:8790/` (or `/#costs`). The host reads existing published
files; the accounting exporter must still run to produce fresh cost snapshots.
Use the same public roots configured in `Dashboard.DataRoot`/`Dashboard.MapRoot`.
Do not point these settings at private ledgers or service state directories.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DASHBOARD_HOST` | `127.0.0.1` | Listen address, or a comma-separated list like `Dashboard.Bind` |
| `DASHBOARD_PORT` | `8790` | Standalone port, separate from the realm |
| `DASHBOARD_WORLD_URL` | `http://127.0.0.1:8787` | Worldserver HTTP origin, no path or credentials |
| `DASHBOARD_TIMEOUT_MS` | `6000` | Upstream deadline, including response body |
| `DASHBOARD_WEB_ROOT` | Module's `web/` | Existing frontend assets |
| `DASHBOARD_DATA_ROOT` | Unset | Published JSON root; absent files return 404 |
| `DASHBOARD_MAP_ROOT` | Unset | Map art root; absent art uses existing fallback |

Command tokens stay in the browser and are verified by the worldserver. Nothing
in this host stores them. A different port is a different browser origin, so
existing browser preferences and tokens are not automatically transferred.
Only pause/resume are forwarded, once per request. Unconfirmed delivery must be
checked in command history before a user retries. Cross-origin command requests
are rejected; no CORS access is added.

Like the original dashboard, read access is not authenticated. Keep the listener
on loopback or behind your existing authenticated private access. The host does
not trust forwarded headers. Command requests require a matching browser origin
and host/protocol; TLS-terminating reverse proxies need additional explicit origin
configuration before they can support commands in a future change.
The lore editor still talks directly to its separate port 8788 service and uses
that service's own token/CORS policy. This PR does not change it; allow the new
dashboard origin there if your lore-gate installation restricts origins.

## Offline behavior

- Published costs, lore, memories and other files remain readable. They describe
  the last export, not necessarily the present world.
- Live snapshots return an error while the realm is unavailable. The browser
  retains its last snapshot, labels it disconnected with its age, and disables
  pause/resume. On a fresh offline page, the roster says no live data was received.
- A bot snapshot that has not changed for 30 seconds (by the browser's own clock,
  so a viewer's clock skew does not matter) is treated as disconnected even if the
  HTTP endpoint still responds; commands are disabled until fresh data returns.
- Polling reconnects automatically, including retrying map geometry after a cold
  offline start. No synthetic zero-player snapshot is produced.
- `/host-health` reports this process's health. `/health` still reports the realm.
- The existing CDN-hosted fonts and Leaflet remain external dependencies. Realm
  offline support does not make these assets available without internet access.

## File and API boundaries

The host serves only `index.html`, JS/CSS assets, map art/manifest, and the JSON
JSON documents and `.mp3`/`.wav` voice lines under the data root (see `src/files.ts`),
so files added by later features need no list kept in step. Character detail paths accept numeric
IDs. Dot paths, directory listing, private database files, and symlinks escaping
the selected root are refused. Configure trusted, dedicated public directories.
JSON files must parse; their existing per-feature UI contracts remain unchanged.
Live responses are runtime-validated using schemas derived from the C++ API.
Responses and requests are bounded, and redirects are never followed.

## Service and Docker

The user-unit template `standalone/living-azeroth.service.in` follows Headless DM's
user-service convention. Replace `@MODULE@`, `@CONFIG@` and `@NODE@` with absolute
paths, put the unit in `~/.config/systemd/user/living-azeroth.service`, and put the
settings above in the config file as `KEY=value` lines. Run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now living-azeroth
```

There is deliberately no worldserver dependency. The service user needs read
access to the module and published roots. Stop/disable the unit to remove the
standalone host; the original worldserver dashboard remains available.

Alternatively, build from the module root:

```sh
docker build -f standalone/Dockerfile -t living-azeroth-host .
docker run --rm -p 127.0.0.1:8790:8790 \
  --mount type=bind,src=/absolute/dashboard-data,dst=/data,readonly \
  -e DASHBOARD_DATA_ROOT=/data \
  -e DASHBOARD_WORLD_URL=http://worldserver:8787 \
  --network YOUR_REALM_NETWORK living-azeroth-host
```

Set the upstream to an address reachable from that container. On Docker Desktop,
`http://host.docker.internal:8787` can reach the existing host-published port.

## Development and verification

`npm run check` runs strict TypeScript, type-aware ESLint, local HTTP/file/command
tests, frontend state tests, and the production build. Dependencies are pinned
in the lockfile. The host is organized into configuration, contracts, adapters,
and route composition; the frontend remains native JavaScript and CSS.
The GitHub workflow runs this check on Windows and Linux with Node 22 and 24.

From the module root, with Selenium and Edge installed:

```sh
python tests/standalone_browser.py
python tests/accounting_browser.py --browser edge
```

The standalone test launches the real built host, a controllable local realm,
and the full UI. It checks cold offline costs/lore, reconnect, map retry, snapshot
age, disabled commands, and offline reload. No model calls or real game commands
are made. Optional `--artifacts /outside/the/repository` saves screenshots.
