import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const schema = z.object({
  DASHBOARD_HOST: z.string().min(1).default("127.0.0.1"),
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  DASHBOARD_WORLD_URL: z.url().default("http://127.0.0.1:8787"),
  DASHBOARD_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(6000),
  DASHBOARD_WEB_ROOT: z.string().min(1).default(fileURLToPath(new URL("../../web", import.meta.url))),
  DASHBOARD_DATA_ROOT: z.string().min(1).optional(),
  DASHBOARD_MAP_ROOT: z.string().min(1).optional(),
  DASHBOARD_CONTROL_URL: z.url().optional(),
  DASHBOARD_CONTROL_HOST_HEADER: z.string().regex(/^[a-zA-Z0-9.-]+:\d{1,5}$/).optional(),
  DASHBOARD_CONTROL_TOKEN: z.string().min(32).optional(),
});

export function readConfig(env: NodeJS.ProcessEnv) {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid dashboard settings: ${result.error.issues.map(i => i.path.join(".")).join(", ")}`);
  const value = result.data;
  const upstream = new URL(value.DASHBOARD_WORLD_URL);
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password
      || upstream.search || upstream.hash || upstream.pathname !== "/") {
    throw new Error("DASHBOARD_WORLD_URL must be an HTTP(S) origin without credentials or a path");
  }
  if (upstream.hostname === value.DASHBOARD_HOST && Number(upstream.port || (upstream.protocol === "https:" ? 443 : 80)) === value.DASHBOARD_PORT) {
    throw new Error("Dashboard and worldserver must use different listening addresses");
  }
  if (Boolean(value.DASHBOARD_CONTROL_URL) !== Boolean(value.DASHBOARD_CONTROL_TOKEN))
    throw new Error("Control URL and token must both be set");
  if (value.DASHBOARD_CONTROL_HOST_HEADER && !value.DASHBOARD_CONTROL_URL)
    throw new Error("Control Host override requires a control URL");
  const control = value.DASHBOARD_CONTROL_URL ? new URL(value.DASHBOARD_CONTROL_URL) : null;
  if (control && (control.protocol !== "http:" && control.protocol !== "https:" || control.username || control.password || control.search || control.hash || control.pathname !== "/"))
    throw new Error("Control URL must be an HTTP(S) origin without credentials or a path");
  return {
    host: value.DASHBOARD_HOST, port: value.DASHBOARD_PORT, upstream: upstream.origin,
    timeoutMs: value.DASHBOARD_TIMEOUT_MS, webRoot: resolve(value.DASHBOARD_WEB_ROOT),
    dataRoot: value.DASHBOARD_DATA_ROOT ? resolve(value.DASHBOARD_DATA_ROOT) : undefined,
    mapRoot: value.DASHBOARD_MAP_ROOT ? resolve(value.DASHBOARD_MAP_ROOT) : undefined,
    control: control && value.DASHBOARD_CONTROL_TOKEN ? {
      origin: control.origin,
      hostHeader: value.DASHBOARD_CONTROL_HOST_HEADER ?? control.host,
      token: value.DASHBOARD_CONTROL_TOKEN,
    } : null,
  };
}

export type Config = ReturnType<typeof readConfig>;
