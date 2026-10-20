// One arrival, full screen (isekai realms; services/lore/guidance.py): who they were back home, what drives
// them, what they have said and felt and remember, how the word about the game reached them -- and a way to
// reach them: a system message, a window only they can see, from no named sender.
//
// A message is a draft first. The gate writes the window, how this person takes it and what it changes, and
// stores nothing; sending takes the draft the gate wrote (by id, never text posted back), and every sent
// message can be taken back.
import { state, on, emit } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { CLASSES, RACES, CLASS_COLORS, stamp, full, signed, capital } from "../lib/format.js";
import { scoreClass } from "../lib/world.js";
import { select } from "../actions.js";
import { avatar, section, empty, dmeter } from "./common.js";
import { people, gateGet, gatePost, refreshPeople, KNOWS } from "./people.js";

const HASH = "#person";
// Element.append stringifies an array, and the sections below hand over lists and gaps; this flattens them.
const put = (el, ...xs) => el.append(...xs.flat(Infinity).filter(x => x != null && x !== false && x !== true));
const REFRESH_MS = 30000;
const JOB_MS = 2500;

const KINDS = [
  ["goal", "What drives them", "A new aim: who or what they go after now."],
  ["know", "Something to know", "A fact, a hint or a rumour they now carry."],
  ["feel", "How they feel", "Warmer or colder toward someone here."],
  ["free", "Anything", "Say what you want; the system decides what it changes."],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([id, label]) => [id, label]));
const PLACEHOLDER = {
  goal: "e.g. She should go looking for other people from California. Someone in Thunder Bluff is collecting names.",
  know: "e.g. Tell him the old innkeeper in Goldshire has seen strangers like him before.",
  feel: "e.g. Make her trust Basca a little more; Basca has been looking out for her.",
  free: "e.g. He's been hiding in town for days. Give him a reason to go out, and a hint that the way home is real.",
};

// Who they were, from the facts drawn for them (people.py), in the order a person would tell it.
const FACTS = [
  ["Back home", o => [o.age, o.job].filter(Boolean).join(", ")],
  ["From", o => [o.place_kind, o.home].filter(Boolean).join(" in ")],
  ["Life", o => o.life],
  ["Thinks of most", o => o.left_behind && `${o.left_behind.name}, ${o.left_behind.age} (${o.left_behind.relation})`],
  ["When it happened", o => [o.moment, o.unfinished].filter(Boolean).join("; ")],
  ["Who they are", o => (o.personality || []).join("; ")],
  ["Faith", o => o.faith],
  ["Loved", o => o.hobby],
  ["Talks", o => o.speech],
  ["Games", o => o.gaming],
  ["Misses", o => o.misses],
  ["Afraid of", o => o.fear],
  ["Taking it", o => o.coping],
  ["Doing about it", o => o.stance],
];

export function mountPerson(root) {
  let guid = null;
  let doc = null;          // GET /person
  let error = "";
  let back = null;
  let timer = 0;
  // The message being written, kept per person so a refresh never loses what was typed.
  const forms = new Map();
  const form = () => {
    if (!forms.has(guid)) forms.set(guid, { kind: "free", text: "", busy: false, draft: null, job: null, error: "" });
    return forms.get(guid);
  };
  const app = document.getElementById("app");

  const title = h("div.jy-bar-title", icon("eye", 17), "Following");
  const close = h("button.icon-btn", { type: "button", title: "Close (Esc)", on: { click: hide } }, icon("x", 18));
  const prev = h("button.icon-btn", { type: "button", title: "The person before", on: { click: () => step(-1) } }, icon("left", 17));
  const next = h("button.icon-btn", { type: "button", title: "The person after", on: { click: () => step(1) } }, icon("right", 17));
  const head = h("div.ps-head");
  // The message box is drawn apart from the rest, so a refresh that brings a new line of talk never rebuilds
  // the box someone is typing in.
  const guideBox = h("div.ps-guide");
  const rest = h("div.ps-rest");
  const body = h("div.ps-body", guideBox, rest);
  const overlay = h("div.jy-overlay.ps-overlay", { role: "dialog", "aria-modal": "true", "aria-label": "One person, followed closely", tabindex: "-1", hidden: true },
    h("div.jy-bar", title, h("div.jy-bar-end", prev, next, close)),
    h("div.ps-scroll", head, body));
  root.append(overlay);

  function step(d) {
    const list = people.list || [];
    const i = list.findIndex(p => p.guid === guid);
    if (!list.length) return;
    go(list[(i + d + list.length) % list.length].guid);
  }

  async function load() {
    if (guid == null) return;
    const want = guid;
    try {
      const res = await gateGet(`/person?guid=${want}`);
      if (want !== guid) return;
      if (res.ok) { doc = res.person; doc.canGuide = res.guidance; error = ""; }
      else error = res.message || "The gate said no.";
    } catch {
      error = "The lore gate did not answer.";
    }
    draw();
  }

  function go(g) {
    guid = Number(g);
    doc = null;
    error = "";
    overlay.querySelector(".ps-scroll").scrollTop = 0;
    if (location.hash !== `${HASH}/${guid}`) history.replaceState(null, "", `${HASH}/${guid}`);
    draw();
    load();
  }

  function show(opts) {
    if (overlay.hidden) {
      back = document.activeElement;
      overlay.hidden = false;
      state.personOpen = true;
      if (app) app.inert = true;
      overlay.focus();
      if (!people.list) refreshPeople();
      const tick = () => { if (!overlay.hidden) { load(); timer = setTimeout(tick, REFRESH_MS); } };
      clearTimeout(timer);
      timer = setTimeout(tick, REFRESH_MS);
    }
    go(opts?.guid ?? guid ?? state.selected ?? people.list?.[0]?.guid);
  }

  function hide() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    state.personOpen = false;
    clearTimeout(timer);
    if (app) app.inert = false;
    if (location.hash.startsWith(HASH)) history.replaceState(null, "", location.pathname + location.search);
    back?.focus?.();
  }

  // ---- drawing ----

  function draw() {
    const p = doc;
    render(head, JSON.stringify([guid, p && [p.name, p.level, p.guild, p.online, p.knows, p.told_by], error, people.bad,
      state.byGuid.get(guid)?.zone_name]), () => {
      if (!p) return h("div.ps-id", error ? empty(people.bad ? "The lore gate turned the token away. Set it in the People panel." : error, "alert")
        : empty("Reading them…", "eye"));
      const o = p.origin || {};
      const live = state.byGuid.get(p.guid);
      return h("div.ps-id", { style: { "--cc": CLASS_COLORS[p.class] || "var(--gold)" } },
        avatar(p, "lg"),
        h("div.ps-id-main",
          h("div.ps-name", p.name, o.earth_name && h("span.ps-earth", ` · ${o.earth_name}`)),
          h("div.ps-sub", `Level ${p.level} ${RACES[p.race] || ""} ${CLASSES[p.class] || ""}`
            + (p.guild ? ` · ${p.guild}` : "") + ` · day ${p.days + 1} here`),
          h("div.ps-sub", icon("pin", 12), live ? (live.instance ? live.map_name : `${live.zone_name || "?"}, ${live.map_name}`) : "Not in the world right now"),
          h("div.ps-tags",
            h("span.pill", { class: p.knows >= 2 ? "ps-played" : p.knows === 1 ? "ps-heard" : "" },
              icon(p.knows ? "key" : "eye", 12), KNOWS[p.knows] + (p.knows === 1 && p.told_by ? ` (from ${p.told_by})` : "")),
            p.written_by && h("span.pill.ps-muted", { title: "The model that wrote their story" }, icon("feather", 12), p.written_by.split("/").pop()))),
        h("div.ps-actions",
          live && h("button.btn", { type: "button", on: { click: () => { hide(); select(p.guid, true); } } }, icon("locate", 14), "Show on map"),
          h("button.btn", { type: "button", on: { click: () => { hide(); emit("open-journey", { guid: p.guid }); } } }, icon("route", 14), "Journey")));
    });
    const f = form();
    render(guideBox, JSON.stringify([guid, !!p, p?.canGuide, p?.goal, f.kind, f.busy, f.draft, f.job, f.error]),
      () => p ? guide(p) : null);
    render(rest, JSON.stringify([guid, p, error, !!f.job]), () => p ? [
      sent(p),
      drives(p),
      whoTheyWere(p),
      story(p),
      said(p),
      feelings(p),
      remembers(p),
      word(p),
    ] : null);
  }

  // A system window as the person sees it.
  const windowBox = (words, small) => h("div.sys-window", { class: small ? "small" : "" },
    h("div.sys-head", icon("info", small ? 11 : 13), "SYSTEM"), h("div.sys-words", words));

  function guide(p) {
    const f = form();
    const s = section("Send a system message", { icon: "sparkle", key: "ps.guide" });
    if (!p.canGuide) {
      put(s.body, h("p.ps-note", "Sending is off on this realm. GUIDANCE_ENABLED=1 in site.env turns it on."));
      return s.el;
    }
    const text = h("textarea.input.ps-text", { rows: 3, placeholder: PLACEHOLDER[f.kind], disabled: f.busy || !!f.draft,
      on: { input: e => { f.text = e.target.value; } } });
    text.value = f.text;
    const kinds = h("div.chips.ps-kinds", KINDS.map(([id, label, hint]) =>
      h("button.chip", { type: "button", class: f.kind === id ? "on" : "", title: hint, disabled: f.busy || !!f.draft,
        on: { click: () => { f.kind = id; draw(); } } }, label)));
    put(s.body, 
      h("p.ps-note", "Say what you want to happen, in your own words. The system turns it into a window only they can see, from no sender, and shows you how they would take it before anything is sent."),
      kinds, text);
    if (!f.draft) {
      put(s.body, h("div.ps-row",
        h("button.btn.btn-primary", { type: "button", disabled: f.busy, on: { click: () => write(f) } },
          icon("feather", 14), f.busy ? "Writing the window…" : "Write the window")));
    } else {
      const d = f.draft;
      put(s.body, h("div.ps-draft",
        windowBox(d.notice),
        h("div.ps-k", "How they take it"), h("p.ps-prose", d.reaction),
        changes(d, p),
        f.job ? h("div.alert", { class: f.job.state === "failed" ? "bad" : "ok" }, icon(f.job.state === "running" ? "clock" : f.job.state === "failed" ? "alert" : "check", 14),
          h("span", f.job.state === "running" ? (f.job.steps?.slice(-1)[0] || "Sending…") : f.job.message))
          : h("div.ps-row",
            h("button.btn.btn-go", { type: "button", on: { click: () => send(f) } }, icon("check", 14), "Send it"),
            h("button.btn", { type: "button", on: { click: () => { f.draft = null; write(f); } } }, icon("feather", 14), "Write it again"),
            h("button.btn", { type: "button", on: { click: () => { f.draft = null; f.error = ""; draw(); } } }, icon("x", 14), "Change my words"))));
    }
    if (f.error) put(s.body, h("div.alert.bad", icon("alert", 14), h("span", f.error)));
    return s.el;
  }

  function changes(d, p) {
    const out = [];
    if (d.goal) out.push(h("div.ps-k", "What drives them, from now on"),
      p.goal && h("p.ps-prose.ps-was", p.goal), h("p.ps-prose", d.goal.short));
    if (d.know) out.push(h("div.ps-k", "What they now know"), h("p.ps-prose", d.know));
    if (d.feel?.length) out.push(h("div.ps-k", "How they feel"), d.feel.map(f =>
      h("div.ps-feel", h("b", f.name), h("span.delta", { class: scoreClass(f.change * 4) }, `${f.change > 0 ? "warmer" : "colder"} by ${Math.abs(f.change)}`),
        h("span.ps-aside", f.aside))));
    return out;
  }

  async function write(f) {
    if (!f.text.trim()) { f.error = "Write what the window should achieve first."; draw(); return; }
    const g = guid;
    f.busy = true; f.error = ""; draw();
    try {
      const res = await gatePost("/guide-draft", { guid: g, kind: f.kind, text: f.text });
      if (res.ok) f.draft = res.draft; else f.error = res.message || "The gate said no.";
    } catch {
      f.error = "The lore gate did not answer.";
    }
    f.busy = false;
    if (g === guid) draw();
  }

  async function follow(f, jobId, after) {
    const g = guid;
    try {
      const res = await gateGet(`/job?id=${encodeURIComponent(jobId)}`);
      if (res.ok) f.job = res.job;
    } catch { /* try again */ }
    if (f.job?.state === "running") { setTimeout(() => follow(f, jobId, after), JOB_MS); }
    else { after(); refreshPeople(); }
    if (g === guid) { draw(); if (f.job?.state !== "running") load(); }
  }

  async function send(f) {
    try {
      const res = await gatePost("/guide-send", { draft: f.draft.id });
      if (!res.ok) { f.error = res.message; f.draft = null; draw(); return; }
      f.job = { state: "running", steps: ["Sending…"] };
      draw();
      follow(f, res.job, () => {
        if (f.job?.state === "done") { f.text = ""; setTimeout(() => { f.draft = null; f.job = null; draw(); }, 4000); }
      });
    } catch {
      f.error = "The lore gate did not answer.";
      draw();
    }
  }

  async function takeBack(m) {
    if (!confirm(`Take back the window you sent ${doc?.name || "them"}? It leaves their story, and what it changed goes back as far as it can.`)) return;
    const f = form();
    try {
      const res = await gatePost("/guide-takeback", { id: m.id });
      if (!res.ok) { f.error = res.message; draw(); return; }
      f.job = { state: "running", steps: ["Taking it back…"] };
      draw();
      follow(f, res.job, () => setTimeout(() => { f.job = null; draw(); }, 4000));
    } catch {
      f.error = "The lore gate did not answer.";
      draw();
    }
  }

  function sent(p) {
    const list = p.guidance || [];
    const s = section("Messages sent", { icon: "message", key: "ps.sent", open: list.length > 0 });
    s.count(list.filter(m => m.state === "sent").length || null);
    put(s.body, list.length ? list.map(m => {
      const plan = typeof m.plan === "string" ? JSON.parse(m.plan) : m.plan || {};
      const gone = m.state !== "sent";
      return h("div.ps-msg", { class: gone ? "gone" : "" },
        h("div.ps-msg-head", h("span.pill", KIND_LABEL[m.kind] || m.kind), h("time.ts", { title: full(m.at) }, stamp(m.at)),
          gone ? h("span.ps-muted", `taken back ${m.taken_back_at ? stamp(m.taken_back_at) : ""}`)
            : h("button.btn.ps-small", { type: "button", disabled: !p.canGuide || !!form().job, on: { click: () => takeBack(m) } }, icon("x", 12), "Take back")),
        windowBox(m.notice, true),
        plan.reaction && h("p.ps-prose.ps-small-prose", plan.reaction),
        h("div.ps-asked", h("span.ps-k", "You wrote"), " ", m.asked));
    }) : empty("Nothing sent yet.", "message"));
    return s.el;
  }

  function drives(p) {
    const s = section("What drives them", { icon: "compass", key: "ps.drives" });
    const target = p.goal_target && (typeof p.goal_target === "string" ? JSON.parse(p.goal_target) : p.goal_target);
    put(s.body, p.goal ? [h("p.ps-prose", p.goal),
      h("div.tagwrap", p.goal_kind && h("span.tag", capital(p.goal_kind)), target?.name && h("span.tag", icon("compass", 11), target.name)),
      p.goal_long && p.goal_long !== p.goal && h("p.ps-prose.ps-small-prose", p.goal_long)] : empty("Nothing written yet.", "compass"));
    return s.el;
  }

  function whoTheyWere(p) {
    const o = p.origin || {};
    const s = section(o.earth_name ? `Who ${o.earth_name} was` : "Who they were", { icon: "users", key: "ps.who" });
    const rows = FACTS.map(([k, fn]) => [k, fn(o)]).filter(([, v]) => v);
    put(s.body, rows.length ? h("dl.ps-facts", rows.map(([k, v]) => [h("dt", k), h("dd", v)])) : empty("No drawn life for them.", "users"));
    return s.el;
  }

  function story(p) {
    const s = section("Their story", { icon: "book", key: "ps.story" });
    const notes = p.notes || [];
    put(s.body, 
      p.personality && h("p.ps-prose", p.personality),
      p.gist && h("p.ps-prose", p.gist),
      p.kin && [h("div.ps-k", "Their people"), h("p.ps-prose", p.kin)],
      p.craft && [h("div.ps-k", "Their trade"), h("p.ps-prose", p.craft)],
      notes.length > 0 && [h("div.ps-k", "Added since it was written"), notes.map(n =>
        h("p.ps-prose.ps-small-prose", { class: n.source === "guidance" ? "ps-from-system" : "" }, n.note))],
      p.backstory && h("details.ps-more", h("summary", "The whole story"), p.backstory.split(/\n+/).map(t => h("p.ps-prose", t))));
    return s.el;
  }

  function said(p) {
    const lines = p.chat || [];
    const s = section("What they've said, and heard", { icon: "message", key: "ps.said" });
    s.count(lines.length || null);
    put(s.body, lines.length ? h("div.ps-chat", lines.map(l =>
      h("div.ps-line", { class: l.from === p.guid ? "mine" : "" },
        h("div.ps-line-head", h("b", l.who), l.from !== p.guid && l.to === p.guid && h("span.ps-muted", " to them"),
          l.channel && h("span.ps-muted", ` · ${l.channel}`), h("time.ts", { title: full(l.at) }, stamp(l.at))),
        h("div", l.text))))
      : empty("Nothing said yet, or the ledger has not caught it.", "message"));
    return s.el;
  }

  function feelings(p) {
    const s = section("How they feel", { icon: "heart", key: "ps.feel" });
    const tie = (t, mine) => h("div.tie",
      h("div.tie-head", h("b", t.name), h("span.score", { class: scoreClass(t.score) }, signed(t.score))),
      dmeter(t.score),
      t.words && h("div.tie-desc", t.words),
      mine && t.aside && h("div.tie-desc.ps-from-system", t.aside));
    put(s.body, 
      (p.feels || []).length ? (p.feels || []).map(t => tie(t, true)) : empty("No feelings about anyone yet.", "heart"),
      (p.felt_by || []).length > 0 && [h("div.ps-k", "How others feel about them"), p.felt_by.map(t => tie(t, false))]);
    return s.el;
  }

  function remembers(p) {
    const list = p.memories || [];
    const s = section("What they remember", { icon: "feather", key: "ps.mem", open: false });
    s.count(list.length || null);
    put(s.body, list.length ? list.map(m => h("div.ps-mem", h("span", m.text), h("time.ts", { title: full(m.at) }, stamp(m.at))))
      : empty("Nothing remembered yet.", "feather"));
    return s.el;
  }

  function word(p) {
    const list = p.word || [];
    const s = section("Word of the game", { icon: "key", key: "ps.word", open: false });
    put(s.body, h("p.ps-note", KNOWS[p.knows] + "."),
      list.length ? list.map(e => h("div.ps-mem", h("span", `${e.teller || "Someone"} told ${e.learner} (${e.evidence})`), h("time.ts", { title: full(e.at) }, stamp(e.at))))
        : h("p.ps-note", "They have not passed it on, or heard it, from anyone yet."));
    return s.el;
  }

  window.addEventListener("keydown", e => {
    if (overlay.hidden) return;
    if (e.key === "Escape" && !e.target.closest("textarea, input")) { e.preventDefault(); e.stopPropagation(); hide(); }
  }, true);

  const parse = () => /^#person(?:\/(\d+))?$/.exec(location.hash);
  const fromHash = () => { const m = parse(); if (!m) return hide(); show({ guid: m[1] ? Number(m[1]) : null }); };
  window.addEventListener("hashchange", fromHash);
  on("open-person", show);
  on("people", () => { if (!overlay.hidden && !doc) load(); });
  if (parse()) fromHash();
}
