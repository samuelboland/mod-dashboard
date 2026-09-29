import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { readConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const snapshot = {
  ts: 1790500000, players: [], counts: { bots: 0, real: 0, active: 0, paused: 0 },
  update_ms: { avg: 1, max: 2, last: 1 },
};

await test("configuration rejects invalid settings and self-proxy addresses", () => {
  for (const env of [
    { DASHBOARD_PORT: "oops" }, { DASHBOARD_TIMEOUT_MS: "0" },
    { DASHBOARD_WORLD_URL: "file:///private" },
    { DASHBOARD_WORLD_URL: "http://user:password@localhost:8787" },
    { DASHBOARD_WORLD_URL: "http://localhost:8787/secret" },
    { DASHBOARD_WORLD_URL: "http://127.0.0.1:8790" },
  ]) assert.throws(() => readConfig(env));
  assert.deepEqual(readConfig({}).hosts, ["127.0.0.1"]);
  assert.deepEqual(readConfig({ DASHBOARD_HOST: "127.0.0.1, 100.64.0.1,127.0.0.1" }).hosts, ["127.0.0.1", "100.64.0.1"]);
  assert.throws(() => readConfig({ DASHBOARD_HOST: " , " }));
  assert.throws(() => readConfig({ DASHBOARD_HOST: "100.64.0.1,127.0.0.1", DASHBOARD_WORLD_URL: "http://127.0.0.1:8790" }));
});

await test("serves only published files, including with the realm unavailable", async t => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-test-"));
  const web = join(root, "web"), data = join(root, "data"), maps = join(root, "maps");
  await Promise.all([mkdir(web), mkdir(data), mkdir(maps)]);
  await mkdir(join(data, "ties"));
  await Promise.all([
    writeFile(join(web, "index.html"), "<title>Living Azeroth</title>"),
    writeFile(join(data, "accounting.json"), '{"available":true}'),
    writeFile(join(data, "ties", "18.json"), '{"feels":[]}'),
    writeFile(join(data, "rumours.json"), '{"rumours":[]}'),
    mkdir(join(data, "voices", "lines"), { recursive: true }).then(() => Promise.all([
      writeFile(join(data, "voices", "index.json"), '{"lines":{}}'),
      writeFile(join(data, "voices", "lines", "ab12.mp3"), "ID3"),
      writeFile(join(data, "voices", "export.zip"), "PRIVATE"),
    ])),
    writeFile(join(data, "secrets.env"), "PRIVATE"),
    writeFile(join(data, "requests.sqlite"), "PRIVATE"),
    writeFile(join(root, "private.json"), '"PRIVATE"'),
    writeFile(join(maps, "manifest.json"), "[]"),
  ]);
  const dead = Fastify();
  const address = await dead.listen({ host: "127.0.0.1", port: 0 });
  await dead.close();
  const app = createServer(readConfig({ DASHBOARD_WEB_ROOT: web, DASHBOARD_DATA_ROOT: data,
    DASHBOARD_MAP_ROOT: maps, DASHBOARD_WORLD_URL: address, DASHBOARD_TIMEOUT_MS: "100" }));
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await app.inject("/")).statusCode, 200);
  assert.equal((await app.inject("/data/accounting.json")).body, '{"available":true}');
  assert.equal((await app.inject("/data/ties/18.json")).statusCode, 200);
  // Files added by later features are served without a list to keep in step.
  assert.equal((await app.inject("/data/rumours.json")).statusCode, 200);
  assert.equal((await app.inject("/data/voices/index.json")).statusCode, 200);
  const clip = await app.inject("/data/voices/lines/ab12.mp3");
  assert.equal(clip.statusCode, 200);
  assert.equal(clip.headers["content-type"], "audio/mpeg");
  assert.equal((await app.inject("/maps/manifest.json")).statusCode, 200);
  assert.equal((await app.inject("/host-health")).statusCode, 200);
  assert.equal((await app.inject("/bots")).statusCode, 503);
  for (const path of ["/data/secrets.env", "/data/requests.sqlite", "/data/voices/export.zip", "/data/private.json", "/data/",
    "/data/%2e%2e/private.json", "/data/ties/%2e%2e/secrets.env", "/data/ties/18.json:secret",
    "/data/%5c..%5cprivate.json", "/.git/config", "/standalone/package.json"]) {
    const response = await app.inject(path);
    assert.notEqual(response.statusCode, 200, path);
    assert.ok(!response.body.includes("PRIVATE"), path);
  }
  // Directory junctions work without elevated symlink rights on Windows.
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside", "9.json"), '"PRIVATE"');
  await symlink(join(root, "outside"), join(data, "journeys"), "junction");
  assert.equal((await app.inject("/data/journeys/9.json")).statusCode, 404);
  assert.equal((await app.inject("/data/accounting.json")).headers["cache-control"], "no-store");
  await writeFile(join(data, "accounting.json"), "{");
  const malformed = await app.inject("/data/accounting.json");
  assert.equal(malformed.statusCode, 502);
  assert.ok(!malformed.body.includes(root));
  assert.equal((await app.inject({ url: "/bots", headers: { "x-dashboard-proxy-hop": "1" } })).statusCode, 508);
});

await test("live reads validate responses and recover; command auth and outcomes pass through", async t => {
  const upstream = Fastify();
  let mode = "online";
  let received = 0;
  let seenToken: unknown;
  upstream.get("/bots", (_request, reply) => {
    if (mode === "offline") return reply.code(503).send({ error: "not ready" });
    if (mode === "invalid") return { players: "bad" };
    if (mode === "malformed") return reply.type("application/json").send("{");
    return snapshot;
  });
  upstream.get("/worldmap", () => ({ zones: [], continents: { "0": "Eastern Kingdoms" } }));
  upstream.post("/cmd/pause", (request, reply) => {
    received++;
    seenToken = request.headers["x-dashboard-token"];
    assert.deepEqual(request.body, { guid: 18 });
    if (seenToken !== "correct") return reply.code(401).send({ ok: false, message: "Missing or wrong token" });
    if (mode === "queued") return reply.code(504).send({ ok: false, id: 42, message: "Queued; check /commands" });
    return { ok: true, message: "Paused", id: 42 };
  });
  const address = await upstream.listen({ host: "127.0.0.1", port: 0 });
  const app = createServer(readConfig({ DASHBOARD_WORLD_URL: address }));
  t.after(async () => { await app.close(); await upstream.close(); });
  assert.deepEqual((await app.inject("/bots")).json<unknown>(), snapshot);
  assert.equal((await app.inject("/worldmap")).statusCode, 200);
  for (const [value, status] of [["offline", 503], ["invalid", 502], ["malformed", 502]] as const) {
    mode = value;
    assert.equal((await app.inject("/bots")).statusCode, status);
  }
  mode = "online";
  assert.equal((await app.inject("/bots")).statusCode, 200);
  const send = (token: string, payload: unknown = { guid: 18 }, origin?: string) => app.inject({
    method: "POST", url: "/cmd/pause", payload: JSON.stringify(payload),
    headers: { "content-type": "application/json", "x-dashboard-token": token, ...(origin ? { origin } : {}) },
  });
  assert.equal((await send("")).statusCode, 401);
  assert.equal((await send("correct", { guid: -1 })).statusCode, 400);
  assert.equal((await send("correct", { guid: 18, cmd: "other" })).statusCode, 400);
  assert.equal((await send("correct", { guid: 18 }, "http://evil.example")).statusCode, 403);
  assert.equal(received, 0);
  const oversized = await app.inject({ method: "POST", url: "/cmd/pause", payload: { text: "x".repeat(2048) } });
  assert.equal(oversized.statusCode, 413);
  assert.equal((await send("wrong")).statusCode, 401);
  assert.equal(seenToken, "wrong");
  assert.equal((await send("correct")).statusCode, 200);
  mode = "queued";
  const queued = await send("correct");
  assert.equal(queued.statusCode, 504);
  assert.deepEqual(queued.json<unknown>(), { ok: false, id: 42, message: "Queued; check /commands" });
  assert.equal(received, 3);
  assert.equal((await app.inject({ method: "POST", url: "/cmd/delete", payload: {} })).statusCode, 404);
});

await test("command timeouts are bounded and never retried or redirected", async t => {
  const upstream = Fastify();
  let received = 0;
  let redirected = 0;
  let mode = "delay";
  upstream.post("/cmd/resume", async (_request, reply) => {
    received++;
    if (mode === "redirect") return reply.redirect("/capture");
    await new Promise(resolve => setTimeout(resolve, 250));
    return { ok: true, message: "Resumed" };
  });
  upstream.all("/capture", () => { redirected++; return { ok: true }; });
  const address = await upstream.listen({ host: "127.0.0.1", port: 0 });
  const app = createServer(readConfig({ DASHBOARD_WORLD_URL: address, DASHBOARD_TIMEOUT_MS: "100" }));
  t.after(async () => { await app.close(); await upstream.close(); });
  const send = () => app.inject({ method: "POST", url: "/cmd/resume", payload: { guid: 1 }, headers: { "x-dashboard-token": "secret" } });
  const timeout = await send();
  assert.equal(timeout.statusCode, 503);
  assert.match(timeout.body, /Delivery is unconfirmed/);
  mode = "redirect";
  assert.equal((await send()).statusCode, 502);
  assert.equal(received, 2);
  assert.equal(redirected, 0);
});
