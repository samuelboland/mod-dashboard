import Fastify from "fastify";
import type { Config } from "./config.js";
import { commandBody } from "./contracts.js";
import { readFile } from "./files.js";
import { UpstreamError, Worldserver } from "./worldserver.js";

export function createServer(config: Config) {
  const app = Fastify({ bodyLimit: 1024, requestTimeout: 10000, logger: false });
  const world = new Worldserver(config);
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
  for (const path of ["/bots", "/worldmap", "/commands", "/health"] as const) {
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
  app.get<{ Params: { "*": string } }>("/*", async (request, reply) => {
    const file = await readFile(request.params["*"], config);
    if (!file) return reply.code(404).send({ error: "Not found" });
    return reply.type(file.type).send(file.body);
  });
  return app;
}
