import { access } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "./config.js";
import { createServer } from "./server.js";

const config = readConfig(process.env);
await access(join(config.webRoot, "index.html"));
// One listener per address; each is a complete host, so a failure on one address stops the process.
const apps = config.hosts.map(() => createServer(config));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void Promise.all(apps.map(app => app.close())).catch(() => { process.exitCode = 1; });
  });
}
for (const [i, app] of apps.entries()) {
  console.log(`Living Azeroth dashboard: ${await app.listen({ host: config.hosts[i] ?? "", port: config.port })}`);
}
