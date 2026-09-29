// Settings panel: the config keys the server offers (Dashboard.Settings.Keys), their live values, and
// with the command token a way to change them. The server writes the key to its config file and runs
// its reload command; the values shown are re-read from the running server afterwards.
import { state, on, emit, localGet } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { describe, validate, grouped } from "../lib/settings.js";
import { setPanel } from "../actions.js";
import { section, empty } from "./common.js";
import { toast } from "./toast.js";

const REFRESH_MS = 20000;

// What each router route is for, where the realm uses the Headless DM router.
const ROUTE_USE = {
  quality: "replies to players", ambient: "background chatter", chronicle: "chronicles", prose: "lore writing",
  utility: "sorting and checks", moment: "moments",
};

export function mountSettings(panel) {
  const status = h("div");
  const modelsBox = h("div.settings-models");
  const body = h("div.settings");
  panel.append(status, modelsBox, body);

  let data = null;
  let models = null;   // from the standalone host's server adapter, when it has one
  let timer = 0;

  const modelName = id => models?.choices.find(c => c.id === id)?.name.replace(/^[^:]+:\s*/, "") || id;
  const routeModel = route => {
    const backends = models?.routes?.[route];
    if (!backends?.length) return null;
    const [first, ...rest] = backends.map(name => models.backends.find(b => b.name === name)).filter(Boolean);
    if (!first) return null;
    return modelName(first.model) + (rest.length ? `, then ${rest.map(b => modelName(b.model)).join(", ")}` : "");
  };

  // Only the standalone host has these routes, and only with its control token (the Server panel's).
  async function loadModels() {
    const token = localGet("controlToken");
    if (!token) { models = null; drawModels(); return; }
    try {
      const res = await fetch("api/server/models", { cache: "no-store", headers: { "X-Control-Token": token } });
      models = res.ok ? await res.json() : null;
    } catch {
      models = null;
    }
    drawModels();
    draw();
  }

  async function waitForJob(token) {
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const res = await fetch("api/server/job", { cache: "no-store", headers: { "X-Control-Token": token } });
      const job = res.ok ? await res.json() : null;
      if (job && job.status !== "running") return job;
    }
    return { status: "failed", error: "Still running after 90 seconds; check the Server panel." };
  }

  async function changeModel(backend, model, reasoning, button) {
    const token = localGet("controlToken");
    if (!token || !model) return;
    button.disabled = true;
    try {
      const res = await fetch("api/server/model", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Control-Token": token },
        body: JSON.stringify({ backend, model, reasoning }),
      });
      const started = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(started.error || `HTTP ${res.status}`);
      toast({ tone: "info", title: `Switching ${backend}`, text: `${modelName(model)}, ${reasoning} reasoning. This takes a few seconds.` });
      const job = await waitForJob(token);
      toast({ ok: job.status === "done", title: job.status === "done" ? "Model changed" : "Model not changed",
              text: job.result?.output || job.error || "" });
    } catch (e) {
      toast({ ok: false, title: "Model not changed", text: e.message });
    } finally {
      button.disabled = false;
      loadModels();
    }
  }

  function backendCard(backend) {
    const uses = Object.entries(models.routes).filter(([, list]) => list[0] === backend.name).map(([route]) => ROUTE_USE[route] || route);
    const known = models.choices.some(c => c.id === backend.model);
    const pick = h("select.input", { "aria-label": `Model for ${backend.name}` },
      models.choices.map(c => {
        const price = c.inputPerMillion == null ? "" : ` — $${c.inputPerMillion} in / $${c.outputPerMillion} out per M tokens`;
        const opt = h("option", { value: c.id }, c.name.replace(/^[^:]+:\s*/, "") + price);
        if (c.id === backend.model) opt.selected = true;
        return opt;
      }),
      h("option", { value: "" }, "Another OpenRouter model…"));
    if (!known) pick.value = "";
    const other = h("input.input", { type: "text", placeholder: "provider/model-name", spellcheck: "false",
      "aria-label": "OpenRouter model id", value: known ? "" : backend.model, hidden: known });
    pick.addEventListener("change", () => { other.hidden = pick.value !== ""; });
    const effort = h("select.input.effort", { "aria-label": "Reasoning" },
      models.efforts.map(e => { const opt = h("option", { value: e }, `${e} reasoning`); if (e === backend.reasoning) opt.selected = true; return opt; }));
    const go = h("button.btn", { type: "button", disabled: !backend.editable,
      on: { click: () => changeModel(backend.name, pick.value || other.value.trim(), effort.value, go) } }, "Switch");
    return h("div.setting",
      h("div.setting-text",
        h("div.setting-label", uses.length ? uses.join(", ") : backend.name),
        h("div.hint", `${modelName(backend.model)}${backend.reasoning ? `, ${backend.reasoning} reasoning` : ""}${backend.running ? "" : " — not running"}`),
        h("code.setting-key", backend.name)),
      backend.editable && h("div.setting-edit.model-edit", pick, effort, go),
      backend.editable && other);
  }

  function drawModels() {
    render(modelsBox, JSON.stringify(models), () => {
      if (!models) return [];
      const sect = section("Models", { icon: "sparkle", key: "settings.models" });
      sect.count(models.backends.length);
      sect.body.append(
        h("div.hint", "Switching restarts that model's adapter and the router: a few seconds in which new lines wait."),
        ...models.backends.map(backendCard));
      return sect.el;
    });
  }

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
    // A route name ("quality") says nothing on its own; say what it runs, when the host can tell.
    const resolved = d.kind === "text" && routeModel(s.value);
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
      h("div.setting-text", h("div.setting-label", d.label), d.help && h("div.hint", d.help),
        resolved && h("div.setting-resolved", `${s.value} → ${resolved}`), h("code.setting-key", s.key)),
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
    render(body, JSON.stringify([d.settings, d.writable, models?.backends, models?.routes]), () => {
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
    if (state.panel === "settings" && state.dockOpen) { load(); loadModels(); }
    schedule();
  });
  load();
  loadModels();
}
