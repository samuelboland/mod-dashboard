// What the Models panel knows that needs no page: the rules a model name and a route's list must meet, the
// edits to a list, and the words for each state. The server (services/common/fleet_admin.py) checks every
// change again; these checks only save a round trip and say what is wrong before pressing Save.

// What a route is for, from the comments in fleet.toml. A route the realm added itself shows without one.
export const ROUTE_HELP = {
  ambient: "Idle chatter and events. The most traffic by far.",
  quality: "Lines said to a person.",
  chronicle: "The chronicler's day-books. Long, and not often.",
  prose: "Backstories and other long writing.",
  utility: "Sorting and judging. Short, fast, JSON.",
  moment: "The rare line that should be the best the realm can give.",
};

// Same rule as fleet_config.MODEL_RE: a slug or a file name, with no spaces, quotes or control characters.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+=~-]{0,199}$/;

export function checkModel(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { error: "a model name (or Reset, to use fleet.toml's)" };
  if (!MODEL.test(text)) return { error: "letters, digits and . _ : / @ + = ~ - only, no spaces or quotes, up to 200 long" };
  return { value: text };
}

export const sameChain = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// The list with the backend at `index` moved by `delta` places, or the same list if it cannot move that far.
export function moveBackend(chain, index, delta) {
  const to = index + delta;
  if (index < 0 || index >= chain.length || to < 0 || to >= chain.length) return chain;
  const out = [...chain];
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

export const removeBackend = (chain, index) => chain.filter((_, i) => i !== index);
export const addBackend = (chain, name) => (chain.includes(name) ? chain : [...chain, name]);

// The backends a route could still take: every defined one it does not already list.
export const addable = (backends, chain) => backends.map(b => b.name).filter(n => !chain.includes(n));

// Why this list cannot be saved, or null. A backend whose key is missing is skipped by the router, so a list
// of only those would leave the route with nobody to answer.
export function chainProblem(chain, backends, max = 16) {
  if (!chain.length) return "A route needs at least one backend.";
  if (chain.length > max) return `At most ${max} backends.`;
  const byName = new Map(backends.map(b => [b.name, b]));
  if (!chain.some(n => byName.get(n)?.usable)) return "None of these has its API key set, so nothing would answer.";
  return null;
}

export const keyLabel = key => (key === "set" ? "key set" : key === "missing" ? "no key" : "no key needed");

// "used by" in one line: the routes, then the two batch roles.
export function usedBy(b) {
  const parts = [];
  if (b.used_by?.routes?.length) parts.push(`routes ${b.used_by.routes.join(", ")}`);
  if (b.used_by?.lane) parts.push("writing lanes");
  if (b.used_by?.judge) parts.push(b.used_by.judge === "fallback" ? "judge (second choice)" : "the judge");
  return parts.length ? parts.join(" · ") : "nothing yet";
}

// The router's own word on whether it has what was saved: fleet_admin.router_status.
export function routerWords(router) {
  switch (router?.state) {
    case "live": return { tone: "ok", title: "The router is using these settings", text: "Chat routes follow what is shown here." };
    case "waiting": return { tone: "wait", title: "Saved. Waiting for the router", text: "It looks for a change every few seconds and switches without dropping a request." };
    case "error": return { tone: "bad", title: "The router kept its old settings", text: router.error || "It could not use the saved ones." };
    case "down": return { tone: "bad", title: "The router is not answering", text: "A saved change applies when it starts." };
    case "old": return { tone: "bad", title: "This router cannot follow changes yet", text: "It was started before model settings existed. Restart it once (sudo systemctl restart wow-router); after that it follows changes by itself." };
    default: return { tone: "wait", title: "Router state unknown", text: "" };
  }
}

// Which change needs what, true as of the code in this repository. Each service builds its writing lanes
// whenever it begins a piece of work, but regard, the chronicler and the Dungeon Master build the judge once,
// when they start. Keep this and MODELS.md in step.
export const APPLIES = [
  { area: "Chat routes", when: "At once",
    text: "The router looks for a saved change every few seconds and switches without dropping a request. No restart." },
  { area: "Writing for the realm (backstories, chronicle, rumours, Dungeon Master, lore gate)", when: "Next piece of work",
    text: "Each service looks the model up again when it begins a job. No restart." },
  { area: "The judge (is a text out of its age)", when: "Restart three services",
    text: "Regard, the chronicler and the Dungeon Master read the judge once, when they start. Restart them: systemctl --user restart wow-regard wow-chronicler wow-dm. The lore gate and one-off commands read it each time." },
  { area: "API keys", when: "Restart the router",
    text: "Keys are read when a service starts. After adding one to site/secrets.env, restart the router (sudo systemctl restart wow-router). This panel shows what is in the file now." },
  { area: "Replies to players", when: "After ollama reload",
    text: "OllamaChat.Reply.Model, in the Settings panel, names a route from this list (ambient, quality and so on). Anything else is answered by ambient." },
];
