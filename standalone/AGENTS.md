# Standalone dashboard host

- Preserve the existing UI and worldserver-hosted mode. Keep this host optional.
- `src/config.ts` validates configuration. `contracts.ts` defines the live wire
  schemas and has no I/O imports. `worldserver.ts` owns upstream HTTP access;
  `files.ts` owns public file access. Routes compose these adapters.
- Do not add database writers or migrations here. Accounting and social services
  retain ownership. Only their explicitly published files may be served.
- Never proxy arbitrary paths or forward browser headers wholesale. Commands
  carry only the supplied command token, never follow redirects, and never retry.
  A timeout is unconfirmed delivery, not proof that the command did not run.
- Validate unknown inputs at boundaries. Do not use `any`, non-null assertions,
  or type assertions to bypass checks. Explain any narrowly necessary exception.
- Keep `strict`, indexed-access checks, and exact optional property checks on.
- Run `npm ci` and `npm run check` here. After connection/UI changes, also run
  `python tests/standalone_browser.py` from the module root with Selenium/Edge.
- Keep private data, credentials, screenshots and experiment artifacts out of
  this repository. Tests use temporary files and a local fake realm.
