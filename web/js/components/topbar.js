// Top bar: brand, live world stats with sparklines, connection status, theme switch.
import { state, on } from "../state.js";
import { h, icon } from "../lib/dom.js";
import { clockS } from "../lib/format.js";
import { setTheme } from "../actions.js";

const BRAND = `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
  <defs><linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a8fd96"/><stop offset="1" stop-color="#479b31"/></linearGradient></defs>
  <path d="M16 1.5 30.5 16 16 30.5 1.5 16Z" fill="none" stroke="url(#brand-g)" stroke-width="1.6"/>
  <path d="M16 6 26 16 16 26 6 16Z" fill="none" stroke="url(#brand-g)" stroke-width="1" opacity=".55"/>
  <path d="M16 9.5 18.2 13.8 22.5 16 18.2 18.2 16 22.5 13.8 18.2 9.5 16 13.8 13.8Z" fill="url(#brand-g)"/>
</svg>`;

function sparkline(values, w = 60, ht = 22) {
  if (values.length < 2) return `<svg class="spark" width="${w}" height="${ht}"></svg>`;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => [2 + i / (values.length - 1) * (w - 4), ht - 3 - (v - min) / span * (ht - 6)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="spark" width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}" aria-hidden="true">`
    + `<path class="spark-area" d="${line}L${lx.toFixed(1)},${ht}L2,${ht}Z"/>`
    + `<path class="spark-line" d="${line}"/>`
    + `<circle class="spark-dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.5"/></svg>`;
}

function tile(label, { spark = false, unit = "" } = {}) {
  const value = h("span.tile-value", "–");
  const unitEl = unit ? h("span.tile-unit", unit) : null;
  const sp = spark ? h("span") : null;
  const sub = h("span.tile-sub");
  const el = h("div.tile", h("div.tile-label", label), h("div.tile-row", h("span", value, unitEl), sp, sub));
  return { el, sub, sp, set: v => { value.textContent = v; } };
}

export function mountTopbar(root) {
  const t = {
    bots: tile("Bots online", { spark: true }),
    active: tile("Active"),
    paused: tile("Paused"),
    real: tile("Players"),
    tick: tile("World update", { spark: true, unit: "ms" }),
    here: tile("On this map"),
  };
  const connText = h("span", "Connecting…");
  const conn = h("div.conn", { title: "Snapshot from the world server, every 2 seconds" }, h("i.pulse"), connText);
  const themeBtn = h("button.icon-btn", { type: "button", on: { click: () => setTheme(state.theme === "dark" ? "light" : "dark") } });

  root.replaceChildren(
    h("a.brand", { href: "https://bazola.github.io/headless-dm-page/", target: "_blank", rel: "noopener",
      title: "Headless DM \u2014 the project site" },
      h("span.brand-mark", { html: BRAND }),
      h("div", h("div.brand-name", "Living Azeroth"), h("div.brand-eyebrow", "Realm dashboard"))),
    h("span.top-sep"),
    h("div.tiles", Object.values(t).map(x => x.el)),
    h("div.top-end", conn, themeBtn));

  const syncTheme = () => {
    const dark = state.theme === "dark";
    themeBtn.replaceChildren(icon(dark ? "sun" : "moon", 17));
    themeBtn.title = dark ? "Switch to the light theme" : "Switch to the dark theme";
  };
  syncTheme();
  on("theme", syncTheme);

  on("snapshot", () => {
    const { counts, update_ms: ms } = state.snap;
    const { bots, avg } = state.history;
    const minutes = Math.max(1, Math.round(bots.length * 2 / 60));
    t.bots.set(counts.bots.toLocaleString());
    t.bots.sp.innerHTML = sparkline(bots);
    t.bots.el.title = `Bots online over the last ${minutes} min: ${Math.min(...bots)}–${Math.max(...bots)}`;
    t.active.set(counts.active.toLocaleString());
    t.active.sub.textContent = counts.bots ? `${Math.round(counts.active / counts.bots * 100)}%` : "";
    t.paused.set(counts.paused ?? 0);
    t.paused.el.classList.toggle("lit", (counts.paused ?? 0) > 0);
    t.real.set(counts.real);
    t.tick.set(ms.avg);
    t.tick.sp.innerHTML = sparkline(avg);
    t.tick.sub.textContent = `max ${ms.max} · last ${ms.last}`;
    t.tick.el.classList.toggle("warn", ms.avg > 50);
    t.tick.el.title = `Average world update over the last ${minutes} min: ${Math.min(...avg)}–${Math.max(...avg)} ms`;
  });

  on("mapcounts", ({ total }) => t.here.set(total.toLocaleString()));

  const drawConnection = () => {
    const c = state.conn;
    conn.classList.toggle("ok", c.ok);
    conn.classList.toggle("bad", !c.ok && c.text !== "Connecting…");
    const age = c.seen ? Math.max(0, Math.floor((Date.now() - c.seen) / 1000)) : null;
    connText.textContent = c.ok ? `Live · ${clockS(c.ts)}` : c.text === "Connecting…" ? c.text
      : age === null ? "Realm unavailable · no live data" : `Realm unavailable · last update ${age}s ago`;
    conn.title = c.ok ? "Snapshot from the world server, every 2 seconds" : c.text;
  };
  on("conn", drawConnection);
  setInterval(drawConnection, 1000);
}
