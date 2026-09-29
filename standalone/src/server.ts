import Fastify from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import { commandBody, settingBody } from "./contracts.js";
import { ControlApi, tokenMatches } from "./control.js";
import { readFile } from "./files.js";
import { UpstreamError, Worldserver } from "./worldserver.js";

export function createServer(config: Config) {
  // A setting's value can be a prompt line, so bodies may reach a few kilobytes.
  const app = Fastify({ bodyLimit: 4096, requestTimeout: 10000, logger: false });
  const world = new Worldserver(config);
  const control = config.control ? new ControlApi(config.control) : null;
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : error instanceof SyntaxError ? 502 : 500;
    // Do not expose filesystem paths or upstream details in public error bodies.
    void reply.code(status).send({ error: status >= 500 ? "Dashboard request failed" : "Invalid request" });
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    if (_request.headers["x-dashboard-proxy-hop"]) return reply.code(508).send({ error: "Dashboard proxy loop" });
  });
  app.get("/host-health", () => ({ ok: true }));
  const authorize = (request: { headers: Record<string, unknown>; protocol: string; host: string }) => {
    if (!control || !config.control) return 503;
    const origin = request.headers.origin;
    if (origin && origin !== `${request.protocol}://${request.host}`) return 403;
    return tokenMatches(config.control.token, request.headers["x-control-token"]) ? 200 : 401;
  };
  app.get("/api/server/state", async (request, reply) => {
    const status = authorize(request);
    if (status !== 200 || !control) return reply.code(status).send({ error: status === 503 ? "Server management is not configured" : "Access denied" });
    try { return await control.state(); }
    catch { return reply.code(503).send({ error: "Management service unavailable" }); }
  });
  app.get("/api/server/job", async (request, reply) => {
    const status = authorize(request);
    if (status !== 200 || !control) return reply.code(status).send({ error: status === 503 ? "Server management is not configured" : "Access denied" });
    try { return await control.job(); }
    catch { return reply.code(503).send({ error: "Management service unavailable" }); }
  });
  app.post("/api/server/action", async (request, reply) => {
    const status = authorize(request);
    if (status !== 200 || !control) return reply.code(status).send({ error: status === 503 ? "Server management is not configured" : "Access denied" });
    const body = z.strictObject({ action: z.enum(["start", "stop"]) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Expected start or stop" });
    try { return await control.action(body.data.action); }
    catch { return reply.code(503).send({ error: "Management service did not accept the operation; check its job status" }); }
  });
  app.get("/api/server/models", async (request, reply) => {
    const status = authorize(request);
    if (status !== 200 || !control) return reply.code(status).send({ error: status === 503 ? "Server management is not configured" : "Access denied" });
    try { return await control.models(); }
    catch { return reply.code(503).send({ error: "Management service unavailable" }); }
  });
  app.post("/api/server/model", async (request, reply) => {
    const status = authorize(request);
    if (status !== 200 || !control) return reply.code(status).send({ error: status === 503 ? "Server management is not configured" : "Access denied" });
    // The admin validates against what it manages and what OpenRouter lists; this only bounds the shape.
    const body = z.strictObject({
      backend: z.string().regex(/^[a-z0-9-]{1,60}$/),
      model: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,60}\/[a-z0-9][a-z0-9._:-]{0,100}$/),
      reasoning: z.enum(["minimal", "low", "medium", "high"]),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Expected a backend, an OpenRouter model id and a reasoning level" });
    try { return await control.setModel(body.data); }
    catch { return reply.code(503).send({ error: "Management service did not accept the operation; check its job status" }); }
  });
  for (const path of ["/bots", "/worldmap", "/commands", "/health", "/settings"] as const) {
    app.get(path, async (_request, reply) => {
      try { return await world.read(path); }
      catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        return reply.code(error.status).send({ error: error.message });
      }
    });
  }
  for (const command of ["pause", "resume"] as const) {
    app.post(`/cmd/${command}`, async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && origin !== `${request.protocol}://${request.host}`) {
        return reply.code(403).send({ ok: false, message: "Cross-origin commands are not allowed" });
      }
      const token = request.headers["x-dashboard-token"];
      if (typeof token !== "string" || !token.trim() || token.length > 1024) {
        return reply.code(401).send({ ok: false, message: "Missing command token" });
      }
      const body = commandBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ ok: false, message: "Expected a character guid" });
      try {
        const result = await world.command(command, body.data.guid, token);
        return await reply.code(result.status).send(result.body);
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        return reply.code(error.status).send({ ok: false, message: `${error.message}. Delivery is unconfirmed; check command history before trying again.` });
      }
    });
  }
  app.post("/cmd/setting", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origin !== `${request.protocol}://${request.host}`) {
      return reply.code(403).send({ ok: false, message: "Cross-origin commands are not allowed" });
    }
    const token = request.headers["x-dashboard-token"];
    if (typeof token !== "string" || !token.trim() || token.length > 1024) {
      return reply.code(401).send({ ok: false, message: "Missing command token" });
    }
    const body = settingBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ ok: false, message: "Expected a setting key and value" });
    try {
      const result = await world.setting(body.data.key, body.data.value, token);
      return await reply.code(result.status).send(result.body);
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      return reply.code(error.status).send({ ok: false, message: `${error.message}. The change is unconfirmed; reload the Settings panel before trying again.` });
    }
  });
  app.get<{ Params: { "*": string } }>("/*", async (request, reply) => {
    const file = await readFile(request.params["*"], config);
    if (!file) return reply.code(404).send({ error: "Not found" });
    return reply.type(file.type).send(file.body);
  });
  return app;
}
