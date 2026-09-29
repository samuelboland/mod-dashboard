// Rumours panel (chronicler.py's overheard.py): every story of the last few days, how each telling changed as
// it was carried along the roads, and the lines of chat where someone passed it on. The map draws the selected
// story's spread (mapview.js, "rumour-focus"); with none selected it shows where word is going around now.
//
// The chat evidence is inferred, not logged: mod-ollama-chat never records which rumour went into a prompt, so a
// line is matched against the tales going around where and when it was spoken. Beside each count the panel shows
// what the same matcher finds against tales that were NOT going around there -- the instrument's own noise.
import { state, on, emit, localGet, localSet } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { clock, num, plural } from "../lib/format.js";
import { section, who, time, empty, kpis, factionBadge } from "./common.js";

export const HOP_NAMES = ["Where it happened", "First stop", "Second stop", "Third stop"];
const TIER = { passed: "passed it on", echo: "echoed it" };
const SIDES = [["all", "Both"], ["A", "Alliance"], ["H", "Horde"]];
const SORTS = [["new", "Newest"], ["heard", "Most heard"], ["far", "Furthest"]];

// Small words a retelling shuffles without changing the tale; not worth underlining.
const SMALL = new Set(("a an the and but or of in on at to from by with for as is was were be been are it its his her their "
  + "they them he she we i you this that there here not no so if then than when who what which one more once again yet still "
  + "only all each some any into over out up down said say says").split(" "));

// Words as overheard.py compares them: lower case, a possessive is its owner.
const norm = w => w.toLowerCase().replace(/'s$/, "");
const tokens = s => s.split(/([A-Za-z][A-Za-z'-]+)/);

// The text with the given words picked out; `cls` names the <mark> they wear.
function marked(text, keep, cls) {
  return tokens(text).map((part, i) => i % 2 && keep(norm(part)) ? h(`mark.${cls}`, part) : part);
}

export function storyOf(root) {
  return state.rumours?.stories.find(s => s.root === root) || null;
}

export function setRumour(root) {
  state.rumourRoot = state.rumourRoot === root ? null : root;
  emit("rumour-focus");
}

const sideOk = s => state.rumourSide === "all" || (state.rumourSide === "H") === (s.team === 1);
const placeName = z => state.rumours?.places[String(z)]?.name || `land #${z}`;

function tellingRow(t, parent, lines) {
  const before = parent ? new Set(tokens(parent.words).filter((_, i) => i % 2).map(norm)) : null;
  return h("li.telling", { class: `hop${Math.min(t.hop, 3)}` },
    h("div.telling-head",
      h("span.hop-dot"),
      h("b", HOP_NAMES[Math.min(t.hop, 3)]),
      h("span.muted", ` · ${clock(t.told)}`),
      t.heard > 0 && h("span.badge.gold", { title: "Lines of chat that match this telling" }, `heard ${t.heard}×`)),
    h("p.telling-words", "“", before ? marked(t.words, w => !before.has(w) && !SMALL.has(w), "drift") : t.words, "”"),
    t.places.length > 0 && h("div.chips.telling-places", t.places.map(z =>
      h("button.chip", { type: "button", title: "Show on the map", on: { click: () => emit("focus-zone", z) } }, placeName(z)))),
    lines.length > 0 && h("div.telling-heard", lines.map(e => evidenceRow(e, false))));
}

function story(s, open) {
  const byId = new Map(s.tellings.map(t => [t.id, t]));
  const heardBy = new Map();
  for (const e of state.rumours.evidence) if (e.root === s.root) heardBy.set(e.tale, [...(heardBy.get(e.tale) || []), e]);
  const going = s.until * 1000 > Date.now();
  const el = h("details.card.rstory", { dataset: { key: String(s.root) }, open, class: s.team === 1 ? "horde" : "alliance" },
    h("summary",
      h("div.card-main",
        h("div.rstory-title", s.origin_name || "Somewhere", s.kind === "enemy" && h("span.muted", " · word of the other side")),
        h("div.rstory-words", s.tellings[0].words),
        h("div.card-sub",
          factionBadge(s.faction),
          ` ${plural(s.hops, "stop")} · ${plural(s.places.length, "place")}`,
          s.heard > 0 ? h("b.rstory-heard", ` · heard ${s.heard}×`) : "",
          going ? h("span.muted", " · going around now") : h("span.muted", ` · ${clock(s.told)}`))),
      icon("chevron", 14)),
    h("div.rstory-body",
      h("div.rstory-tools",
        h("button.btn", { type: "button", title: "Draw the spread again, stop by stop", on: { click: () => emit("rumour-replay") } }, icon("play", 13), "Replay"),
        h("span.muted", "Underlined: what changed in the retelling")),
      h("ol.tellings", s.tellings.map(t => tellingRow(t, byId.get(t.parent), heardBy.get(t.id) || [])))));
  // Opening a story puts it on the map; closing the one on the map clears it.
  el.addEventListener("toggle", () => {
    if (el.open && state.rumourRoot !== s.root) { state.rumourRoot = s.root; emit("rumour-focus"); }
    else if (!el.open && state.rumourRoot === s.root) { state.rumourRoot = null; emit("rumour-focus"); }
  });
  return el;
}

export function evidenceRow(e, withStory = true) {
  const keep = new Set([...e.names, ...e.words]);
  const s = withStory ? storyOf(e.root) : null;
  return h("div.tl", { class: withStory ? "click" : "", title: withStory ? "Show the story on the map" : null,
    on: withStory ? { click: () => { state.rumourRoot = e.root; emit("rumour-focus", { scroll: true }); } } : null },
    h("span.tl-icon", { class: e.tier === "passed" ? "warm" : "" }, icon("message", 14)),
    h("div.tl-line", who(e.name, e.guid), h("span.muted", ` ${TIER[e.tier]} in ${e.place || "the wilds"}`),
      withStory && s && h("span.muted", ` · from ${s.origin_name}`)),
    time(e.ts),
    h("div.tl-text", marked(e.text, w => keep.has(w), "hit")));
}

export function mountRumours(panel) {
  const meta = h("div.meta", icon("message", 13), "Waiting for the rumours…");
  const stats = h("div");
  const side = h("div.seg.full", SIDES.map(([id, name]) =>
    h("button", { type: "button", dataset: { s: id }, class: id === "H" ? "horde" : id === "A" ? "alliance" : "",
      on: { click: () => { state.rumourSide = id; localSet("rside", id); draw(); emit("rumour-focus"); } } }, name)));
  const sort = h("div.seg", SORTS.map(([id, name]) =>
    h("button", { type: "button", dataset: { s: id }, on: { click: () => { state.rumourSort = id; localSet("rsort", id); draw(); } } }, name)));
  const stories = section("Stories", { icon: "route", key: "r.stories" });
  const heard = section("Overheard passing it on", { icon: "message", key: "r.heard" });
  const note = h("p.rnote");
  panel.append(meta, stats, side, h("div.rsort", h("span.muted", "Order"), sort), stories.el, heard.el, note);

  function draw() {
    for (const b of side.children) b.classList.toggle("on", b.dataset.s === state.rumourSide);
    for (const b of sort.children) b.classList.toggle("on", b.dataset.s === state.rumourSort);
    const r = state.rumours;
    if (!r) return;
    const st = r.stats || {};
    meta.replaceChildren(icon("message", 13), `Last ${plural(Math.round((r.generated - r.since) / 86400), "day")} · updated ${clock(r.generated)}`);
    render(stats, `${r.generated}`, () => kpis([
      ["going around now", num(st.going_now || 0)],
      ["stories", num(r.stories.length)],
      ["passed on", num(st.passed || 0), "warm"],
      ["echoed", num(st.echo || 0)]]));

    const list = r.stories.filter(sideOk);
    const order = { new: (a, b) => b.told - a.told, heard: (a, b) => b.heard - a.heard || b.told - a.told,
                    far: (a, b) => b.places.length - a.places.length || b.told - a.told }[state.rumourSort] || (() => 0);
    list.sort(order);
    stories.count(list.length);
    render(stories.body, `${r.generated}|${state.rumourSide}|${state.rumourSort}|${state.rumourRoot}`, () =>
      list.length ? list.slice(0, 80).map(s => story(s, s.root === state.rumourRoot)) : empty("No stories going around yet.", "route"));

    const lines = r.evidence.filter(e => { const s = storyOf(e.root); return s && sideOk(s); });
    heard.count(lines.length);
    render(heard.body, `${r.generated}|${state.rumourSide}`, () =>
      lines.length ? lines.slice(0, 60).map(e => evidenceRow(e)) : empty("Nobody has been heard passing word on yet.", "message"));

    const c = st.chance || {};
    note.textContent = `How this is known: nothing logs which rumour reached a bot, so each line of chat is matched against the tales `
      + `going around where and when it was spoken, on their rarest words (names above all; a land's or a company's name counts for nothing). `
      + `“Passed it on” says so (“rumour says”, “I heard”); “echoed it” repeats a tale's names away from where it happened. `
      + `The same test run against tales that were not going around there finds ${c.passed ?? 0} and ${c.echo ?? 0} — that much is chance. `
      + `${num(st.in_reach || 0)} of ${num(st.lines || 0)} lines were spoken with a rumour in reach.`;
  }

  on("rumours", draw);
  on("rumour-focus", opts => {
    draw();
    if (opts?.scroll) stories.body.querySelector(`details[data-key="${state.rumourRoot}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  draw();
}
