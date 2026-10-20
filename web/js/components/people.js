// People panel (isekai realms; services/lore/guidance.py through the lore gate): every arrival, who they were
// back home, and the last thing they said. Choosing one opens them full screen (person.js), where they can be
// followed closely and sent a system message.
import { state, on, emit, localSet, localGet } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { CLASSES, RACES, stamp } from "../lib/format.js";
import { GATE, readToken, saveToken } from "../lib/gate.js";
import { avatar, empty } from "./common.js";

const REFRESH_MS = 30000;
const VIEWS = [
  ["all", "Everyone"],
  ["online", "In the world"],
  ["played", "Played it"],
  ["heard", "Heard"],
  ["guided", "Guided"],
];
const FILTERS = {
  all: () => true,
  online: p => p.online,
  played: p => p.knows >= 2,
  heard: p => p.knows === 1,
  guided: p => p.guided > 0,
};
export const KNOWS = ["Doesn't know it's a game", "Heard it's World of Warcraft", "Played World of Warcraft"];

// The gate, read with the shared token. `bad` is set when the gate turned the token away.
export const people = { list: null, days: null, guidance: false, error: "", bad: false };

export async function gateGet(path) {
  const res = await fetch(GATE + path, { headers: { "X-Lore-Token": readToken() }, cache: "no-store" });
  people.bad = res.status === 401 || res.status === 503;
  return res.json();
}

export async function gatePost(path, body) {
  const res = await fetch(GATE + path, { method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Lore-Token": readToken() }, body: JSON.stringify(body) });
  people.bad = res.status === 401;
  return res.json();
}

export async function refreshPeople() {
  try {
    const doc = await gateGet("/people");
    if (doc.ok) Object.assign(people, { list: doc.people, days: doc.days, guidance: doc.guidance, error: "" });
    else people.error = doc.message || "The gate said no.";
  } catch {
    people.error = "The lore gate did not answer.";
  }
  emit("people");
}

const where = p => {
  const live = state.byGuid.get(p.guid);
  if (live) return live.instance ? live.map_name : live.zone_name || live.map_name;
  return p.online ? "In the world" : "Not in the world";
};

function row(p) {
  const live = state.byGuid.get(p.guid);
  return h("button.row.pp-row", { type: "button", title: p.goal || "",
    on: { click: () => emit("open-person", { guid: p.guid }) } },
    avatar(p),
    h("span.row-main",
      h("span.row-name", p.name, h("span.pp-earth", ` · ${p.earth || "?"}`)),
      h("span.row-sub", `${p.age ?? "?"}, ${p.job || "?"}, ${p.home || "?"}`),
      h("span.row-sub", `${p.level} ${RACES[p.race] || ""} ${CLASSES[p.class] || ""} · ${where(p)}`),
      p.said && h("span.pp-said", { title: p.said_at ? stamp(p.said_at) : "" }, `“${p.said}”`)),
    h("span.row-end.pp-end",
      p.knows >= 2 && h("span.pp-know.played", { title: KNOWS[2] }, icon("key", 12)),
      p.knows === 1 && h("span.pp-know.heard", { title: KNOWS[1] }, icon("message", 12)),
      p.guided > 0 && h("span.pp-know.guided", { title: `${p.guided} system message${p.guided === 1 ? "" : "s"} standing` }, icon("sparkle", 12)),
      h("i.dot", { class: live ? "st-active" : "st-idle" })));
}

export function mountPeople(panel) {
  let view = localGet("people") || "all";
  let query = "";
  const input = h("input.input", { type: "search", placeholder: "Find by either name, job or home", autocomplete: "off",
    spellcheck: "false", "aria-label": "Find a person", on: { input: e => { query = e.target.value; draw(); } } });
  const chipCounts = new Map();
  const chips = h("div.chips", VIEWS.map(([id, label]) => {
    const n = h("span.n");
    chipCounts.set(id, n);
    return h("button.chip", { type: "button", dataset: { id }, on: { click: () => { view = id; localSet("people", id); draw(); } } }, label, n);
  }));
  const tokenBox = h("div.pp-token");
  const list = h("div.list");
  panel.append(h("div.field", icon("search", 15), input), chips, tokenBox, list);

  function drawToken() {
    render(tokenBox, `${people.bad}|${!!readToken()}`, () => (people.bad || !readToken()) && h("label.pp-token-row",
      h("span", people.bad ? "The lore gate turned that token away." : "The People panel reads through the lore gate. Its token:"),
      h("input.input", { type: "password", autocomplete: "off", value: readToken(), placeholder: "Lore gate token",
        on: { change: e => { saveToken(e.target.value.trim()); refreshPeople(); } } })));
  }

  function draw() {
    drawToken();
    const all = people.list;
    if (!all) {
      for (const n of chipCounts.values()) n.textContent = "–";
      render(list, `none|${people.error}`, () => empty(people.error || "Reading the arrivals…", "users"));
      return;
    }
    for (const [id, fn] of Object.entries(FILTERS)) chipCounts.get(id).textContent = all.filter(fn).length;
    for (const b of chips.children) b.classList.toggle("on", b.dataset.id === view);
    const q = query.trim().toLowerCase();
    const match = p => !q || [p.name, p.earth, p.job, p.home].some(s => (s || "").toLowerCase().includes(q));
    const shown = all.filter(p => (FILTERS[view] || FILTERS.all)(p) && match(p));
    const sig = JSON.stringify([view, q, people.days, shown.map(p => [p.guid, p.level, p.said, p.guided, p.knows, where(p)])]);
    render(list, sig, () => [
      h("div.group-label", h("span", people.days == null ? "Arrivals" : `Day ${people.days + 1} since everyone woke`), h("span", shown.length)),
      shown.length ? shown.map(row) : empty(q ? `Nobody matching “${query.trim()}”.` : "Nobody fits this filter.", "users"),
    ]);
  }

  const tick = async () => {
    if (state.loreEdit?.people && (state.panel === "people" || state.personOpen)) await refreshPeople();
    setTimeout(tick, REFRESH_MS);
  };
  on("people snapshot", draw);
  on("panel loreEdit", () => { if (state.panel === "people" && state.loreEdit?.people && !people.list) refreshPeople(); });
  draw();
  tick();
}
