// Commands panel: the token, whether commands are on, and the server's recent results.
import { state, on, localSet } from "../state.js";
import { h, icon, render } from "../lib/dom.js";
import { clockS } from "../lib/format.js";
import { section, empty } from "./common.js";

export function mountCommands(panel) {
  const status = h("div");
  const input = h("input.input", { type: "password", placeholder: "Dashboard.CommandToken", autocomplete: "off", spellcheck: "false", "aria-label": "Command token", value: state.token });
  const reveal = h("button.icon-btn.field-end", { type: "button", title: "Show the token", on: { click: () => {
    const shown = input.type === "text";
    input.type = shown ? "password" : "text";
    reveal.replaceChildren(icon(shown ? "eye" : "eyeOff", 15));
    reveal.title = shown ? "Show the token" : "Hide the token";
  } } }, icon("eye", 15));
  const log = section("Recent results", { icon: "terminal", key: "cmd.log" });
  panel.append(
    status,
    h("div.field", icon("key", 15), input, reveal),
    h("div.hint", "Sent as X-Dashboard-Token. Kept in this browser only."),
    log.el);

  input.addEventListener("input", () => { state.token = input.value; });
  input.addEventListener("change", () => localSet("token", input.value.trim()));
  on("need-token", () => { input.focus(); input.select(); });

  on("commands conn", () => {
    const c = state.commands;
    const enabled = state.conn.ok && c?.enabled;
    render(status, `${state.conn.ok}|${enabled}`, () => h("div.status-card", { class: enabled ? "" : "off" },
      h("span.seal", icon(enabled ? "check" : "alert", 18)),
      h("div",
        h("div.card-title", !state.conn.ok ? "Realm unavailable" : enabled ? "Commands are on" : "Commands are off"),
        h("div.card-sub", !state.conn.ok ? "Commands require a live connection. Any results below are from the last refresh."
          : enabled ? "Pause and resume from the inspector." : "The server has no Dashboard.CommandToken."))));
    const recent = c?.recent.slice(0, 20) || [];
    log.count(recent.length);
    render(log.body, JSON.stringify(recent), () => recent.length ? recent.map(r => {
      const p = state.byGuid.get(r.guid);
      return h("div.log-item", { class: r.ok ? "ok" : "bad" },
        icon(r.ok ? "check" : "alert", 14),
        h("div", r.cmd !== "system" && h("b", `${r.cmd} ${p ? p.name : "#" + r.guid}: `), h("span.log-text", r.message)),
        h("span.ts", clockS(r.ts)));
    }) : empty("No commands sent since the server started.", "terminal"));
  });
}
