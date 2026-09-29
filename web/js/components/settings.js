// Settings panel: the config keys the server offers (Dashboard.Settings.Keys), their live values, and
// with the command token a way to change them. The server writes the key to its config file and runs
// its reload command; the values shown are re-read from the running server afterwards.
import { state, on, emit } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { describe, validate, grouped } from "../lib/settings.js";
import { setPanel } from "../actions.js";
import { section, empty } from "./common.js";
import { toast } from "./toast.js";

const REFRESH_MS = 20000;

export function mountSettings(panel) {
  const status = h("div");
  const body = h("div.settings");
  panel.append(status, body);

  let data = null;
  let timer = 0;

  async function load() {
    try {
      const res = await fetch("settings", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 503 ? "not ready yet" : `HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      data = { error: e.message };
    }
    draw();
  }

  function schedule() {
    clearTimeout(timer);
    if (state.panel === "settings" && state.dockOpen)
      timer = setTimeout(async () => { await load(); schedule(); }, REFRESH_MS);
  }

  async function save(key, raw, control) {
    const checked = validate(key, raw);
    if (checked.error) {
      toast({ ok: false, title: describe(key).label, text: `Needs ${checked.error}.` });
      return;
    }
    const token = (state.token || "").trim();
    if (!token) {
      toast({ tone: "info", title: "A command token is needed", text: "Enter Dashboard.CommandToken in Commands." });
      setPanel("commands");
      emit("need-token");
      return;
    }
    control.disabled = true;
    try {
      const res = await fetch("cmd/setting", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dashboard-Token": token },
        body: JSON.stringify({ key, value: checked.value }),
      });
      const r = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
      if (res.status === 401) { setPanel("commands"); emit("need-token"); }
      toast({ ok: !!r.ok, title: describe(key).label, text: r.message });
    } catch (e) {
      toast({ ok: false, title: describe(key).label, text: e.message });
    } finally {
      control.disabled = false;
      // The reload runs on the next world tick; read back what the server now holds.
      setTimeout(load, 1500);
    }
  }

  function row(s, writable) {
    const d = describe(s.key);
    let control;
    if (d.kind === "bool") {
      control = h("input.switch", { type: "checkbox", role: "switch", "aria-label": d.label, disabled: !writable });
      control.checked = s.value === "1" || s.value.toLowerCase?.() === "true";
      control.addEventListener("change", () => save(s.key, control.checked ? "1" : "0", control));
    } else {
      const input = h("input.input", { type: d.kind === "int" ? "number" : "text", value: s.value, spellcheck: "false",
        "aria-label": d.label, disabled: !writable, min: d.min, max: d.max });
      const go = h("button.btn", { type: "button", disabled: !writable, on: { click: () => save(s.key, input.value, go) } }, "Save");
      input.addEventListener("keydown", e => { if (e.key === "Enter") save(s.key, input.value, go); });
      control = h("div.setting-edit", input, go);
    }
    return h("div.setting", { class: d.kind === "bool" ? "inline" : "" },
      h("div.setting-text", h("div.setting-label", d.label), d.help && h("div.hint", d.help), h("code.setting-key", s.key)),
      control);
  }

  function draw() {
    const d = data || {};
    render(status, JSON.stringify([d.error, d.enabled, d.writable, d.file, d.reload]), () => {
      if (d.error)
        return h("div.status-card.off", h("span.seal", icon("alert", 18)),
          h("div", h("div.card-title", "Settings are unavailable"), h("div.card-sub", d.error)));
      if (!d.enabled)
        return h("div.status-card.off", h("span.seal", icon("sliders", 18)),
          h("div", h("div.card-title", "No settings offered"), h("div.card-sub", "The server has no Dashboard.Settings.Keys.")));
      return h("div.status-card", { class: d.writable ? "" : "off" }, h("span.seal", icon(d.writable ? "check" : "eye", 18)),
        h("div",
          h("div.card-title", d.writable ? "Changes apply to the running server" : "Read-only"),
          h("div.card-sub", d.writable
            ? `Saved to ${d.file}${d.reload ? `, then “${d.reload}”` : "; takes effect at the next reload"}.`
            : "Set Dashboard.CommandToken and Dashboard.Settings.File to change them here.")));
    });
    // Rebuilt only when a value changes, so an input being typed in is not wiped by a poll.
    render(body, JSON.stringify([d.settings, d.writable]), () => {
      if (!d.enabled || d.error) return [];
      const groups = grouped(d.settings);
      if (!groups.length) return empty("No settings.", "sliders");
      return groups.map(g => {
        const sect = section(g.group, { icon: "sliders", key: "settings." + g.group });
        sect.count(g.items.length);
        sect.body.append(...g.items.map(s => row(s, d.writable)));
        return sect.el;
      });
    });
  }

  on("panel", () => {
    if (state.panel === "settings" && state.dockOpen) load();
    schedule();
  });
  load();
}
