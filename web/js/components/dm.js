// Dungeon Master panel (custom-wow services/dm/dm.py, plan 62): what the DM was cued to write, what it wrote,
// what the world actually said, and what it missed. Read-only; the DM decides nothing from here.
import { state, on } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { clock, full, plural, stamp } from "../lib/format.js";
import { section, time, empty, kpis, openKeys } from "./common.js";

const OUTCOME = {
  killed: ["Killed", "warm"], fell: ["Killed one of them", "cold"], spoke: ["Spoke, no fight", ""],
  "under way": ["Under way", ""], "never reached": ["Never reached", "cold"],
};

const secs = s => s == null ? "" : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;

function line(l) {
  return h("li.dm-line", { title: [l.why && `from: ${l.why}`, l.model].filter(Boolean).join(" · ") },
    h("span.dm-rank", String(l.rank + 1)), h("span.dm-words", `“${l.words}”`));
}

function boss(b) {
  const [label, cls] = OUTCOME[b.outcome] || [b.outcome, ""];
  const fallbackSaid = b.said && b.said.fallback;
  const unsaid = b.lines.filter(l => !b.said || l.id !== b.said.id);
  return h("div.dm-boss",
    h("div.dm-boss-head",
      h("b", b.name),
      h("span.pill", { class: cls ? `dm-${cls}` : "" }, label),
      b.miss && h("span.badge.warn", { title: "Killed with nothing said: the approach trigger never fired" }, "miss"),
      b.latency != null && h("span.muted.dm-lat", { title: "From the party walking in to the line being written" }, `written in ${secs(b.latency)}`)),
    b.said && h("div.dm-said", { title: full(b.said.ts) }, icon("message", 13),
      h("span", fallbackSaid ? "Said a line for anyone: " : "Said: "), h("q", b.said.words)),
    unsaid.length > 0 && h("div.dm-also", b.said ? "Also written" : "Written, waiting"),
    unsaid.length > 0 && h("ol.dm-lines", unsaid.map(line)),
    !b.lines.length && !b.said && h("div.muted.dm-none", "Nothing written for this party."));
}

function run(r, open) {
  return h("details.card.dm-run", { dataset: { key: `i${r.instance}` }, open },
    h("summary",
      h("div.card-main",
        h("div.card-title", r.place),
        h("div.card-sub", { title: full(r.ts) }, `${r.player}${r.party.length ? ` with ${r.party.join(", ")}` : ""} · ${stamp(r.ts)}`)),
      r.bosses.some(b => b.miss) && h("span.badge.warn", "miss"),
      r.bosses.some(b => b.said) && h("span.badge.gold", "spoken"),
      icon("chevron", 14)),
    h("div.dm-body", r.bosses.length ? r.bosses.map(boss) : empty("No final boss known for this place.", "skull")));
}

function arrival(g) {
  return h("div.tl", { title: g.why ? `from: ${g.why}` : "" },
    h("span.tl-icon", { class: g.lines.some(l => l.said) ? "warm" : "" }, icon("message", 14)),
    h("div.tl-line", h("b", g.player), h("span.muted", " in "), g.place),
    time(g.made),
    h("ul.dm-inn", g.lines.map(l => h("li", { class: l.said ? "said" : l.expired ? "expired" : "", title: l.said ? `said ${full(l.said)}` : l.expired ? "expired unsaid" : "waiting" },
      h("span.dm-words", `“${l.words}”`)))));
}

function fallback(b) {
  return h("div.dm-fb",
    h("div.dm-fb-head", h("b", b.name), h("span.muted", b.place)),
    h("ul.dm-inn", b.lines.map(l => h("li", { class: l.spoken ? "said" : "", title: l.spoken ? `said ${plural(l.spoken, "time")}` : "never said yet" },
      h("span.dm-words", `“${l.words}”`)))));
}

export function mountDM(panel) {
  const meta = h("div.meta", icon("crown", 13), "Waiting for the Dungeon Master…");
  const stats = h("div");
  const runs = section("Dungeon runs", { icon: "skull", key: "dm.runs" });
  const inns = section("At the inn", { icon: "message", key: "dm.inn" });
  const fb = section("Boss words for anyone", { icon: "scroll", key: "dm.fb", open: false });
  const note = h("p.rnote", "A line is written when a player walks in (a dungeon, or a zone with an inn) and said when they come within sight of the final boss or up to an innkeeper. ",
    "A miss is a boss killed with nothing said: the trigger never fired. Lines that expire unsaid at an inn are struck through.");
  panel.append(meta, stats, runs.el, inns.el, fb.el, note);

  function draw() {
    const d = state.dm;
    if (!d) return;
    const t = d.totals;
    meta.replaceChildren(icon("crown", 13), `Last ${plural(d.days, "day")} · updated ${clock(d.generated)}`,
      d.paused ? h("span.badge.warn", { style: { marginLeft: "8px" } }, "paused") : "");
    render(stats, `${d.generated}`, () => kpis([
      ["dungeon runs", t.runs], ["boss lines spoken", `${t.boss_spoken}/${t.runs}`],
      ["missed", t.boss_missed, t.boss_missed ? "cold" : ""],
      ["arrivals", t.arrivals], ["inn lines spoken", `${t.inn_spoken}/${t.inn_written}`],
      ["expired unsaid", t.inn_expired]]));

    runs.count(d.runs.length);
    const open = openKeys(runs.body);
    render(runs.body, `${d.generated}`, () => d.runs.length
      ? d.runs.map((r, i) => run(r, open.size ? open.has(`i${r.instance}`) : i === 0))
      : empty("No player has walked into a dungeon in this window.", "skull"));

    inns.count(d.inn.length);
    render(inns.body, `${d.generated}`, () => d.inn.length ? d.inn.map(arrival) : empty("No inn lines written in this window.", "message"));

    fb.count(d.fallback.length);
    render(fb.body, `${d.generated}`, () => d.fallback.length ? d.fallback.map(fallback) : empty("No boss words written yet (dm.py boss-words).", "scroll"));
  }

  on("dm", draw);
  draw();
}
