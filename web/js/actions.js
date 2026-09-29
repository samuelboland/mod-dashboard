// State changes shared by several components.
import { state, emit, localSet } from "./state.js";
import { refreshCommands } from "./api.js";
import { onAnyContinent } from "./lib/world.js";
import { toast } from "./components/toast.js";

const phone = () => matchMedia("(max-width: 760px)").matches;

export function select(guid, pan) {
  if (guid !== state.selected) state.lastResult = null;
  state.selected = guid;
  state.selectedCompany = null;
  const p = state.byGuid.get(guid);
  if (p && pan && onAnyContinent(p)) {
    if (String(p.map) !== state.continent) setContinent(String(p.map), false);
    emit("focus", p);
  }
  emit("selection");
}

// Select a character from a name link; they may not be in the world right now.
export function goTo(guid, name) {
  if (state.byGuid.has(guid)) select(guid, true);
  else toast({ tone: "info", title: `${name || "They"} ${name ? "is" : "are"} not in the world right now`, text: "Only characters who are online can be shown." });
}

export function selectCompany(gid) {
  state.selectedCompany = gid;
  state.selected = null;
  state.lastResult = null;
  emit("selection");
}

export function clearSelection() {
  if (state.selected == null && state.selectedCompany == null) return;
  state.selected = null;
  state.selectedCompany = null;
  state.lastResult = null;
  emit("selection");
}

export function setContinent(id, fit = true) {
  state.continent = id;
  localSet("continent", id);
  emit("continent", { fit });
}

export function setPanel(id) {
  if (state.panel === id && state.dockOpen && !phone()) {
    setDock(false);
    return;
  }
  state.panel = id;
  localSet("panel", id);
  state.dockOpen = true;
  localSet("dock", "1");
  emit("panel");
  if (id === "commands") refreshCommands();
}

export function setDock(open) {
  state.dockOpen = open;
  localSet("dock", open ? "1" : "0");
  emit("panel");
}

export function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localSet("theme", theme);
  emit("theme");
}

export async function sendCommand(cmd, p) {
  if (!state.conn.ok || state.busy) {
    toast({ tone: "info", title: "Command not sent", text: state.busy ? "A command is already pending." : "The realm is disconnected." });
    return;
  }
  const token = state.token.trim();
  if (!token) {
    setPanel("commands");
    emit("need-token");
    state.lastResult = { guid: p.guid, ok: false, text: "Enter the command token first (Commands panel)." };
    emit("busy");
    return;
  }
  state.busy = true;
  emit("busy");
  try {
    const res = await fetch("cmd/" + cmd, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashboard-Token": token },
      body: JSON.stringify({ guid: p.guid }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
    state.lastResult = { guid: p.guid, ok: !!body.ok, text: body.message || `HTTP ${res.status}` };
    if (res.status === 401) { setPanel("commands"); emit("need-token"); }
  } catch (e) {
    state.lastResult = { guid: p.guid, ok: false, text: `Delivery unconfirmed: ${e.message}. Check command history before trying again.` };
  } finally {
    state.busy = false;
    const r = state.lastResult;
    toast({ ok: r.ok, title: `${cmd === "pause" ? "Pause" : "Resume"} ${p.name}`, text: r.text });
    emit("busy");
    refreshCommands();
  }
}
