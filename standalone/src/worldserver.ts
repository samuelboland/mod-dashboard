import type { Config } from "./config.js";
import { commandResult, liveSchemas } from "./contracts.js";
import type { Command, LivePath } from "./contracts.js";

const MAX_RESPONSE = 16 * 1024 * 1024;

export class UpstreamError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// The deadline covers both headers and the body; never follow a redirect with a token.
async function readJSON(response: Response): Promise<unknown> {
  if (!response.body || !response.headers.get("content-type")?.includes("application/json")) {
    throw new UpstreamError(502, "Worldserver returned an invalid response");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      const value = chunk.value;
      size += value.length;
      if (size > MAX_RESPONSE) throw new UpstreamError(502, "Worldserver response exceeded the size limit");
      chunks.push(value);
      chunk = await reader.read();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export class Worldserver {
  constructor(private readonly config: Pick<Config, "upstream" | "timeoutMs">) {}

  private async request(path: string, init: RequestInit = {}) {
    try {
      const headers = new Headers(init.headers);
      headers.set("X-Dashboard-Proxy-Hop", "1");
      const response = await fetch(this.config.upstream + path, {
        ...init, headers,
        redirect: "manual", signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      const body = await readJSON(response);
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (error instanceof SyntaxError) throw new UpstreamError(502, "Worldserver returned malformed JSON");
      throw new UpstreamError(503, "Worldserver unavailable or timed out");
    }
  }

  async read(path: LivePath) {
    const response = await this.request(path);
    if (response.status !== 200) throw new UpstreamError(503, "Worldserver snapshot unavailable");
    const parsed = liveSchemas[path].safeParse(response.body);
    if (!parsed.success) throw new UpstreamError(502, "Worldserver returned an invalid snapshot");
    return parsed.data;
  }

  async command(command: Command, guid: number, token: string) {
    // Exactly one attempt. A timeout may mean the command ran without a reply.
    const response = await this.request(`/cmd/${command}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Dashboard-Token": token },
      body: JSON.stringify({ guid }),
    });
    const parsed = commandResult.safeParse(response.body);
    if (!parsed.success || response.status < 200 || response.status >= 600 || (response.status >= 300 && response.status < 400)) {
      throw new UpstreamError(502, "Worldserver returned an invalid command result");
    }
    return { status: response.status, body: parsed.data };
  }
}
