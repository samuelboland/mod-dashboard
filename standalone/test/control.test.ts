import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { readConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const access = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

await test("control config requires a paired URL and token", () => {
  for (const env of [
    { DASHBOARD_CONTROL_URL: "http://127.0.0.1:8789" },
    { DASHBOARD_CONTROL_TOKEN: access },
    { DASHBOARD_CONTROL_URL: "file:///private", DASHBOARD_CONTROL_TOKEN: access },
    { DASHBOARD_CONTROL_URL: "http://user:pass@localhost:8789", DASHBOARD_CONTROL_TOKEN: access },
    { DASHBOARD_CONTROL_URL: "http://localhost:8789/private", DASHBOARD_CONTROL_TOKEN: access },
    { DASHBOARD_CONTROL_HOST_HEADER: "localhost:8789" },
  ]) assert.throws(() => readConfig(env));
});

await test("control routes project status and forward only authorized start/stop", async t => {
  const admin = Fastify();
  const seen: string[] = [];
  let job: { id: string; action: string; status: "running" | "done" } | null = null;
  admin.addHook("onRequest", async (request, reply) => {
    if (request.headers.host !== "127.0.0.1:8789") return reply.code(403).send({ error: "host" });
    seen.push(`${request.method} ${request.url}`);
  });
  admin.get("/api/state", () => ({
    time: 1790500000000, docker: true,
    containers: [{ name: "hdm-workshop", Running: true }, { name: "hdm-database", Running: true }],
    samples: [{ time: 1790500000000, cpu: 165.2, memory: 2147483648 }],
    runtime: { worldReady: true, services: { world: "RUNNING" }, cpuCount: 16, private: "hidden" },
    private: "hidden",
  }));
  admin.get("/api/job", () => job);
  admin.get("/api/session", () => ({ token: "private-admin-session" }));
  admin.post("/api/action", (request, reply) => {
    assert.equal(request.headers["x-admin-token"], "private-admin-session");
    const body = request.body as { action: string };
    assert.ok(body.action === "start" || body.action === "stop");
    job = { id: "42", action: body.action, status: "running" };
    return reply.code(202).send(job);
  });
  const address = await admin.listen({ host: "127.0.0.1", port: 0 });
  const app = createServer(readConfig({
    DASHBOARD_CONTROL_URL: address,
    DASHBOARD_CONTROL_HOST_HEADER: "127.0.0.1:8789",
    DASHBOARD_CONTROL_TOKEN: access,
  }));
  t.after(async () => { await app.close(); await admin.close(); });
  const headers = { "x-control-token": access };
  const inject = (method: "GET" | "POST", url: string, payload?: unknown, extra = {}) =>
    app.inject({ method, url, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      headers: { ...headers, ...extra, ...(payload === undefined ? {} : { "content-type": "application/json" }) } });

  assert.equal((await inject("GET", "/api/server/state", undefined, { "x-control-token": "wrong" })).statusCode, 401);
  assert.equal((await inject("GET", "/api/server/state", undefined, { origin: "http://evil.example" })).statusCode, 403);
  assert.deepEqual(seen, []);

  const state = await inject("GET", "/api/server/state");
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json<unknown>(), {
    available: true, phase: "online", checkedAt: 1790500000000,
    workshopRunning: true, databaseRunning: true, logicalCpus: 16,
    samples: [{ time: 1790500000000, cpuPercent: 165.2, memoryBytes: 2147483648 }],
  });
  assert.ok(!state.body.includes("hidden"));
  assert.equal((await inject("GET", "/api/server/job")).body, "null");
  assert.equal((await inject("POST", "/api/server/action", { action: "restart" })).statusCode, 400);
  assert.equal((await inject("POST", "/api/server/action", { action: "start", extra: 1 })).statusCode, 400);
  assert.equal((await inject("POST", "/api/server/action", { action: "stop" }, { origin: "http://evil.example" })).statusCode, 403);
  assert.deepEqual(seen, ["GET /api/state", "GET /api/job"]);

  const started = await inject("POST", "/api/server/action", { action: "start" });
  assert.equal(started.statusCode, 200);
  assert.deepEqual(started.json<unknown>(), { id: "42", action: "start", status: "running" });
  assert.ok(!started.body.includes("private-admin-session"));
  assert.deepEqual((await inject("GET", "/api/server/job")).json<unknown>(), { id: "42", action: "start", status: "running" });
  assert.equal((await inject("POST", "/api/server/action", { action: "stop" })).statusCode, 200);
  assert.deepEqual(seen, ["GET /api/state", "GET /api/job", "GET /api/session", "POST /api/action", "GET /api/job", "GET /api/session", "POST /api/action"]);
});

await test("models are read through and a change forwards only backend, model and reasoning", async t => {
  const admin = Fastify();
  const actions: unknown[] = [];
  const listed = {
    backends: [{ name: "openrouter-quality", editable: true, model: "anthropic/claude-sonnet-5.5", reasoning: "low", running: true }],
    routes: { quality: ["openrouter-quality", "openrouter"] },
    efforts: ["minimal", "low", "medium", "high"],
    choices: [{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", inputPerMillion: 2, outputPerMillion: 10 }],
  };
  admin.get("/api/models", () => listed);
  admin.get("/api/session", () => ({ token: "private-admin-session" }));
  admin.post("/api/action", (request, reply) => {
    assert.equal(request.headers["x-admin-token"], "private-admin-session");
    actions.push(request.body);
    return reply.code(202).send({ id: "7", action: "model", status: "running" });
  });
  const address = await admin.listen({ host: "127.0.0.1", port: 0 });
  const app = createServer(readConfig({
    DASHBOARD_CONTROL_URL: address, DASHBOARD_CONTROL_HOST_HEADER: "127.0.0.1:8789", DASHBOARD_CONTROL_TOKEN: access,
  }));
  t.after(async () => { await app.close(); await admin.close(); });
  const inject = (method: "GET" | "POST", url: string, payload?: unknown, token = access) =>
    app.inject({ method, url, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      headers: { "x-control-token": token, ...(payload === undefined ? {} : { "content-type": "application/json" }) } });

  assert.equal((await inject("GET", "/api/server/models", undefined, "wrong")).statusCode, 401);
  assert.deepEqual((await inject("GET", "/api/server/models")).json<unknown>(), listed);
  const change = { backend: "openrouter-quality", model: "anthropic/claude-opus-5.5", reasoning: "low" };
  assert.equal((await inject("POST", "/api/server/model", { ...change, model: "not a model" })).statusCode, 400);
  assert.equal((await inject("POST", "/api/server/model", { ...change, reasoning: "max" })).statusCode, 400);
  assert.equal((await inject("POST", "/api/server/model", { ...change, extra: 1 })).statusCode, 400);
  assert.equal((await inject("POST", "/api/server/model", change, "wrong")).statusCode, 401);
  assert.deepEqual(actions, []);
  const accepted = await inject("POST", "/api/server/model", change);
  assert.deepEqual(accepted.json<unknown>(), { id: "7", action: "model", status: "running" });
  assert.deepEqual(actions, [{ action: "model", ...change }]);
});

await test("control reports unavailable admin without leaking upstream details", async t => {
  const admin = Fastify();
  admin.get("/api/state", () => ({ error: "secret path C:/private" }));
  const address = await admin.listen({ host: "127.0.0.1", port: 0 });
  const app = createServer(readConfig({ DASHBOARD_CONTROL_URL: address, DASHBOARD_CONTROL_TOKEN: access }));
  t.after(async () => { await app.close(); await admin.close(); });
  const response = await app.inject({ url: "/api/server/state", headers: { "x-control-token": access } });
  assert.equal(response.statusCode, 503);
  assert.ok(!response.body.includes("private"));

  const unconfigured = createServer(readConfig({}));
  t.after(async () => { await unconfigured.close(); });
  assert.equal((await unconfigured.inject({ url: "/api/server/state", headers: { "x-control-token": access } })).statusCode, 503);
});
