// Roster panel: search and filtered lists of everyone online.
import { state, on, localSet } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { CLASSES } from "../lib/format.js";
import { stateOf, STATE_LABEL, onContinent, elsewhere, where, describe } from "../lib/world.js";
import { select } from "../actions.js";
import { avatar, empty } from "./common.js";

const LIMIT = 150;
const VIEWS = [
  ["notable", "Notable"],
  ["here", "On this map"],
  ["combat", "In combat"],
  ["dead", "Dead"],
  ["all", "Everyone"],
];
const FILTERS = {
  here: onContinent,
  combat: p => p.combat,
  dead: p => p.dead,
  all: () => true,
};
const byName = (a, b) => a.name.localeCompare(b.name);

function row(p, sub) {
  const st = stateOf(p);
  return h("button.row", { type: "button", class: p.guid === state.selected ? "sel" : "", title: describe(p), on: { click: () => select(p.guid, true) } },
    avatar(p),
    h("span.row-main",
      h("span.row-name", { class: !p.bot ? "is-real" : p.paused ? "is-paused" : "" }, p.name),
      h("span.row-sub", `${p.level} ${CLASSES[p.class] || ""} · ${sub(p) || "—"}`)),
    h("span.row-end", { class: "st-" + st, title: STATE_LABEL[st] }, h("i.dot")));
}

export function mountRoster(panel) {
  const input = h("input.input", { type: "search", placeholder: "Find by name", autocomplete: "off", spellcheck: "false", "aria-label": "Find by name" });
  const chipCounts = new Map();
  const chips = h("div.chips", VIEWS.map(([id, label]) => {
    const n = h("span.n");
    chipCounts.set(id, n);
    return h("button.chip", { type: "button", dataset: { id }, on: { click: () => { state.rosterView = id; localSet("roster", id); draw(); } } }, label, n);
  }));
  const list = h("div.list");
  panel.append(h("div.field", icon("search", 15), input, h("span.kbd", "/")), chips, list);

  input.addEventListener("input", () => { state.query = input.value; draw(); });
  input.addEventListener("keydown", e => {
    if (e.key === "Escape" && input.value) { e.stopPropagation(); input.value = ""; state.query = ""; draw(); }
  });
  on("focus-search", () => { input.focus(); input.select(); });

  function draw() {
    if (!state.snap) {
      for (const n of chipCounts.values()) n.textContent = "–";
      render(list, `unavailable|${state.conn.text}`, () => empty(state.conn.text === "Connecting…" ? "Waiting for the realm." : "Realm unavailable. No live roster has been received."));
      return;
    }
    const players = state.players;
    const q = state.query.trim().toLowerCase();
    const match = p => !q || p.name.toLowerCase().includes(q);
    const view = (FILTERS[state.rosterView] || state.rosterView === "notable") ? state.rosterView : "notable";

    chipCounts.get("notable").textContent = players.filter(p => !p.bot || p.paused || elsewhere(p)).length;
    for (const [id, fn] of Object.entries(FILTERS)) chipCounts.get(id).textContent = players.filter(fn).length;
    for (const b of chips.children) b.classList.toggle("on", b.dataset.id === view);

    const groups = [];
    if (view === "notable") {
      if (q) groups.push(["Matches", players.filter(match).sort(byName), where]);
      groups.push(["Real players", players.filter(p => !p.bot), where]);
      groups.push(["Paused bots", players.filter(p => p.paused), where]);
      groups.push(["In instances and other maps", players.filter(elsewhere).sort((a, b) => a.map_name.localeCompare(b.map_name) || byName(a, b)), p => p.map_name]);
    } else {
      groups.push([VIEWS.find(([id]) => id === view)[1], players.filter(p => FILTERS[view](p) && match(p)).sort(byName), where]);
    }
    const shown = groups.filter(([, items]) => items.length);

    const sig = [view, q, state.selected, players.length > 0, ...shown.map(([title, items, sub]) =>
      title + items.length + ":" + items.slice(0, LIMIT).map(p => `${p.guid},${p.level},${stateOf(p)},${sub(p)}`).join(";"))].join("|");
    render(list, sig, () => shown.length
      ? shown.map(([title, items, sub]) => [
          h("div.group-label", h("span", title), h("span", items.length)),
          items.slice(0, LIMIT).map(p => row(p, sub)),
          items.length > LIMIT && h("div.more", `and ${items.length - LIMIT} more — narrow the search`),
        ])
      : empty(q ? `Nobody matching “${state.query.trim()}” is in the world.`
          : !players.length ? "Waiting for the first snapshot…"
          : view === "notable" ? "No real players, paused bots or instance runs right now. Try Everyone."
          : "Nobody fits this filter right now.", "users"));
  }

  on("snapshot conn selection continent", draw);
  draw();
}

