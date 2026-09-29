import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { z } from "zod";
import type { Config } from "./config.js";

type ControlConfig = NonNullable<Config["control"]>;
const number = z.number().nonnegative();
const adminState = z.looseObject({
  time: number, docker: z.boolean(),
  containers: z.array(z.looseObject({ name: z.string(), Running: z.boolean() })),
  samples: z.array(z.looseObject({ time: number, cpu: number, memory: number })),
  runtime: z.unknown().optional(),
});
const adminJob = z.looseObject({
  id: z.string(), action: z.string(), status: z.enum(["running", "done", "failed"]),
});
const session = z.object({ token: z.string().min(1) });
const adminModels = z.looseObject({
  backends: z.array(z.looseObject({ name: z.string(), editable: z.boolean(), model: z.string(), reasoning: z.string(), running: z.boolean() })),
  routes: z.record(z.string(), z.array(z.string())),
  efforts: z.array(z.string()),
  choices: z.array(z.looseObject({ id: z.string(), name: z.string(), inputPerMillion: z.number().nullable(), outputPerMillion: z.number().nullable() })),
});
export type ModelChange = { backend: string; model: string; reasoning: string };

export function tokenMatches(expected: string, supplied: unknown) {
  if (typeof supplied !== "string" || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

// This adapter speaks only the local admin's state, job, session, models, start/stop and model
// routes. It never exposes the upstream session token or arbitrary admin calls.
export class ControlApi {
  constructor(private readonly config: ControlConfig) {}

  private request(path: "/api/state" | "/api/job" | "/api/session" | "/api/action" | "/api/models",
                  method: "GET" | "POST" = "GET", body?: { action: "start" | "stop" } | ({ action: "model" } & ModelChange),
                  adminToken?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const target = new URL(path, this.config.origin);
      const transport = target.protocol === "https:" ? https : http;
      const payload = body ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = { Host: this.config.hostHeader, Accept: "application/json" };
      if (payload) headers["Content-Type"] = "application/json";
      if (adminToken) headers["X-Admin-Token"] = adminToken;
      const request = transport.request(target, {
        method, headers, timeout: 20000, agent: false,
      }, response => {
        if (response.statusCode !== 200 && response.statusCode !== 202) {
          response.resume();
          reject(new Error(`Admin service returned HTTP ${String(response.statusCode ?? 0)}`));
          return;
        }
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (part: string) => {
          text += part;
          if (text.length > 2_000_000) request.destroy(new Error("Admin response too large"));
        });
        response.on("end", () => {
          try { resolve(JSON.parse(text) as unknown); }
          catch { reject(new Error("Admin returned malformed JSON")); }
        });
        response.on("error", reject);
      });
      request.on("timeout", () => request.destroy(new Error("Admin service timed out")));
      request.on("error", reject);
      request.end(payload);
    });
  }

  async state() {
    const parsed = adminState.safeParse(await this.request("/api/state"));
    if (!parsed.success) throw new Error("Admin returned an invalid state");
    const source = parsed.data;
    const workshop = source.containers.find(item => item.name === "hdm-workshop");
    const database = source.containers.find(item => item.name === "hdm-database");
    const runtime = z.looseObject({
      worldReady: z.boolean().optional(),
      services: z.record(z.string(), z.string()).optional(),
      cpuCount: number.optional(),
    }).safeParse(source.runtime);
    const world = runtime.success ? runtime.data.services?.world : undefined;
    const ready = Boolean(workshop?.Running && runtime.success && runtime.data.worldReady && world === "RUNNING");
    const phase = !source.docker ? "unavailable" : !workshop?.Running ? "stopped" : ready ? "online"
      : world === "STARTING" || world === "RUNNING" ? "starting" : world === "STOPPED" || world === "EXITED" || world === "FATAL" ? "stopped" : "unknown";
    return {
      available: source.docker, phase, checkedAt: source.time,
      workshopRunning: Boolean(workshop?.Running), databaseRunning: Boolean(database?.Running),
      logicalCpus: runtime.success ? runtime.data.cpuCount ?? null : null,
      samples: source.samples.slice(-120).map(item => ({ time: item.time, cpuPercent: item.cpu, memoryBytes: item.memory })),
    };
  }

  async job() {
    const response = await this.request("/api/job");
    if (response === null) return null;
    const parsed = adminJob.safeParse(response);
    if (!parsed.success) throw new Error("Admin returned an invalid job");
    return { id: parsed.data.id, action: parsed.data.action, status: parsed.data.status };
  }

  async models() {
    const parsed = adminModels.safeParse(await this.request("/api/models"));
    if (!parsed.success) throw new Error("Admin returned invalid models");
    return parsed.data;
  }

  async setModel(change: ModelChange) {
    const parsed = session.safeParse(await this.request("/api/session"));
    if (!parsed.success) throw new Error("Admin session unavailable");
    const response = adminJob.safeParse(await this.request("/api/action", "POST", { action: "model", ...change }, parsed.data.token));
    if (!response.success) throw new Error("Admin did not accept the operation");
    return { id: response.data.id, action: response.data.action, status: response.data.status };
  }

  async action(action: "start" | "stop") {
    const parsed = session.safeParse(await this.request("/api/session"));
    if (!parsed.success) throw new Error("Admin session unavailable");
    const response = adminJob.safeParse(await this.request("/api/action", "POST", { action }, parsed.data.token));
    if (!response.success) throw new Error("Admin did not accept the operation");
    return { id: response.data.id, action: response.data.action, status: response.data.status };
  }
}
