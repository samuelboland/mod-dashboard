// One character's journey, full screen: everything they have done, in the order it happened.
//
// The file behind it is written by regard.py (plans/42) and gathers five records that already existed
// separately -- mod-ledger's deeds and party lines, regard_log's moments both ways, bot_talk's
// conversations, and mod-ollama-chat's memories -- around one person. Nothing is scored here; this is
// the same material the Feelings, Groups and Memories panels show, laid out in time instead of by kind.
//
// #journey/<guid> in the address opens one on load, so a character's record can live in a tab of its
// own. A journey exists for characters who are offline too: it is a record of the past, and the
// dashboard's other views can only ever show who is in the world right now.
import { state, on, localGet } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { full, clock, num, plural, signed, capital, CLASSES, CLASS_COLORS, RACES } from "../lib/format.js";
import { scoreClass } from "../lib/world.js";
import { loadJourney } from "../api.js";
import { empty, kpis, avatar, factionBadge, who as whoLink } from "./common.js";
import { toast } from "./toast.js";
import { sayButton, voiceOpen, clipOf, hasVoice, onVoices, playAll, playingQueue, recordAll, exportSection, voicesOn, changeVoice, stop as stopVoices } from "./voice.js";

const HASH = "#journey";
const PAGE = 90;              // render-plan rows added each time the foot comes into view
const CHAPTER_GAP = 1800;     // a gap longer than this starts a new bout
const TALK_LINES = 12;        // a conversation shows this much before "read all of it"
const BUCKETS = 132;          // bars across the ribbon

// The story of a journey (plan 53). Writing one is slow, so it goes to the lore gate on its own port
// and answers with a job to watch -- mod-dashboard caps a body at 1024 bytes and never answers a
// preflight, which is why nothing that writes goes to :8787. The stories themselves are READ from
// the static /data mount, so a journey can be read back with no token at all.
const GATE = `${location.protocol}//${location.hostname}:8788`;
const JOB_POLL = 1500;
const ENDED_WORDS = {
  disband: "the company broke up",
  left: "they walked away from the company",
  kicked: "they were put out of the company",
  quiet: "the day went quiet",
};

// Horde races, for the faction badge: the journey file carries a race, not a team.
const HORDE = new Set([2, 5, 6, 8, 10]);

const KINDS = {
  deed:      { label: "Deeds",      icon: "swords",   color: "var(--gold)" },
  talk:      { label: "Talk",       icon: "message",  color: "var(--ink-2)" },
  feel:      { label: "Feelings",   icon: "heart",    color: "var(--warm)" },
  memory:    { label: "Memories",   icon: "book",     color: "var(--gold-hi)" },
  // "group" is a party, never a company: in this project a company is a guild (lib/groups.js says so).
  group:     { label: "Group",      icon: "users",    color: "var(--alliance)" },
  encounter: { label: "Encounters", icon: "sparkle",  color: "var(--paused)" },
  grind:     { label: "Fighting",   icon: "activity", color: "var(--line-3)" },
};
const KIND_IDS = Object.keys(KINDS);

// creature_template.rank, as the ledger records it.
const RANK_WORDS = { 1: "an elite", 2: "a rare elite", 3: "a world boss", 4: "a rare creature" };

const dayKey = ts => new Date(ts * 1000).toDateString();
const dayWords = ts => {
  const d = new Date(ts * 1000), today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
};
const span = (a, b) => a === b ? clock(a) : `${clock(b)}–${clock(a)}`;
const dayShort = ts => new Date(ts * 1000).toLocaleDateString([], { day: "numeric", month: "short" });
// A record that runs over days has to say so: "12:00 PM – 12:59 PM" across eight days of play reads
// as a single hour, which is what the header said before this.
const rangeWords = (a, b) => dayKey(a) === dayKey(b)
  ? `${dayShort(a)} · ${clock(a)}–${clock(b)}`
  : `${dayShort(a)} – ${dayShort(b)}`;

export function mountJourneyFull(root) {
  let guid = null;
  let back = null;             // focus to restore on close
  let query = "";
  let window_ = null;          // [from, to] chosen on the ribbon, or null for the whole span
  let kinds = new Set(KIND_IDS);
  let rows = [], steps = [], drawn = 0;
  let typing = null, dragging = null;
  const app = document.getElementById("app");

  // ---- chrome ----
  const whoBtn = h("button.jy-who-btn", { type: "button", title: "Read another character's journey",
    on: { click: e => { e.stopPropagation(); togglePicker(); } } }, icon("users", 14), h("span", "Choose a character"), icon("chevron", 13));
  const pickSearch = h("input.input.jy-pick-search", { type: "search", placeholder: "Find a character…",
    on: { input: () => drawPicker() } });
  const pickList = h("div.jy-pick-list");
  const picker = h("div.jy-pick", { hidden: true }, pickSearch, pickList);
  const whoWrap = h("div.jy-pick-wrap", whoBtn, picker);

  const filters = h("div.jy-filters");
  const search = h("input.input.jy-search", { type: "search", "aria-label": "Search this journey",
    placeholder: "Find a word, a name or a place…",
    on: { input: () => { clearTimeout(typing); typing = setTimeout(() => { rebuild(); }, 120); } } });
  const newTab = h("button.icon-btn", { type: "button", title: "Open in a new tab",
    on: { click: () => window.open(location.pathname + location.search + `${HASH}/${guid}`, "_blank", "noopener") } }, icon("external", 17));
  const close = h("button.icon-btn", { type: "button", title: "Close (Esc)", on: { click: hide } }, icon("x", 18));

  const head = h("div.jy-head");
  const ribbon = h("div.jy-ribbon", { title: "Drag across to read only that stretch of time" });
  const axis = h("div.jy-ribbon-axis");
  const ribbonWrap = h("div.jy-ribbon-wrap", ribbon, axis);

  const list = h("div.jy-list");
  const foot = h("div.jy-foot");
  const scroll = h("div.jy-scroll", list, foot);

  const storiesBtn = h("button.btn.jy-stories-btn", { type: "button", title: "The journeys they have lived, written up as stories",
    on: { click: () => toggleStories() } }, icon("book", 14), h("span", "Stories"));
  const storiesBox = h("div.jy-stories", { hidden: true });

  const overlay = h("div.jy-overlay", { role: "dialog", "aria-modal": "true", "aria-label": "A character's journey", tabindex: "-1", hidden: true },
    h("div.jy-bar",
      h("div.jy-bar-title", icon("route", 17), "Journey"),
      whoWrap, filters, search,
      h("div.jy-bar-end", storiesBtn, newTab, close)),
    head, storiesBox, ribbonWrap, scroll);
  root.append(overlay);

  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) grow(); }, { root: scroll, rootMargin: "700px" });

  // ---- the record being read ----
  const held = () => (guid == null ? null : state.journey.get(guid));
  const doc = () => held()?.doc || null;
  const index = () => state.journeys;
  const withJourney = () => new Set((index()?.people || []).map(p => p.guid));

  const nameOf = g => doc()?.names?.[String(g)] || state.byGuid.get(g)?.name || `#${g}`;
  // The ledger's zone id is the field that is always right; map_id is 0 on a third of the rows inside
  // a dungeon, so it is only ever a fallback. regard.py names every zone these records mention.
  const placeOf = e => index()?.places?.[String(e.zone)]
    || index()?.instances?.[String(e.map)]
    || (state.worldmap?.zones || []).find(z => z.zone === e.zone)?.name
    || "";

  // A name in the record leads to that character's own journey when they have one, and otherwise
  // behaves like every other name in the dashboard (the inspector, if they are in the world).
  const personLink = (g, label) => {
    const name = label || nameOf(g);
    if (!withJourney().has(g)) return whoLink(name, g);
    return h("button.who", { type: "button", title: `Read ${name}'s journey`,
      on: { click: e => { e.stopPropagation(); go(g); } } }, name);
  };

  // ---- searching ----
  function textOf(e) {
    switch (e.k) {
      case "deed": return [e.t, e.foe, e.title, e.item, placeOf(e)].filter(Boolean).join(" ");
      case "group": return ["group", e.t, placeOf(e), ...(e.with || []).map(nameOf)].join(" ");
      case "talk": return [placeOf(e), ...(e.with || []).map(nameOf), ...e.lines.map(l => `${nameOf(l[0])} ${l[2]}`)].join(" ");
      case "encounter": return [e.place, nameOf(e.other), ...e.lines.map(l => `${l[0]} ${l[1]}`)].join(" ");
      case "feel": return [nameOf(e.other), e.reason].join(" ");
      case "memory": return e.text;
      case "grind": return placeOf(e);
      default: return "";
    }
  }

  // ---- the render plan: days, bouts, entries ----
  function chapters(items) {
    const out = [];
    let cur = null;
    for (const e of items) {
      const place = placeOf(e);
      const day = dayKey(e.ts);
      if (!cur || day !== cur.day || cur.from - e.ts > CHAPTER_GAP || (place && cur.place && place !== cur.place)) {
        cur = { day, place, to: e.ts, from: e.ts, items: [], with: new Set() };
        out.push(cur);
      }
      cur.items.push(e);
      cur.from = e.ts;
      if (!cur.place) cur.place = place;
      for (const g of e.with || []) cur.with.add(g);
      if (e.k === "encounter" && e.other) cur.with.add(e.other);
      if (e.k === "feel" && e.other) cur.with.add(e.other);
    }
    return out;
  }

  function planOf(chs) {
    const perDay = new Map();
    for (const c of chs) perDay.set(c.day, (perDay.get(c.day) || 0) + c.items.length);
    const out = [];
    let day = null;
    for (const c of chs) {
      if (c.day !== day) { day = c.day; out.push({ type: "day", ts: c.to, n: perDay.get(day) }); }
      out.push({ type: "chapter", c });
      for (const e of c.items) out.push({ type: "entry", e });
    }
    return out;
  }

  // ---- drawing one entry ----
  function line(...kids) { return h("div.jy-line", ...kids); }

  function deedNode(e) {
    const bad = e.t === "death";
    let body, big = false;
    if (e.t === "kill") {
      const what = e.boss ? "a dungeon boss" : RANK_WORDS[e.rank] || "";
      big = !!e.boss || e.rank === 3;
      body = line("Slew ", h("b", e.foe || "something"), what && h("span.muted", ` · ${what}`));
    } else if (e.t === "death") {
      body = line(e.by ? ["Was killed by ", personLink(e.by)] : ["Fell to ", h("b", e.foe || "something")]);
    } else if (e.t === "quest_complete") {
      body = line("Finished ", h("b", e.title || "an errand"));
    } else if (e.t === "level_up") {
      big = true;
      body = line("Reached level ", h("b", String(e.new)), e.old ? h("span.muted", ` · from ${e.old}`) : null);
    } else if (e.t === "loot_item") {
      body = line("Took ", h("span.good", { class: "q" + (e.quality ?? 1) }, e.item || "something"),
        e.count > 1 ? h("span.muted", ` ×${e.count}`) : null);
    } else if (e.t === "zone_change") {
      const from = index()?.places?.[String(e.from)] || "";
      const to = index()?.places?.[String(e.to)] || "";
      body = line(h("span.muted", from && to ? `Travelled from ${from} to ${to}` : to ? `Came to ${to}` : "Travelled"));
    } else if (e.t === "pvp_kill") {
      big = true;
      body = line("Struck down ", e.by ? personLink(e.by) : h("b", "another character"));
    } else {
      body = line(capital(e.t.replace(/_/g, " ")));
    }
    return { body, big, extra: null, cls: bad ? "bad" : "" };
  }

  function groupNode(e) {
    const others = (e.with || []).filter(g => g !== guid);
    if (e.t === "join") {
      const led = e.leader === guid;
      return { big: others.length > 0, body: line(
        led ? "Formed a group" : "Joined a group",
        others.length ? [" with ", ...others.flatMap((g, i) => [i ? ", " : "", personLink(g)])] : h("span.muted", " — the ledger does not say with whom")) };
    }
    if (e.t === "kicked") return { cls: "bad", body: line("Was put out of the group", e.by ? [" by ", personLink(e.by)] : null) };
    if (e.t === "disband") return { body: line(h("span.muted", "The group broke up")) };
    return { body: line(h("span.muted", "Left the group")) };
  }

  function talkNode(e) {
    const others = (e.with || []).filter(g => g !== guid);
    const shown = e.lines.length > TALK_LINES ? e.lines.slice(-TALK_LINES) : e.lines;
    const body = h("div.jy-talk-body");
    const fill = all => {
      const use = all ? e.lines : shown;
      body.replaceChildren(...[
        !all && e.lines.length > use.length
          ? h("button.jy-talk-more", { type: "button", on: { click: () => fill(true) } },
              `Read all ${num(e.lines.length)} lines`)
          : null,
        ...use.map(([g, ts, text]) =>
          h("div.bubble", { class: g === guid ? "a" : "b", title: full(ts) },
            h("b", `${nameOf(g)} · ${clock(ts)}`, sayButton({ guid: g }, text)), text))].filter(Boolean));
    };
    fill(false);
    const block = h("div.jy-talk",
      h("div.jy-talk-head", icon("message", 13),
        others.length
          ? h("span", "With ", ...others.flatMap((g, i) => [i ? ", " : "", personLink(g)]))
          : h("span.muted", "Party chat — the ledger does not record who else stood there"),
        h("time.ts", { title: full(e.ts) }, span(e.until || e.ts, e.ts))),
      body);
    return { body: line(h("span.muted", `${plural(e.lines.length, "line")} in the party`)), extra: block };
  }

  function encounterNode(e) {
    const body = h("div.jy-talk-body",
      ...e.lines.map(([name, text]) =>
        h("div.bubble", { class: name === doc()?.name ? "a" : "b" }, h("b", name, sayButton({ name }, text)), text)));
    const moments = (e.moments || []).length
      ? h("div.moments", e.moments.map(m => h("div.moment",
          h("span.delta", { class: scoreClass(m.feels * 10) }, signed(m.feels)),
          h("span", `${m.target} ${m.feels > 0 ? "warmed to" : m.feels < 0 ? "cooled on" : "noted"} ${m.speaker}: ${m.why}`))))
      : null;
    const block = h("div.jy-talk",
      h("div.jy-talk-head", icon("sparkle", 13),
        h("span", "Fell to talking with ", personLink(e.other)),
        h("span.muted", e.place || ""),
        h("time.ts", { title: full(e.ts) }, clock(e.ts))),
      body, moments);
    return { body: line(h("span.muted", "A conversation no one overheard")), extra: block };
  }

  function feelNode(e) {
    const warm = e.delta > 0;
    const other = personLink(e.other);
    const body = e.dir === "in"
      ? line(other, h("span.muted", warm ? " warmed to them" : e.delta < 0 ? " cooled on them" : " noted them"),
          h("span.delta", { class: scoreClass(e.delta * 10) }, signed(e.delta)))
      : line(h("span.muted", warm ? "Warmed to " : e.delta < 0 ? "Cooled on " : "Noted "), other,
          h("span.delta", { class: scoreClass(e.delta * 10) }, signed(e.delta)));
    return { cls: warm ? "warm" : e.delta < 0 ? "cold" : "", body,
             text: e.reason, title: `now ${signed(e.score)} · ${e.source}` };
  }

  function entryNode(e) {
    let n;
    if (e.k === "deed") n = deedNode(e);
    else if (e.k === "group") n = groupNode(e);
    else if (e.k === "talk") n = talkNode(e);
    else if (e.k === "encounter") n = encounterNode(e);
    else if (e.k === "feel") n = feelNode(e);
    else if (e.k === "memory") n = { body: line(h("span.muted", `Remembered · weighed ${e.weight} of 10`)),
                                     extra: h("div.jy-mem", e.text) };
    else n = { body: line(h("span.muted", `Fought ${plural(e.n, "creature")}`)) };

    const row = h("div.jy-e", { class: [`k-${e.k}`, n.cls || "", n.big ? "big" : ""].filter(Boolean).join(" "),
                                title: n.title || "" },
      n.body,
      h("time.ts", { title: full(e.ts) }, clock(e.ts)),
      n.text ? h("div.jy-text", n.text) : null,
      n.extra ? h("div", { style: { "grid-column": "1 / 3" } }, n.extra) : null);
    return row;
  }

  function chapterNode(c) {
    const others = [...c.with].filter(g => g !== guid).slice(0, 5);
    const voice = h("span.jy-chapter-voice");
    const lines = voicesOn() ? spoken(c) : [];
    if (lines.length) { const v = { el: voice, c, lines }; voiceHeads.add(v); drawVoiceHead(v); }
    return h("div.jy-chapter-head",
      icon("pin", 12),
      h("span.jy-chapter-where", c.place || "Somewhere"),
      others.length ? h("span.jy-chapter-with", "with ", ...others.flatMap((g, i) => [i ? ", " : "", personLink(g)])) : null,
      voice,
      h("span.jy-chapter-when", span(c.to, c.from)));
  }

  // ---- a section read aloud (plan 57) ----
  //
  // Every line spoken in a section, oldest first: party talk carries a guid per line, a conversation no
  // one overheard only a name. Items arrive newest first; the lines inside a talk are already in order.
  let voiceHeads = new Set();
  let recording = null;       // the one section being recorded: the job recordAll reports
  const COST_PER_CHAR = 15 / 1e6;   // Fish S2.1 Pro through OpenRouter, $ per character
  function spoken(c) {
    const out = [];
    for (const e of [...c.items].reverse()) {
      if (e.k === "talk") for (const [g, ts, text] of e.lines) out.push({ who: { guid: g }, text, ts });
      else if (e.k === "encounter") for (const [name, text] of e.lines) out.push({ who: { name }, text, ts: e.ts });
    }
    return out;
  }
  function drawVoiceHead(v) {
    const done = v.lines.filter(l => clipOf(l.who, l.text)).length;
    const total = v.lines.length;
    const playing = playingQueue()?.items === v.lines;
    const unvoiced = new Set(v.lines.filter(l => !hasVoice(l.who)).map(l => l.who.name || nameOf(l.who.guid)));
    const count = h("span.jy-voice-count", { class: done === total ? "all" : "",
      title: done === total ? "Every line in this section is recorded"
        : `${num(total - done)} of ${num(total)} lines still to record`
          + (unvoiced.size ? ` · no voice yet: ${[...unvoiced].slice(0, 6).join(", ")}` : "") },
      icon("volume", 11), `${num(done)}/${num(total)}`);
    const rec = recording && recording.lines === v.lines ? recording : null;
    const left = v.lines.filter(l => !clipOf(l.who, l.text));
    const cost = left.reduce((a, l) => a + l.text.length, 0) * COST_PER_CHAR;
    const recordBtn = rec
      ? h("span.jy-voice-rec",
          icon("activity", 11),
          rec.stage === "cast" ? `Casting${rec.casting ? ` ${rec.casting}` : ""}…`
            : rec.stage === "record" ? `Recording ${num(rec.done + rec.failed)}/${num(rec.total)}…` : "Finishing…",
          h("button.chip", { type: "button", title: "Stop recording; what is recorded stays",
            on: { click: e => { e.stopPropagation(); rec.cancelled = true; drawVoiceHead(v); } } },
            rec.cancelled ? "Stopping…" : "Stop"))
      : done < total && h("button.chip.jy-voice-record", { type: "button", disabled: !!recording,
          title: `Record the ${num(left.length)} lines left, about $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}.`
            + (unvoiced.size ? ` First you cast a voice for: ${[...unvoiced].slice(0, 6).join(", ")}.` : ""),
          on: { click: async e => {
            e.stopPropagation();
            stopVoices();
            recording = { lines: v.lines, stage: "cast" };
            refreshVoiceHeads();
            await recordAll(v.lines, job => { recording = job; refreshVoiceHeads(); });
            recording = null;
            refreshVoiceHeads();
          } } },
          icon("volume", 11), "Record the rest");
    v.el.replaceChildren(...[count, recordBtn, !rec && done === total
      ? h("button.chip.jy-voice-play", { type: "button", class: playing ? "on" : "",
          title: playing ? "Stop" : "Play every line in this section, in order",
          on: { click: e => {
            e.stopPropagation();
            if (playingQueue()?.items === v.lines) return stopVoices();
            playAll(v.lines, () => refreshVoiceHeads());
            refreshVoiceHeads();
          } } },
          icon(playing ? "pause" : "play", 11), playing ? "Stop" : "Play all")
      : null,
      !rec && done === total ? h("button.chip.jy-voice-play", { type: "button", disabled: v.packing,
          title: "Download the section: every line as its own file, the whole thing as one track (as it "
            + "happened, and back to back), subtitles for both, and a manifest",
          on: { click: async e => {
            e.stopPropagation();
            v.packing = true; drawVoiceHead(v);
            const title = `${doc()?.name || ""} ${v.c.place || ""}`.trim();
            await exportSection(v.lines, title);
            v.packing = false; drawVoiceHead(v);
          } } },
          icon(v.packing ? "activity" : "download", 11), v.packing ? "Packing…" : "Download")
      : null].filter(Boolean));
  }
  function refreshVoiceHeads() {
    for (const v of voiceHeads) {
      if (!v.el.isConnected) { voiceHeads.delete(v); continue; }
      drawVoiceHead(v);
    }
  }
  let wasOn = voicesOn();
  onVoices(() => {
    if (voicesOn() !== wasOn) { wasOn = voicesOn(); if (!overlay.hidden) rebuild(); return; }
    refreshVoiceHeads();
    paintVoiceBtn();
  });

  // ---- building and paging ----
  function rebuild() {
    query = search.value.trim().toLowerCase();
    const d = doc();
    drawn = 0;
    voiceHeads = new Set();
    list.replaceChildren();
    if (!d) {
      const cur = held();
      list.append(empty(cur?.failed ? "That journey could not be read."
        : guid == null ? "Choose a character to read their journey."
        : "Reading their journey…", "route"));
      // Clear the rest too: without this, switching characters leaves the last one's name, ribbon
      // and filter counts standing over an empty column until their file lands.
      rows = []; steps = [];
      drawHead();
      drawRibbon();
      drawFilters();
      tail();
      return;
    }
    rows = d.entries.filter(e => kinds.has(e.k)
      && (!window_ || (e.ts >= window_[0] && e.ts <= window_[1]))
      && (!query || textOf(e).toLowerCase().includes(query)));
    steps = planOf(chapters(rows));
    if (!steps.length) {
      list.append(empty(query ? `Nothing in their journey matches “${search.value.trim()}”.`
        : window_ ? "Nothing happened in that stretch of time."
        : "Nothing of this kind is in their journey.", "route"));
    } else {
      grow();
    }
    drawHead();
    drawRibbon();
    drawFilters();
    tail();
    scroll.scrollTop = 0;
  }

  function grow() {
    if (drawn >= steps.length) return;
    const next = steps.slice(drawn, drawn + PAGE);
    const frag = document.createDocumentFragment();
    let chapter = null;
    for (const s of next) {
      if (s.type === "day") {
        chapter = null;
        frag.append(h("div.jy-day", dayWords(s.ts), h("span.n", plural(s.n, "entry", "entries"))));
      } else if (s.type === "chapter") {
        chapter = h("div.jy-chapter", chapterNode(s.c));
        frag.append(chapter);
      } else {
        (chapter || frag).append(entryNode(s.e));
      }
    }
    list.append(frag);
    drawn += next.length;
    tail();
  }

  function tail() {
    const left = steps.length - drawn;
    render(foot, `${guid}|${steps.length}|${drawn}|${query}|${window_ ? window_.join() : ""}`, () => left > 0
      ? h("button.btn.jy-more", { type: "button", on: { click: grow } },
          `Show more · ${num(rows.length)} entries in all`)
      : rows.length > 0 && h("div.jy-end", `That is all ${plural(rows.length, "entry", "entries")}.`));
  }

  // ---- the header ----
  // Their voice: "Change voice" once they have one (hear samples, keep a new one, re-record their lines),
  // "Give a voice" before. Kept outside render() so a new voice relabels it without rebuilding the header.
  const voiceBtn = h("button.chip.jy-voice-btn", { type: "button",
    on: { click: () => { const d = doc(); if (d) changeVoice({ guid: d.guid, name: d.name }); } } });
  function paintVoiceBtn() {
    const d = doc();
    voiceBtn.hidden = !d || !voicesOn();
    if (voiceBtn.hidden) return;
    const has = hasVoice({ guid: d.guid });
    voiceBtn.title = has ? `Hear samples of a new voice for ${d.name}, keep one, and re-record their lines`
      : `Give ${d.name} a voice`;
    voiceBtn.replaceChildren(icon("volume", 12), has ? "Change voice" : "Give a voice");
  }

  function drawHead() {
    const d = doc();
    // The button names whoever is being read. It is set here and not in go(), because when go() runs
    // neither the index nor their own file has necessarily arrived yet, and "#702" would stand for good.
    const known = (index()?.people || []).find(p => p.guid === guid);
    whoBtn.children[1].textContent = d?.name || known?.name || (guid == null ? "Choose a character" : `#${guid}`);
    if (!d) { head.replaceChildren(); return; }
    const c = d.counts || {};
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const companions = new Set();
    for (const e of d.entries) {
      for (const g of e.with || []) companions.add(g);
      if (e.other) companions.add(e.other);
    }
    companions.delete(d.guid);
    render(head, `${d.guid}|${d.kept}|${state.journeys?.generated}`, () => [
      h("div.jy-id", { style: { "--cc": CLASS_COLORS[d.cls] || "var(--gold)" } },
        avatar({ class: d.cls }, "lg"),
        h("div", h("div.jy-name-row", h("div.jy-name", d.name), voiceBtn),
          h("div.jy-sub", `Level ${d.level} ${RACES[d.race] || ""} ${CLASSES[d.cls] || ""}`.replace(/\s+/g, " ").trim()))),
      h("div.jy-tags",
        factionBadge(HORDE.has(d.race) ? "Horde" : "Alliance"),
        !d.bot && h("span.badge.gold", icon("crown", 11), "Real player"),
        d.guild_name && h("span.pill", icon("shield", 12), d.guild_name),
        h("span.pill", icon("clock", 12), rangeWords(d.first, d.last))),
      kpis([
        ["entries", num(d.kept)],
        ["deeds", num((c.deed || 0) + (c.grind || 0))],
        ["conversations", num((c.talk || 0) + (c.encounter || 0))],
        ["feelings", num(c.feel || 0)],
        ["memories", num(c.memory || 0)],
        ["companions", num(companions.size)],
      ]),
      paintVoiceBtn(),
      total > d.kept && h("div.jy-panel-note",
        `Showing the most recent ${num(d.kept)} of ${num(total)}: each kind is kept to its latest few hundred.`),
    ]);
  }

  // ---- the ribbon ----
  function drawRibbon() {
    const d = doc();
    if (!d) { ribbon.replaceChildren(); axis.replaceChildren(); return; }
    const from = d.first, to = d.last, width = Math.max(1, to - from);
    const counts = new Array(BUCKETS).fill(0);
    // Every entry of a chosen kind, whatever the window: the ribbon is how the window is chosen, so it
    // must go on showing the stretches that the current window leaves out.
    for (const e of d.entries) {
      if (!kinds.has(e.k)) continue;
      if (query && !textOf(e).toLowerCase().includes(query)) continue;
      counts[Math.min(BUCKETS - 1, Math.max(0, Math.floor((e.ts - from) / width * BUCKETS)))]++;
    }
    const max = Math.max(1, ...counts);
    const bars = counts.map((n, i) => {
      if (!n) return "";
      const hgt = Math.max(6, Math.sqrt(n / max) * 100);
      const at = from + (i + 0.5) / BUCKETS * width;
      const on = !window_ || (at >= window_[0] && at <= window_[1]);
      return `<rect class="jy-rb${on ? " on" : ""}" x="${i + 0.12}" y="${100 - hgt}" width="0.76" height="${hgt}"></rect>`;
    }).join("");
    const pct = ts => ((ts - from) / width) * 100;
    const veils = window_
      ? `<div class="jy-veil" style="left:0;width:${Math.max(0, pct(window_[0]))}%"></div>`
      + `<div class="jy-veil" style="left:${Math.min(100, pct(window_[1]))}%;right:0"></div>`
      + `<div class="jy-handle" style="left:${Math.max(0, pct(window_[0]))}%"></div>`
      + `<div class="jy-handle" style="left:${Math.min(100, pct(window_[1]))}%"></div>`
      : "";
    ribbon.innerHTML = `<svg viewBox="0 0 ${BUCKETS} 100" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>${veils}`;
    render(axis, `${window_ ? window_.join() : ""}|${from}|${to}`, () => window_
      ? [h("b", rangeWords(window_[0], window_[1])),
         h("button.chip", { type: "button", on: { click: () => { window_ = null; rebuild(); } } }, "Show the whole span")]
      : [h("span", dayShort(from)), h("span.muted", `${plural(rows.length, "entry", "entries")} · drag to narrow`), h("span", dayShort(to))]);
  }

  function tsAt(clientX) {
    const d = doc();
    const box = ribbon.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return d.first + f * Math.max(1, d.last - d.first);
  }
  ribbon.addEventListener("pointerdown", e => {
    if (!doc()) return;
    dragging = tsAt(e.clientX);
    ribbon.setPointerCapture(e.pointerId);
  });
  ribbon.addEventListener("pointermove", e => {
    if (dragging == null) return;
    const at = tsAt(e.clientX);
    window_ = [Math.min(dragging, at), Math.max(dragging, at)];
    drawRibbon();
  });
  ribbon.addEventListener("pointerup", e => {
    if (dragging == null) return;
    const at = tsAt(e.clientX);
    // A click rather than a drag clears the window instead of selecting a single instant.
    window_ = Math.abs(at - dragging) < Math.max(1, (doc().last - doc().first) / BUCKETS) ? null
      : [Math.min(dragging, at), Math.max(dragging, at)];
    dragging = null;
    rebuild();
  });

  // ---- filters ----
  function drawFilters() {
    const c = doc()?.counts || {};
    render(filters, `${guid}|${[...kinds].sort().join()}|${JSON.stringify(c)}`, () =>
      KIND_IDS.filter(id => c[id]).map(id => h("button.chip", {
        type: "button", class: kinds.has(id) ? "on" : "", style: { "--k": KINDS[id].color },
        title: `${KINDS[id].label}: ${num(c[id])}`,
        on: { click: () => {
          if (kinds.has(id) && kinds.size === 1) kinds = new Set(KIND_IDS);
          else if (kinds.has(id)) kinds.delete(id);
          else kinds.add(id);
          rebuild();
        } },
      }, h("i.dot"), KINDS[id].label, h("span.n", num(c[id])))));
  }

  // ---- the character picker ----
  function togglePicker() {
    picker.hidden = !picker.hidden;
    if (!picker.hidden) { pickSearch.value = ""; drawPicker(); pickSearch.focus(); }
  }
  function drawPicker() {
    const q = pickSearch.value.trim().toLowerCase();
    const people = (index()?.people || []).filter(p => !q || p.name.toLowerCase().includes(q)).slice(0, 120);
    render(pickList, `${q}|${people.length}|${guid}|${index()?.generated}`, () => people.length
      ? people.map(p => h("button.row", { type: "button", class: p.guid === guid ? "sel" : "",
          on: { click: () => { picker.hidden = true; go(p.guid); } } },
          avatar({ class: p.cls }),
          h("span.row-main",
            h("span.row-name", { class: p.bot ? "" : "is-real" }, p.name),
            h("span.row-sub", `Level ${p.level} ${CLASSES[p.cls] || ""}`)),
          h("span.row-end", plural(p.n, "entry", "entries"))))
      : empty(q ? `No journey for anyone called “${pickSearch.value.trim()}”.` : "No journeys have been written yet.", "route"));
  }
  document.addEventListener("click", e => {
    if (!picker.hidden && !whoWrap.contains(e.target)) picker.hidden = true;
  });

  // ---- the stories (plan 53) ----
  //
  // Two sources, deliberately. The legs -- every stretch this character actually lived -- are cut
  // from the ledger by the gate, because working out where a journey ended needs the whole record
  // and a rule ("a company breaking up, or three quarters of an hour of nothing"). The stories
  // already written are a plain file on the /data mount, so they can be read with no token.
  let storiesOpen = false, legs = null, legsFor = null, told = new Map(), opened = new Set();
  let job = null, poll = null, writing = null, legsError = "";

  const token = () => (localGet("loreToken") || "").trim();

  async function loadTold(g) {
    told = new Map();
    try {
      const res = await fetch(`data/journey-stories/${g}.json`, { cache: "no-store" });
      if (!res.ok) return;                       // no stories yet is the ordinary case, not an error
      const doc = await res.json();
      // floor, never round: a leg's start is a datetime(3) float straight off the ledger, while the
      // story keeps it in a DATETIME, which TRUNCATES. Rounding 1790258480.55 up to ...481 matches
      // no stored story, and the journey shows as unwritten while its story sits in the file.
      for (const s of doc.stories || []) told.set(Math.floor(s.start), s);
    } catch { /* the file is absent until the first story is written */ }
  }

  async function loadLegs(g) {
    legsError = "";
    if (!token()) { legs = []; legsFor = g; legsError = "token"; return; }
    try {
      const res = await fetch(`${GATE}/journey-legs?guid=${g}`, {
        headers: { "X-Lore-Token": token() }, cache: "no-store" });
      const doc = await res.json().catch(() => ({}));
      if (!doc.ok) { legs = []; legsError = doc.message || `HTTP ${res.status}`; }
      else { legs = doc.legs || []; }
    } catch (e) {
      legs = [];
      legsError = `The gate could not be reached: ${e.message}`;
    }
    legsFor = g;
  }

  async function refresh(g) {
    await Promise.all([loadTold(g), loadLegs(g)]);
    drawStories();
  }

  function toggleStories() {
    storiesOpen = !storiesOpen;
    storiesBox.hidden = !storiesOpen;
    storiesBtn.classList.toggle("on", storiesOpen);
    if (storiesOpen && guid != null && legsFor !== guid) { drawStories(); refresh(guid); }
    else if (storiesOpen) drawStories();
  }

  function writeStory(leg) {
    if (!token()) return toast({ ok: false, title: "No gate token",
      text: "Open the Lore panel and enter the gate token first." });
    writing = Math.floor(leg.start);
    job = { state: "running", steps: [], message: "" };
    drawStories();
    fetch(`${GATE}/journey-write`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Lore-Token": token() },
      body: JSON.stringify({ guid, start: leg.start }),
    }).then(r => r.json()).then(r => {
      if (!r.ok) { job = { state: "failed", steps: [], message: r.message || "It was refused." }; writing = null; drawStories(); return; }
      watchJob(r.job);
    }).catch(e => {
      job = { state: "failed", steps: [], message: `Could not reach the gate: ${e.message}` };
      writing = null;
      drawStories();
    });
  }

  function watchJob(id) {
    clearTimeout(poll);
    const tick = async () => {
      try {
        const res = await fetch(`${GATE}/job?id=${encodeURIComponent(id)}`, {
          headers: { "X-Lore-Token": token() }, cache: "no-store" });
        const r = await res.json();
        if (r.ok) job = r.job;
        drawStories();
        if (job && job.state === "running") { poll = setTimeout(tick, JOB_POLL); return; }
        // Done or failed: the story file has been rewritten, so read it back.
        const done = job && job.state === "done";
        if (done && writing) opened.add(writing);
        writing = null;
        if (done) { toast({ ok: true, title: "The story is written", text: job.message || "" }); await refresh(guid); }
        else { toast({ ok: false, title: "It could not be written", text: job?.message || "" }); drawStories(); }
      } catch {
        poll = setTimeout(tick, 3000);
      }
    };
    tick();
  }

  function storyNode(s) {
    return h("div.jy-story",
      h("div.jy-story-head", h("b", s.title),
        h("span.muted", `${plural(s.words, "word")} · ${plural(s.chapters?.length || 1, "part")}`
          + (s.version > 1 ? ` · written ${num(s.version)} times` : ""))),
      ...(s.chapters || []).map(c => h("div.jy-story-part",
        h("div.jy-story-where", icon("pin", 11), c.place || "Somewhere",
          c.company?.length ? h("span.muted", ` · with ${c.company.join(", ")}`) : null),
        ...String(c.prose || "").split(/\n\n+/).map(p => h("p", p)))),
      s.flag ? h("div.jy-story-flag", icon("alert", 12),
        h("span", `A reader of this age questioned something: ${s.flag}`)) : null);
  }

  function legNode(leg) {
    const key = Math.floor(leg.start);
    const s = told.get(key);
    const busy = writing === key;
    const isOpen = opened.has(key);
    const mins = Math.max(1, Math.round((leg.end - leg.start) / 60));
    return h("div.jy-leg", { class: s ? "told" : "" },
      h("div.jy-leg-main",
        h("div.jy-leg-line",
          h("b", leg.place || "Somewhere"),
          h("span.muted", ` · ${dayShort(leg.start)} ${clock(leg.start)} · ${plural(mins, "minute")}`)),
        h("div.jy-leg-sub",
          h("span.muted", `${plural(leg.deeds, "deed")}, until ${ENDED_WORDS[leg.ended] || leg.ended}`),
          leg.companions?.length
            ? h("span.muted", ` · with ${leg.companions.slice(0, 4).join(", ")}`
                + (leg.companions.length > 4 ? ` and ${num(leg.companions.length - 4)} more` : ""))
            : h("span.muted", " · alone"))),
      h("div.jy-leg-end",
        s && h("button.chip", { type: "button", class: isOpen ? "on" : "",
          on: { click: () => { isOpen ? opened.delete(key) : opened.add(key); drawStories(); } } },
          isOpen ? "Hide" : "Read"),
        h("button.btn", { type: "button", class: s ? "" : "btn-primary", disabled: !!writing,
          title: s ? "Write this journey again, from the same deeds" : "Write the story of this journey",
          on: { click: () => writeStory(leg) } },
          icon(busy ? "activity" : "book", 13),
          busy ? "Writing…" : s ? "Again" : "Write the story")),
      busy && job ? h("div.jy-leg-job",
        ...(job.steps || []).slice(-4).map(t => h("div.jy-step", t)),
        h("div.jy-step.working", icon("activity", 12), "Writing. This takes a minute.")) : null,
      s && isOpen ? storyNode(s) : null);
  }

  function drawStories() {
    if (!storiesOpen) return;
    const d = doc();
    if (guid == null) { storiesBox.replaceChildren(empty("Choose a character first.", "book")); return; }
    if (legs === null || legsFor !== guid) {
      storiesBox.replaceChildren(empty("Looking for the journeys they have lived…", "book"));
      return;
    }
    if (legsError === "token") {
      storiesBox.replaceChildren(h("div.jy-panel-note",
        "Stories are written by the lore gate, which wants its token. Open the Lore panel, enter it "
        + "there, and come back."));
      return;
    }
    if (legsError) {
      storiesBox.replaceChildren(h("div.jy-panel-note.bad", legsError));
      return;
    }
    if (!legs.length) {
      storiesBox.replaceChildren(empty(
        `${d?.name || "They"} has lived no journey long enough to be worth telling yet.`, "book"));
      return;
    }
    storiesBox.replaceChildren(
      h("div.jy-stories-head",
        h("span", plural(legs.length, "journey", "journeys"), " · ",
          h("span.muted", `${num(told.size)} written up`)),
        h("span.muted", "A journey runs until the company breaks up, or three quarters of an hour of nothing.")),
      h("div.jy-legs", ...legs.map(legNode)));
  }

  // ---- showing, hiding, choosing ----
  function go(next) {
    if (next == null) return;
    guid = Number(next);
    window_ = null;
    kinds = new Set(KIND_IDS);
    search.value = "";
    query = "";
    legs = null; legsFor = null; told = new Map(); opened = new Set();
    clearTimeout(poll); job = null; writing = null;
    loadJourney(guid);
    if (storiesOpen) { drawStories(); refresh(guid); }
    if (!overlay.hidden && location.hash !== `${HASH}/${guid}`) history.replaceState(null, "", `${HASH}/${guid}`);
    rebuild();
  }

  function show(opts) {
    const wanted = opts?.guid != null ? Number(opts.guid)
      : guid != null ? guid
      : state.selected != null ? state.selected
      : (index()?.people || [])[0]?.guid;
    if (overlay.hidden) {
      back = document.activeElement;
      overlay.hidden = false;
      if (app) app.inert = true;
      io.observe(foot);
      overlay.focus();
    }
    if (wanted == null) { guid = null; rebuild(); togglePickerOpen(); return; }
    go(wanted);
  }
  const togglePickerOpen = () => { picker.hidden = false; drawPicker(); };

  function hide() {
    if (overlay.hidden) return;
    stopVoices();
    overlay.hidden = true;
    picker.hidden = true;
    io.unobserve(foot);
    if (app) app.inert = false;
    if (location.hash.startsWith(HASH)) history.replaceState(null, "", location.pathname + location.search);
    back?.focus?.();
  }

  window.addEventListener("keydown", e => {
    if (overlay.hidden || voiceOpen()) return;   // the voice caster sits above the journey and has its own Escape
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (!picker.hidden) picker.hidden = true; else hide();
    }
  }, true);

  const parse = () => /^#journey(?:\/(\d+))?$/.exec(location.hash);
  const fromHash = () => {
    const m = parse();
    if (!m) return hide();
    show({ guid: m[1] ? Number(m[1]) : null });
  };
  window.addEventListener("hashchange", fromHash);

  // A newer file arrives only when the reader asks for it: refetching under them every cycle would
  // throw them back to the top of a thousand entries. Opening the journey again picks up a newer one.
  on("journey", g => { if (!overlay.hidden && g === guid) rebuild(); });
  on("journeys", () => { if (!overlay.hidden) { drawPicker(); if (guid != null) loadJourney(guid); } });
  on("open-journey", show);
  if (parse()) fromHash();
}
