// Models panel (lore_gate.py, GET /models and POST /models-set): which model each backend is told, and the
// order of each route's backends. It talks to the lore gate on its own port, for the reason the Lore panel
// does: this server caps a body at 1024 bytes, answers no preflight and drains commands on the world thread.
//
// The page can change two things and no more: a backend's model name, and a route's list, chosen from the
// backends fleet.toml already defines. Addresses, API keys and new backends are never sent from here, and the
// gate would refuse them if they were. A key is shown only as "key set" or "no key".
//
// The gate saves to site/fleet.override.json, never to fleet.toml, and the router follows that file by itself.
import { state, on, localGet, localSet } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { ROUTE_HELP, APPLIES, checkModel, sameChain, moveBackend, removeBackend, addBackend, addable,
         chainProblem, keyLabel, usedBy, routerWords } from "../lib/models.js";
import { section, empty } from "./common.js";
import { toast } from "./toast.js";
import { GATE } from "../lib/gate.js";

const REFRESH_MS = 20000;
const FOLLOW_MS = 3500;     // after a save: look again until the router says it has the change
const FOLLOW_TRIES = 4;

// The gate's token is the Lore panel's: one token, kept in this browser against this web address.
const token = () => (localGet("loreToken") || "").trim();

export function mountModels(panel) {
  const status = h("div");
  const body = h("div.settings");
  const input = h("input.input", { type: "password", placeholder: "Lore gate token", autocomplete: "off",
    spellcheck: "false", "aria-label": "Lore gate token", value: token() });
  input.addEventListener("input", () => localSet("loreToken", input.value.trim()));
  input.addEventListener("change", () => { localSet("loreToken", input.value.trim()); load(); });
  panel.append(status,
    h("div.field", icon("key", 15), input),
    h("div.hint", "The lore gate's token, the same as in the Lore panel. Kept in this browser only."),
    body);

  let data = null;          // { fleet } | { need, bad } | { off } | { error }
  let busy = false;
  let timer = 0;
  let follow = 0;
  // Not yet saved: a reordered route (rebuilds the panel) and a model name being typed (does not, so the
  // box keeps focus while a poll comes in).
  const drafts = { routes: {}, models: {} };

  async function call(path, payload) {
    const res = await fetch(GATE + path, {
      method: payload ? "POST" : "GET",
      headers: payload ? { "Content-Type": "application/json", "X-Lore-Token": token() } : { "X-Lore-Token": token() },
      body: payload ? JSON.stringify(payload) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const r = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
    return { status: res.status, r };
  }

  // What the gate said, as the panel's state, or null when it said nothing the panel can show (a refusal of
  // one change, say: the panel stays as it was and the refusal goes in a toast).
  function read({ status: code, r }) {
    if (code === 401) return { need: "token", bad: true };
    if (r.fleet) return { fleet: r.fleet };
    if (r.enabled === false) return { off: r.message };
    return null;
  }

  function adopt(next) {
    data = next;
    // A draft that now matches the server is not a draft.
    for (const route of data.fleet?.routes || []) {
      if (drafts.routes[route.name] && sameChain(drafts.routes[route.name], route.chain)) delete drafts.routes[route.name];
    }
  }

  async function load() {
    if (!token()) { adopt({ need: "token" }); draw(); return; }
    try {
      const got = await call("/models");
      adopt(read(got) ?? { error: got.r.message || `HTTP ${got.status}` });
    } catch (e) {
      adopt({ error: `The lore gate did not answer (${e.message}). Is wow-lore-gate running?` });
    }
    draw();
  }

  // Shown, not just chosen: the rail hides this panel when the gate has not turned it on.
  const visible = () => !panel.hidden && state.dockOpen;

  function schedule() {
    clearTimeout(timer);
    if (visible()) timer = setTimeout(async () => { await load(); schedule(); }, REFRESH_MS);
  }

  // The router switches within a few seconds of a save; ask again until it says so.
  function followUp() {
    clearTimeout(follow);
    let tries = 0;
    const tick = async () => {
      await load();
      if (data?.fleet && data.fleet.router?.state !== "live" && ++tries < FOLLOW_TRIES) follow = setTimeout(tick, FOLLOW_MS);
    };
    follow = setTimeout(tick, FOLLOW_MS);
  }

  async function save(patch, title, forget) {
    if (busy || !data?.fleet) return;
    busy = true;
    draw();
    try {
      const got = await call("/models-set", { ...patch, revision: data.fleet.revision });
      const next = read(got);
      if (next) adopt(next);
      if (got.r.ok) forget?.();
      else if (got.status === 409) { drafts.routes = {}; drafts.models = {}; }
      toast({ ok: !!got.r.ok, title, text: got.r.message });
    } catch (e) {
      toast({ ok: false, title, text: `Delivery unconfirmed: ${e.message}. Reload the page before trying again.` });
    } finally {
      busy = false;
      draw();
      followUp();
    }
  }

  // ---- pieces ----

  const keyPill = b => b.key === "not needed" ? null
    : h("span.pill.model-key", { class: b.key }, icon(b.key === "set" ? "check" : "alert", 12), keyLabel(b.key));

  function routeCard(r, fleet) {
    const chain = drafts.routes[r.name] ?? r.chain;
    const dirty = !sameChain(chain, r.chain);
    const problem = chainProblem(chain, fleet.backends, fleet.max_chain);
    const byName = new Map(fleet.backends.map(b => [b.name, b]));
    const draft = next => { if (sameChain(next, r.chain)) delete drafts.routes[r.name]; else drafts.routes[r.name] = next; draw(); };
    const tool = (label, ic, disabled, click, cls = "") => h("button.icon-btn", { type: "button", title: label, "aria-label": label,
      class: cls, disabled: disabled || busy, on: { click } }, icon(ic, 14));

    const links = chain.map((name, i) => {
      const b = byName.get(name);
      return h("li.model-link", { class: b && !b.usable ? "skipped" : "" },
        h("span.model-n", String(i + 1)),
        h("div.model-text", h("span.model-name", name), h("span.model-model", b ? b.model : "not defined"), b && keyPill(b)),
        h("div.model-tools",
          tool(`Move ${name} earlier`, "chevron", i === 0, () => draft(moveBackend(chain, i, -1)), "flip"),
          tool(`Move ${name} later`, "chevron", i === chain.length - 1, () => draft(moveBackend(chain, i, 1))),
          tool(`Take ${name} out of ${r.name}`, "x", false, () => draft(removeBackend(chain, i)))));
    });

    const options = addable(fleet.backends, chain);
    const add = options.length
      ? h("select.input", { "aria-label": `Add a backend to ${r.name}`, disabled: busy || chain.length >= fleet.max_chain,
          on: { change: e => { if (e.target.value) draft(addBackend(chain, e.target.value)); } } },
          h("option", { value: "" }, "Add a backend…"),
          options.map(n => h("option", { value: n }, `${n} · ${byName.get(n).model}`)))
      : null;

    const skipped = chain.filter(n => byName.get(n) && !byName.get(n).usable);
    return h("div.model-route",
      h("div.model-head", h("b", r.name), r.changed && h("span.pill", "changed")),
      ROUTE_HELP[r.name] && h("div.hint", ROUTE_HELP[r.name]),
      h("ol.model-chain", links),
      add,
      skipped.length > 0 && h("div.hint", `${skipped.join(", ")} ${skipped.length > 1 ? "have" : "has"} no key and ${skipped.length > 1 ? "are" : "is"} skipped until one is set.`),
      dirty && problem && h("div.hint.model-problem", problem),
      r.changed && !dirty && h("div.hint", `fleet.toml has: ${r.default_chain.join(", ")}`),
      (dirty || r.changed) && h("div.model-actions",
        dirty && h("button.btn.btn-primary", { type: "button", disabled: busy || !!problem,
          on: { click: () => save({ routes: { [r.name]: chain } }, `Route ${r.name}`, () => delete drafts.routes[r.name]) } }, "Save order"),
        dirty && h("button.btn", { type: "button", disabled: busy, on: { click: () => draft(r.chain) } }, "Cancel"),
        !dirty && r.changed && h("button.btn", { type: "button", disabled: busy,
          on: { click: () => save({ routes: { [r.name]: null } }, `Route ${r.name}`) } }, "Back to fleet.toml")));
  }

  function backendRow(b) {
    const box = h("input.input", { type: "text", value: drafts.models[b.name] ?? b.model, spellcheck: "false",
      autocomplete: "off", "aria-label": `Model for ${b.name}` });
    const submit = () => {
      const checked = checkModel(box.value);
      if (checked.error) return toast({ ok: false, title: b.name, text: `Needs ${checked.error}.` });
      save({ models: { [b.name]: checked.value } }, `Model of ${b.name}`, () => delete drafts.models[b.name]);
    };
    const go = h("button.btn", { type: "button", on: { click: submit } }, "Save");
    const sync = () => {
      const v = box.value.trim();
      if (v === b.model) delete drafts.models[b.name]; else drafts.models[b.name] = box.value;
      go.disabled = busy || v === b.model;
    };
    box.addEventListener("input", sync);
    box.addEventListener("keydown", e => { if (e.key === "Enter" && !go.disabled) submit(); });
    go.disabled = busy || box.value.trim() === b.model;
    return h("div.setting",
      h("div.setting-text",
        h("div.setting-label", b.name, " ", keyPill(b), b.changed && h("span.pill", "changed")),
        h("div.hint", `Used by: ${usedBy(b)}`),
        b.key_name && h("div.hint", `Key: ${b.key_name}`),
        b.changed && h("div.hint", `fleet.toml has: ${b.default_model}`)),
      h("div.setting-edit.model-edit", box, go,
        b.changed && h("button.btn", { type: "button", disabled: busy, title: "Use fleet.toml's model again",
          on: { click: () => save({ models: { [b.name]: null } }, `Model of ${b.name}`, () => delete drafts.models[b.name]) } }, "Reset")));
  }

  function readOnly(fleet) {
    const lane = l => h("div.model-ro", h("b", l.name), h("span.muted", ` ${l.model}`),
      l.skipped && h("span.hint", ` — skipped: ${l.skipped}`));
    return [
      h("div.setting-label", "Writing lanes"),
      fleet.batch.lanes.length ? fleet.batch.lanes.map(lane) : h("div.hint", "None."),
      h("div.setting-label", "The judge"),
      h("div.model-ro", h("b", fleet.judge.backend), h("span.muted", ` ${fleet.judge.model}`)),
      fleet.judge.fallback && h("div.model-ro", h("span.muted", "second choice "), h("b", fleet.judge.fallback),
        h("span.muted", ` ${fleet.judge.fallback_model}`)),
      h("div.hint", "Read-only. These use the backends above, so changing a backend's model changes them too. "
        + "Which backend a lane or the judge uses is set in fleet.toml ([batch] and [judge])."),
    ];
  }

  const card = (tone, title, text, extra) => h("div.status-card", { class: tone === "ok" ? "" : "off" },
    h("span.seal", icon(tone === "ok" ? "check" : tone === "wait" ? "activity" : "alert", 18)),
    h("div", h("div.card-title", title), text && h("div.card-sub", text), extra));

  function draw() {
    const d = data || {};
    render(status, JSON.stringify([d, busy]), () => {
      if (d.need) return card("bad", d.bad ? "That token is not the gate's" : "Enter the lore gate token",
        "Models are read and changed through the lore gate, with the token in the box below.");
      if (d.off) return card("bad", "Model settings are off", d.off);
      if (d.error) return card("bad", "Models are unavailable", d.error);
      if (!d.fleet) return card("wait", "Reading the models…");
      const words = routerWords(d.fleet.router);
      return card(words.tone, words.title, words.text, [
        h("div.card-sub", [...d.fleet.backends, ...d.fleet.routes].some(x => x.changed)
          ? `Your changes are saved in fleet.override.json (revision ${d.fleet.revision}). fleet.toml is never rewritten.`
          : `Nothing is changed: this is what fleet.toml says${d.fleet.source === "fleet.toml" ? "" : " (none found; the built-in defaults)"}.`),
        d.fleet.problem && h("div.card-sub", `The saved changes could not be used: ${d.fleet.problem}. Saving replaces them.`)]);
    });

    render(body, JSON.stringify([d.fleet, drafts.routes, busy]), () => {
      const fleet = d.fleet;
      if (!fleet) return [];
      if (!fleet.routes.length) return empty("No routes.", "layers");
      const routes = section("Chat routes", { icon: "layers", key: "models.routes" });
      routes.count(fleet.routes.length);
      routes.body.append(...fleet.routes.map(r => routeCard(r, fleet)));
      const backends = section("Backends and their models", { icon: "sliders", key: "models.backends" });
      backends.count(fleet.backends.length);
      backends.body.append(...fleet.backends.map(backendRow));
      const rest = section("Writing lanes and the judge", { icon: "scroll", key: "models.lanes" });
      rest.body.append(h("div.model-ro-list", readOnly(fleet)));
      const needs = section("What a change needs", { icon: "info", key: "models.needs" });
      needs.body.append(...APPLIES.map(a => h("div.setting",
        h("div.setting-text", h("div.setting-label", a.area), h("div", h("span.pill", a.when)), h("div.hint", a.text)))));
      return [routes.el, backends.el, rest.el, needs.el];
    });
  }

  // "loreEdit" is how the page learns the gate has turned this panel on (see rail.js).
  on("panel loreEdit", () => {
    if (visible()) load();
    schedule();
  });
  if (visible()) { load(); schedule(); } else draw();
}
