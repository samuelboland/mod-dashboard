// Inspector: the selected character (story, ties, details, pause/resume) or the selected company.
import { state, on, emit, localSet } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { CLASS_COLORS, clockS, signed, plural, capital } from "../lib/format.js";
import { activity, factionOf, raceClass, scoreClass, onAnyContinent, companyColor } from "../lib/world.js";
import { select, clearSelection, sendCommand } from "../actions.js";
import { loadTies, loadMemories } from "../api.js";
import { memoryRow } from "./memories.js";
import { avatar, who, companyLink, factionBadge, statePill, empty, kpis, dmeter, section } from "./common.js";
import { incident } from "./companies.js";

const closeBtn = () => h("button.icon-btn.close", { type: "button", title: "Close (Esc)", on: { click: clearSelection } }, icon("x", 16));

function tabs(items, current, onPick) {
  return h("div.tabs", { role: "tablist" }, items.map(([id, label, n]) =>
    h("button", { type: "button", role: "tab", class: id === current ? "on" : "", "aria-selected": String(id === current), on: { click: () => onPick(id) } },
      label, n ? h("span.n", n) : null)));
}

// ---- Character ----

function hero(p) {
  const r = state.lastResult?.guid === p.guid ? state.lastResult : null;
  return h("div.hero", { style: { "--cc": CLASS_COLORS[p.class] || "#7ddc6a" } },
    closeBtn(),
    h("div.hero-top", avatar(p, "lg"), h("div.hero-id", h("h2.hero-name", p.name), h("div.hero-sub", `Level ${p.level} ${raceClass(p)}`))),
    h("div.hero-tags",
      factionBadge(factionOf(p)),
      !p.bot ? h("span.badge.gold", icon("crown", 11), "Real player") : statePill(p),
      p.bot && p.active && !p.paused && h("span.pill", icon("compass", 12), activity(p)),
      p.mounted && h("span.pill", "Mounted")),
    h("div.hero-loc", icon("pin", 14), p.instance ? p.map_name : `${p.zone_name || "Unknown"}, ${p.map_name}`),
    h("div.hero-actions",
      p.bot && h("button.btn", { type: "button", class: p.paused ? "btn-go" : "btn-primary", disabled: state.busy || !state.conn.ok, on: { click: () => sendCommand(p.paused ? "resume" : "pause", p) } },
        icon(p.paused ? "play" : "pause", 14), state.busy ? "Working…" : p.paused ? "Resume" : "Pause"),
      onAnyContinent(p) && h("button.btn", { type: "button", on: { click: () => select(p.guid, true) } }, icon("locate", 14), "Show on map"),
      h("button.btn", { type: "button", title: "Everything they have done, in the order it happened",
        on: { click: () => emit("open-journey", { guid: p.guid }) } }, icon("route", 14), "Journey")),
    r && h("div.alert", { class: r.ok ? "ok" : "bad" }, icon(r.ok ? "check" : "alert", 14), h("span", r.text)));
}

function story(guid) {
  const l = state.lore?.[String(guid)];
  if (!l?.personality) return empty(state.lore ? "No story has been written for them yet." : "Loading their story…", "scroll");
  const block = (title, text, extra) => h("section", h("h4", title), h("p", text), extra);
  return h("div.lore",
    block("Who they are", l.personality),
    l.motivation_short && block("What drives them", l.motivation_short,
      (l.kind || l.target) && h("div.tagwrap", l.kind && h("span.tag", capital(l.kind)), l.target && h("span.tag", icon("compass", 11), l.target))),
    l.gist && block("Their story", l.gist));
}

function tieRow(name, guid, t) {
  return h("div.tie",
    h("div.tie-head", who(name, guid), h("span.score", { class: scoreClass(t.score) }, signed(t.score))),
    h("div.tie-words", capital(t.words.replace(/^you /, "")), h("span.muted", ` · ${plural(t.familiarity, "moment")}`)),
    dmeter(t.score),
    t.description && h("div.tie-desc", t.description));
}

// The world's own line, from RegardWords(): below it, "you feel little either way about them".
const FELT = 10;

// Every tie, strongest warmth first down to strongest coldness. The great middle of passing
// acquaintances -- a bot may have a hundred of them -- folds away where it belongs, between the two.
function tieList(list, nameOf, key) {
  const sorted = [...list].sort((a, b) => b.score - a.score);
  const felt = sorted.filter(t => Math.abs(t.score) >= FELT);
  const passing = sorted.filter(t => Math.abs(t.score) < FELT);
  const row = t => tieRow(...nameOf(t), t);
  const cold = felt.findIndex(t => t.score < 0);
  const cut = cold < 0 ? felt.length : cold;
  let fold = null;
  if (passing.length > 0) {
    fold = section("Passing acquaintances", { icon: "users", key: `ties.${key}`, open: false });
    fold.count(passing.length);
    fold.body.append(...passing.map(row));
    fold.el.classList.add("tie-fold");
  }
  return [felt.slice(0, cut).map(row), fold && fold.el, felt.slice(cut).map(row)];
}

function ties(guid) {
  const held = state.ties.get(guid);
  if (!held || !held.doc) return empty("Reading their ties…", "heart");
  const { feels, felt_by } = held.doc;
  if (!feels.length && !felt_by.length) return empty("No feelings recorded for them yet.", "heart");
  const all = feels.concat(felt_by);
  const warm = all.filter(t => t.score >= FELT).length, cold = all.filter(t => t.score <= -FELT).length;
  return h("div",
    kpis([["ties", all.length], ["warm", warm, warm ? "warm" : ""], ["cold", cold, cold ? "cold" : ""]]),
    feels.length > 0 && [h("div.sub-head", "How they feel about others", h("span.sect-count", feels.length)),
      tieList(feels, t => [t.about_name, t.about], "feels")],
    felt_by.length > 0 && [h("div.sub-head", "How others feel about them", h("span.sect-count", felt_by.length)),
      tieList(felt_by, t => [t.feeler_name, t.feeler], "felt")]);
}

// What this one bot still carries, heaviest first -- the order the module itself recalls them in, so the
// top of this list is what actually reaches their prompts.
function memories(guid) {
  const held = state.botMemories.get(guid);
  if (!held || !held.doc) return empty("Reading what they carry…", "book");
  const ms = held.doc.memories || [];
  if (!ms.length) return empty("They carry nothing yet.", "book");
  const name = held.doc.name || "";
  const defining = ms.filter(m => m[0] >= 9).length;
  return h("div",
    kpis([["memories", ms.length], ["defining", defining, defining ? "warm" : ""],
          ["avg weight", (ms.reduce((s, m) => s + m[0], 0) / ms.length).toFixed(1)]]),
    ms.map(m => memoryRow({ guid, name, importance: m[0], ts: m[1], text: m[2] })));
}

function details(p) {
  const leader = state.byGuid.get(p.group_leader);
  const master = state.byGuid.get(p.master);
  const flags = [p.paused && "paused", p.dead && "dead", p.combat && "in combat", p.flight && "flying", p.mounted && "mounted"].filter(Boolean);
  const rows = [
    ["Activity", activity(p)],
    ["State", flags.length ? capital(flags.join(", ")) : "—"],
    ["Where", p.instance ? p.map_name : `${p.zone_name} (${p.map_name})`],
    ["Group", !p.group_leader ? "—" : p.group_leader === p.guid ? "Leads their group" : leader ? ["Led by ", who(leader.name, leader.guid)] : `Leader #${p.group_leader}`],
    p.bot && ["Master", !p.master ? "—" : master ? who(master.name, master.guid) : `#${p.master}`],
    p.paused && ["Paused since", clockS(p.paused_since)],
    ["GUID", h("span.mono", p.guid)],
  ].filter(Boolean);
  const strat = (title, list) => list && list.length > 0 && h("div.strat", h("h4", title), h("div.tagwrap", list.map(s => h("span.tag", s))));
  return h("div.details",
    h("dl.kv", rows.map(([k, v]) => [h("dt", k), h("dd", v)])),
    p.paused && strat("Saved strategies", p.saved_strategies),
    strat("Strategies", p.strategies),
    strat("Combat strategies", p.combat_strategies));
}

function characterView(p) {
  const person = state.regard?.people[String(p.guid)];
  const tieCount = person ? person.n_feels + person.n_felt_by : 0;
  const memCount = state.memories?.counts?.[String(p.guid)] || 0;
  const tab = state.inspectorTab;
  const pick = id => { state.inspectorTab = id; localSet("itab", id); emit("selection"); };
  return [
    hero(p),
    tabs([["story", "Story"], ["ties", "Ties", tieCount], ["memories", "Memories", memCount], ["details", "Details"]], tab, pick),
    h("div.tab-body", tab === "ties" ? ties(p.guid) : tab === "memories" ? memories(p.guid)
      : tab === "details" ? details(p) : story(p.guid)),
  ];
}

function characterSig(p) {
  const lr = state.lastResult?.guid === p.guid ? `${state.lastResult.ok}${state.lastResult.text}` : "";
  const leader = state.byGuid.get(p.group_leader)?.name, master = state.byGuid.get(p.master)?.name;
  return ["c", p.guid, p.name, p.level, p.zone_name, p.map_name, p.instance, p.active, p.rpg, p.paused, p.dead, p.combat, p.flight, p.mounted,
    p.group_leader, leader, p.master, master, p.paused_since, (p.strategies || []).join(), (p.combat_strategies || []).join(), (p.saved_strategies || []).join(),
    state.busy, lr, state.inspectorTab, state.regard?.generated, !!state.lore,
    state.ties.get(p.guid)?.at, state.botMemories.get(p.guid)?.at, state.memories?.generated].join("|");
}

function goneView(guid) {
  const name = state.regard?.people[String(guid)]?.name || `Character #${guid}`;
  return [
    h("div.hero", closeBtn(), h("div.hero-top", h("span.avatar.lg", "?"), h("div.hero-id", h("h2.hero-name", name), h("div.hero-sub", "Not in the world right now"))),
      // Their record outlives their being online, and is the one thing still worth reading here.
      h("div.hero-actions",
        h("button.btn", { type: "button", on: { click: () => emit("open-journey", { guid }) } }, icon("route", 14), "Journey"))),
    h("div.tab-body", empty("They have left the world. They will show here again when they return.", "info")),
  ];
}

// ---- Company ----

function companyView(gid) {
  const co = state.companies;
  const c = co.companies[String(gid)];
  const rels = co.relations.filter(r => r.a === gid || r.b === gid).sort((a, b) => a.stance - b.stance);
  const land = z => co.lands[String(z)];
  const landChip = z => land(z) && h("button.tag", { type: "button", title: "Show on the map", on: { click: () => emit("focus-zone", z) } },
    land(z).name, h("span.n", `${land(z).levels[0]}–${land(z).levels[1]}`));
  const incidents = co.incidents.filter(i => i.a === gid || i.b === gid).slice(0, 10);

  const seats = section("Seats", { icon: "flag", flat: true });
  seats.count(c.seats.length);
  seats.body.append(...(c.seats.length ? c.seats.map(s => h("div.seat",
    h("div.seat-head", h("span.badge.gold", s.band), h("button.who", { type: "button", on: { click: () => emit("focus-zone", s.zone) } }, s.zone_name)),
    h("p", s.hold))) : [empty("No seats.", "flag")]));

  const lands = section("Lands", { icon: "map", flat: true });
  lands.count(c.holds.length + c.contests.length);
  lands.body.append(
    h("div.sub-head", "Holds"), c.holds.length ? h("div.tagwrap", c.holds.map(landChip)) : empty("Nothing yet.", "map"),
    c.contests.length > 0 && h("div.sub-head", "Contests"), c.contests.length > 0 && h("div.tagwrap", c.contests.map(landChip)));

  const relations = section("Other companies", { icon: "swords", flat: true });
  relations.count(rels.length);
  relations.body.append(...(rels.length ? rels.map(r => {
    const other = r.a === gid ? r.b : r.a;
    const says = r.a === gid ? r.a_says : r.b_says;
    return h("div.rel",
      h("div.rel-head", companyLink(other), h("span.badge", { class: scoreClass(r.stance) === "warm" ? "good" : scoreClass(r.stance) === "cold" ? "bad" : "", title: `seeded as ${r.disposition}` }, r.words),
        h("span.score", { class: scoreClass(r.stance) }, signed(r.stance))),
      dmeter(r.stance),
      r.origin && h("p", r.origin),
      says && h("blockquote.quote", `“${says}”`));
  }) : [empty("No dealings with other companies yet.", "swords")]));

  const recent = section("Recent incidents", { icon: "activity", flat: true });
  recent.count(incidents.length);
  recent.body.append(...(incidents.length ? incidents.map(incident) : [empty("Nothing has happened yet.", "activity")]));

  const warm = rels.filter(r => r.stance >= 10).length, cold = rels.filter(r => r.stance <= -10).length;
  return [
    h("div.hero", { style: { "--cc": companyColor(gid) } },
      closeBtn(),
      h("div.hero-top", h("span.co-mark", icon("shield", 26)), h("div.hero-id", h("h2.hero-name", c.name), h("div.hero-sub", "Company"))),
      h("div.hero-tags", factionBadge(c.faction), h("span.pill", plural(c.seats.length, "seat")))),
    h("div.tab-body", kpis([["holds", c.holds.length], ["contests", c.contests.length], ["friends", warm, warm ? "warm" : ""], ["foes", cold, cold ? "cold" : ""]])),
    seats.el, lands.el, relations.el, recent.el,
  ];
}

export function mountInspector(aside) {
  const inner = h("div.insp-inner");
  aside.append(inner);
  const app = document.getElementById("app");
  let shownKey = null;

  function draw() {
    const gid = state.selectedCompany;
    const company = gid != null && state.companies?.companies[String(gid)];
    const open = state.selected != null || !!company;
    app.classList.toggle("inspecting", open);
    if (!open) return;   // keep the old content while the drawer slides away

    const key = state.selected != null ? `c${state.selected}` : `g${gid}`;
    if (key !== shownKey) { shownKey = key; inner.scrollTop = 0; }
    if (state.selected != null) {
      if (state.inspectorTab === "ties") loadTies(state.selected);
      if (state.inspectorTab === "memories") loadMemories(state.selected);
      const p = state.byGuid.get(state.selected);
      if (!p) render(inner, `gone|${state.selected}|${state.regard?.generated}`, () => goneView(state.selected));
      else render(inner, `${state.conn.ok}|${characterSig(p)}`, () => characterView(p));
    } else {
      render(inner, `g|${gid}|${state.companies.generated}|${state.theme}`, () => companyView(gid));
    }
  }

  on("selection snapshot conn busy lore regard ties botmemories memories companies theme", draw);
}

