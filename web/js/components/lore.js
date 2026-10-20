// Lore panel (lore_gate.py, plans 28 and 21): a player writes their own characters' lore, and the world
// checks it. The gate lives on its own port because this server caps bodies at 1024 bytes and never
// answers a preflight.
//
// Two flows live here. An existing character is EDITED: write, check, keep. A new alt has to be BROUGHT IN
// first - a tie to the main, a turn of speech, and a story built around both - because nothing downstream
// exists until the tie does, and the gate refuses a backstory for a character with no tie at all.
import { state, on } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { section, empty } from "./common.js";
import { GATE } from "../lib/gate.js";

const WHAT = { main: "sheet", alt: "backstory", player: "sheet" };

// The gate's token is its own secret, not the dashboard's command token.
const readToken = () => { try { return localStorage.getItem("dash.loreToken") || ""; } catch { return ""; } };
const saveToken = v => { try { localStorage.setItem("dash.loreToken", v); } catch {} };

let chosen = null;      // character name
let result = null;      // the gate's last answer to a draft or a commit
let busy = false;
let live = null;        // the gate's own document. The published file is only rewritten on a commit, so a
                        // character made since the last one is invisible there until something republishes.
let claim = [];         // characters whose account has named no main yet
let options = null;     // /alt-options for the chosen alt
let job = null;         // the writing that is running, or the one just finished
let poll = 0;
// What the player has typed, kept per character. The box is rebuilt on every redraw, and a redraw happens
// whenever the gate is read again or an answer comes back - so without this, their words vanish mid-sentence.
let drafts = {};
let form = { kind: "", temperament: "", concept: "", keep: "", keep_story: "", rebond: false };

const headers = () => ({ "Content-Type": "application/json", "X-Lore-Token": readToken() });

// The token is kept in this browser, against this exact web address. Reaching the dashboard by another name -
// localhost here, the tailnet address from the game PC - is a different store, and the box comes up empty.
let tokenBad = false;

async function ask(path, body) {
  const res = await fetch(GATE + path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  tokenBad = res.status === 401;
  return res.json();
}

async function get(path) {
  const res = await fetch(GATE + path, { headers: { "X-Lore-Token": readToken() }, cache: "no-store" });
  tokenBad = res.status === 401;
  return res.json();
}

async function refresh(redraw) {
  try {
    const doc = await get("/characters?full=1");
    if (doc.ok) live = doc;
    const c = await get("/claim");
    claim = (c.ok && c.claimable) || [];
  } catch { /* the gate may simply not be up; the published file still shows */ }
  redraw();
}

async function loadOptions(name, redraw) {
  options = null;
  form = { kind: "", temperament: "", concept: "", keep: "", keep_story: "", rebond: false };
  try {
    const r = await get(`/alt-options?character=${encodeURIComponent(name)}`);
    options = r.ok ? r.options : null;
    if (options) form.concept = options.concept || "";
  } catch { options = null; }
  redraw();
}

// A job runs for as long as the writing takes, so the page watches it rather than holding a request open.
function watchJob(id, redraw) {
  clearTimeout(poll);
  const tick = async () => {
    try {
      const r = await get(`/job?id=${encodeURIComponent(id)}`);
      if (r.ok) job = r.job;
      redraw();
      if (job && job.state === "running") poll = setTimeout(tick, 1500);
      else if (job && job.phase === "keep" && job.state === "done") {
        form.rebond = false;        // they are bound now; the section stays up only to say so
        refresh(redraw);
      }
    } catch {
      poll = setTimeout(tick, 3000);
    }
  };
  tick();
}

const who = c => h("div.lore-who",
  h("b", c.name),
  h("span.muted", ` ${c.race} ${c.cls}`),
  c.bond_kind ? h("span.pill", c.bond_kind) : null);

// What a character already has, so the gaps are obvious at a glance.
const marks = c => h("div.lore-marks",
  ["sheet", "story", "traits"].map(k => h("span.mark", { class: c[`has_${k}`] ? "on" : "" },
    icon(c[`has_${k}`] ? "up" : "down", 12), k)));

function list(doc, redraw) {
  const rows = (doc.characters || []).filter(c => c.kind !== "player" || c.has_story);
  if (!rows.length) return empty("No characters of yours yet. Name a main first.");
  return h("div.lore-list", rows.map(c => h("button.lore-row", {
    type: "button",
    class: c.name === chosen ? "on" : "",
    on: { click: () => { chosen = c.name; result = null; job = null; redraw(); loadOptions(c.name, redraw); } },
  }, who(c), marks(c))));
}

// Naming a main is what turns the rest of an account's characters into alts (plan 21 §1). Nothing else in
// the build writes that row, so an account that has never named one cannot be written for at all.
function claimView(redraw) {
  if (!claim.length) return null;
  const name = async c => {
    busy = true; redraw();
    result = await ask("/main-set", { character: c.name });
    busy = false;
    await refresh(redraw);
  };
  return h("div.lore-claim",
    h("p", "No character on this account is spoken for yet. Name the one you play as yourself — the others "
         + "become their alts, and can be bound to them."),
    h("div.lore-list", claim.map(c => h("button.lore-row", {
      type: "button", disabled: busy, on: { click: () => name(c) },
    }, who(c), h("span.muted", `level ${c.level}`)))));
}

function tieChooser(redraw) {
  return h("div.lore-choice",
    h("h4", "What is between them"),
    h("div.lore-kinds", options.kinds.map(k => h("button.lore-kind", {
      type: "button", class: form.kind === k.kind ? "on" : "",
      on: { click: () => { form.kind = form.kind === k.kind ? "" : k.kind; redraw(); } },
    }, h("b", k.kind), h("span.muted", k.gloss)))),
    h("div.hint", form.kind
      ? "Yours, so it is pinned and never drawn again."
      : "Choose one, or let the world draw it. Only ties this pair could truly have are offered."));
}

function temperChooser(redraw) {
  return h("div.lore-choice",
    h("h4", "Their turn of speech"),
    h("select.input", { "aria-label": "Temperament", on: { change: e => { form.temperament = e.target.value; redraw(); } } },
      h("option", { value: "" }, "Let the world choose"),
      options.temperaments.map(t => h("option", { value: t, selected: form.temperament === t || null },
        t.toLowerCase().replace(/_/g, " ")))),
    h("div.hint", "Pin it once you have said who they are. A drawn one can contradict your own words — a "
                + "light-hearted cousin came back speaking with his fists."));
}

function jobView() {
  if (!job) return null;
  const running = job.state === "running";
  return h("div.lore-job", { class: job.state },
    (job.steps || []).length
      ? h("div.lore-steps", job.steps.map(s => h("div.lore-step", icon("check", 12), s)))
      : null,
    running ? h("div.lore-step.working", icon("activity", 12), "Writing. This takes a minute.") : null,
    job.bond ? h("div.lore-cur", h("h4", `The tie — ${job.kind}${job.drawn_kind ? ", drawn" : ""}`),
      h("p", job.bond)) : null,
    job.story ? h("div.lore-cur", h("h4", `Their story — ${(job.temperament || "").toLowerCase().replace(/_/g, " ")}`
      + `${job.drawn_temperament ? ", drawn" : ""}`), h("p", job.story)) : null,
    // Only when it actually came to nothing. A discarded attempt is not a refusal if the next one stood, and
    // showing it as one told the player their writing had been rejected when it had just been reworded.
    job.state === "failed" && (job.refusals || []).length
      ? h("div.lore-bad", h("h4", "What the world would not hold"),
          h("ul", job.refusals.map(x => h("li", x))))
      : null,
    job.state === "failed" && (job.notes || []).length
      ? h("div.lore-advice", h("h4", "What it tried"), h("ul", job.notes.map(x => h("li", x))))
      : null,
    job.message ? h("div.lore-msg", job.message) : null);
}

// The whole of bringing an alt in: the tie, the turn of speech, their story, traits, what they feel about
// their own, and the projection into what they say. All of it from here.
function bringIn(char, redraw) {
  if (!options) return empty("Asking the gate what they could be…");
  const running = job && job.state === "running";
  const written = job && job.state === "done" && job.phase === "write" && job.story;

  const concept = h("textarea.lore-box", {
    rows: 7, spellcheck: "true",
    placeholder: `Who is ${char.name}, and what is between them and ${options.main}? `
               + "Two or three sentences in your own words.",
  });
  concept.value = form.concept;
  concept.addEventListener("input", () => { form.concept = concept.value; });

  const anchor = (key, label) => {
    const box = h("input.input", { placeholder: label, spellcheck: "false" });
    box.value = form[key];
    box.addEventListener("input", () => { form[key] = box.value; });
    return box;
  };

  const write = h("button.btn.btn-primary", {
    type: "button", disabled: running,
    on: {
      click: async () => {
        job = null; result = null; redraw();
        const r = await ask("/alt-write", {
          character: char.name, kind: form.kind, temperament: form.temperament,
          concept: form.concept.trim(), keep: form.keep, keep_story: form.keep_story, rebond: form.rebond,
        });
        if (r.ok) { job = { id: r.job, state: "running", steps: [], phase: "write" }; watchJob(r.job, redraw); }
        else { result = r; }
        redraw();
      },
    },
  }, running ? "Writing…" : (written ? "Write it again" : "Write it"));

  const keep = h("button.btn.btn-go", {
    type: "button", disabled: !written || running,
    on: {
      click: async () => {
        const r = await ask("/alt-keep", { character: char.name, job: job.id, concept: form.concept.trim() });
        if (r.ok) { job = { id: r.job, state: "running", steps: [], phase: "keep" }; watchJob(r.job, redraw); }
        else { result = r; }
        redraw();
      },
    },
  // Not "Keep them": the older editor below has a "Keep it", and two buttons a few inches apart whose names
  // differ by a pronoun sent the operator to the greyed-out one.
  }, "Bring them in");

  // Filling in your own alts is the point, not a toll. This only saves the blank page: it puts the draw the
  // gate would have made anyway on screen first, in fields that are still yours to change.
  const surprise = h("button.btn", {
    type: "button", disabled: running || !options.suggest,
    title: "Draw a tie, a turn of speech, and a few words to start from",
    on: {
      click: () => {
        const s = options.suggest || {};
        form.kind = s.kind || "";
        form.temperament = s.temperament || "";
        form.concept = s.concept || "";
        redraw();
      },
    },
  }, "Surprise me");

  return h("div.lore-bring",
    options.catchup ? h("div.lore-warn", icon("alert", 15), h("span", options.catchup)) : null,
    !options.has_sheet
      ? h("div.lore-warn", icon("alert", 15),
          h("span", `${options.main} has no sheet yet. Write one for them first — every tie is written `
                  + "from it, and without it the world knows them only by name."))
      : null,
    h("div.lore-actions.lore-suggest", surprise,
      h("span.muted", "Fills all three below. Change anything you like — nothing is stored until you keep them.")),
    tieChooser(redraw),
    temperChooser(redraw),
    h("div.lore-choice", h("h4", "In your own words"), concept,
      h("div.hint", "Kept as theirs. The shaping must not lose what you said.")),
    h("div.lore-choice", h("h4", "Words that must survive"),
      h("div.lore-anchors", anchor("keep", "in the tie, e.g. cousin"), anchor("keep_story", "in the story, e.g. wealth")),
      h("div.hint", "Optional. Anything here is checked for, and the writing is tried again without it.")),
    h("div.lore-actions", write, keep),
    jobView(),
    written ? h("div.muted.lore-note", "Nothing is stored until you keep them. Keeping also gives them "
                                     + "traits, seeds what they feel, and projects it into what they say.") : null);
}

// What stands now: the text that actually reaches this character's prompts. Read-only -- the box below is for
// the player's own words, and the shaping is what the gate produces from them.
function current(c) {
  if (!c) return null;
  const line = (label, value, cls) => value
    ? h("div.lore-cur", { class: cls || "" }, h("h4", label), h("p", value))
    : null;
  const bits = [
    line("Sheet", c.sheet),
    c.bond ? line(`Bond to their main — ${c.bond_kind || "?"}`, c.bond) : null,
    line("Personality", c.personality),
    line("In short", c.gist),
    line("What drives them", c.motivation_full || c.motivation),
    line("Backstory", c.backstory),
  ].filter(Boolean);
  if (!bits.length) {
    return empty(`Nothing written for ${c.name} yet. What you write below becomes their first.`);
  }
  return h("div.lore-current",
    c.temperament ? h("div.lore-temper", h("span.pill", c.temperament), h("span.muted", " their turn of speech")) : null,
    bits);
}

function verdict(r) {
  if (!r) return null;
  const bad = (r.refusals || []).length;
  return h("div.lore-verdict",
    r.message ? h("div.lore-msg", r.message) : null,
    bad ? h("div.lore-bad", h("h4", "This cannot stand in the world"),
      h("ul", r.refusals.map(x => h("li", x)))) : null,
    (r.advice || []).length ? h("div.lore-advice", h("h4", "Worth considering"),
      h("ul", r.advice.map(x => h("li", x)))) : null,
    r.prose ? h("div.lore-prose", h("h4", "As the world would tell it"), h("p", r.prose)) : null,
    (r.stale_bonds || []).length
      ? h("div.lore-advice", h("h4", "Now out of date"),
          h("p", `${r.stale_bonds.join(", ")} — their ties were written from the older sheet.`))
      : null,
    r.note ? h("div.muted.lore-note", r.note) : null);
}

export function mountLore(el) {
  const draw = () => {
    const doc = live || state.loreEdit;
    // What the page actually shows, not when it was fetched: `generated` is a fresh timestamp on every live
    // read, so keying the redraw on it rebuilt the panel - and the box - for no change at all.
    const stamp = (doc?.characters || []).map(c =>
      `${c.guid}:${c.bond_kind || ""}:${c.has_sheet ? 1 : 0}${c.has_story ? 1 : 0}${c.has_traits ? 1 : 0}`).join("|");
    const sig = JSON.stringify([stamp, chosen, result, busy, claim.length, tokenBad,
      options?.character, options?.has_bond, form.kind, form.temperament, form.rebond,
      job?.id, job?.state, (job?.steps || []).length, !!job?.story]);
    render(el, sig, () => {
      if (!doc) return [empty("The lore gate has not published yet.")];

      const token = h("input.input", {
        type: "password", placeholder: "Lore gate token", autocomplete: "off",
        spellcheck: "false", value: readToken(),
        on: {
          // Kept as it is typed. On blur alone, a token pasted and then sent straight off with the button
          // was never saved at all.
          input: e => saveToken(e.target.value.trim()),
          change: e => { saveToken(e.target.value.trim()); refresh(draw); },
        },
      });

      const char = (doc.characters || []).find(c => c.name === chosen);
      const what = char ? (WHAT[char.kind] || "backstory") : null;
      const existing = char ? (what === "sheet" ? char.sheet_source : char.story_source) : "";
      const box = h("textarea.lore-box", {
        rows: 10, spellcheck: "true",
        placeholder: char
          ? `Write ${char.name} in your own words: where they come from, what they are like, what they are after.`
          : "Choose a character first.",
      });
      const key = char ? char.name : "";
      box.value = drafts[key] !== undefined ? drafts[key] : (existing || "");
      box.addEventListener("input", () => { drafts[key] = box.value; });

      const run = async (path) => {
        if (busy || !char) return;
        busy = true; draw();
        try {
          result = await ask(path, {
            character: char.name, what, text: box.value.trim(),
            prose: path === "/commit" ? (result && result.prose) || "" : "",
          });
          if (path === "/commit") await refresh(draw);
        } catch (e) {
          result = { ok: false, message: `The gate did not answer (${e.message}). Is wow-lore-gate running?` };
        } finally { busy = false; draw(); }
      };

      const check = h("button.btn.btn-primary", {
        type: "button", disabled: !char || busy,
        on: { click: () => run("/draft") },
      }, busy ? "Asking…" : "Check");
      const save = h("button.btn.btn-go", {
        type: "button", disabled: !(result && result.prose) || busy,
        on: { click: () => run("/commit") },
      }, "Keep it");
      const rescan = h("button.btn", {
        type: "button", title: "Look again for characters made since this page loaded",
        on: { click: () => refresh(draw) },
      }, icon("activity", 14), "Look again");

      // An alt with no tie cannot be edited at all: the gate refuses a backstory with nothing to build it
      // around. So for them the bringing-in comes first, and the editor below is for afterwards.
      // A job that has just finished keeps the section up, so its last word is not swept away by the very
      // change it made.
      const mine = job && job.character === char?.name;
      const isNewAlt = char && char.kind === "alt" && (!char.bond_kind || form.rebond || mine);
      const canRebond = char && char.kind === "alt" && char.bond_kind && !form.rebond && !mine;

      // section() hands back { el, body, count } and the content goes inside body -- it is not an array.
      const sec = (title, ...kids) => {
        const s = section(title);
        s.body.append(...kids.filter(Boolean));
        return s.el;
      };
      return [
        claim.length ? sec("Name your main", claimView(draw)) : null,
        sec("Your characters", list(doc, draw), h("div.lore-actions", rescan)),
        char ? sec("What stands now", current(char)) : null,
        isNewAlt ? sec(`Bring ${char.name} into the world`, bringIn(char, draw)) : null,
        canRebond
          ? sec("Their tie", h("div.lore-choice",
              h("p.muted", `${char.name} is bound to their main as ${char.bond_kind}. Writing it again `
                         + "re-rolls their story and traits with it."),
              h("button.btn", { type: "button", on: { click: () => { form.rebond = true; job = null; draw(); } } },
                "Write their tie again")))
          : null,
        sec("What you say of them",
          char ? h("div.lore-edit", box, h("div.lore-actions", check, save)) : empty("Choose a character."),
          verdict(result)),
        sec("The gate",
          tokenBad
            ? h("div.lore-warn", icon("alert", 15), h("span",
                "The gate would not take that token. It is kept in this browser against this exact web address, "
                + "so reaching the dashboard by another name — localhost here, the tailnet address from the game "
                + "PC — needs it entered again below."))
            : null,
          h("div.lore-rules",
            h("ul", [
              "Write as though it is real life. No games, no figures.",
              "Nothing later than this age has happened yet.",
              "Keep to your own people's lands and history.",
              "Your own words are kept — the shaping must not lose what you said.",
            ].map(t => h("li", t)))),
          token),
      ];
    });
  };
  on("loreEdit", draw);
  draw();
  refresh(draw);
}
