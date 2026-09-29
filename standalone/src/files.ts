import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Config } from "./config.js";

// Every JSON document and recorded voice line under the published data root. The services write new
// files there as features arrive, so a named list would drift behind the UI and answer 404 in silence.
const published = /^([\w-]+\/)*[\w-]+\.(json|mp3|wav)$/;
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

function selectFile(path: string, config: Config) {
  if (path.includes("\\") || path.includes("\0") || path.includes(":")) return;
  const parts = path.split("/");
  if (parts.some(part => part.startsWith("."))) return;
  if (path.startsWith("data/")) {
    const name = path.slice(5);
    if (published.test(name)) {
      return { root: config.dataRoot, name };
    }
    return;
  }
  if (path.startsWith("maps/")) {
    const name = path.slice(5);
    if (name === "manifest.json" || /^[\w/-]+\.(png|jpg|jpeg|webp)$/.test(name)) return { root: config.mapRoot, name };
    return;
  }
  if (path === "" || path === "index.html") return { root: config.webRoot, name: "index.html" };
  if (/^(js\/[\w/-]+\.js|css\/[\w/-]+\.css)$/.test(path)) return { root: config.webRoot, name: path };
  return;
}

export async function readFile(path: string, config: Config) {
  const selected = selectFile(path, config);
  if (!selected?.root) return;
  try {
    const root = await realpath(selected.root);
    const target = await realpath(resolve(root, selected.name));
    const inside = relative(root, target);
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) return;
    const file = await open(target, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return;
      const body = await file.readFile();
      if (extname(target) === ".json") JSON.parse(body.toString("utf8"));
      return { body, type: contentTypes[extname(target)] ?? "application/octet-stream" };
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(String(error.code))) return;
    throw error;
  }
}
