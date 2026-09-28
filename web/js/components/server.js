// Optional realm lifecycle view. The standalone host owns the narrow admin adapter.
import { on, state, localGet, localSet } from "../state.js";
import { h, icon } from "../lib/dom.js";

const gib = bytes => `${(bytes / 1073741824).toFixed(2)} GiB`;
const chart = (root, samples, key) => {
  root.replaceChildren();
  const values = samples.map(sample => sample[key]);
  if (values.length < 2) return;
  const max = Math.max(1, ...values);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", values.map((value, i) =>
    `${i ? "L" : "M"}${(i * 300 / (values.length - 1)).toFixed(1)},${(52 - value / max * 48).toFixed(1)}`).join(""));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  root.append(path);
};

export function mountServer(panel) {
  let token = localGet("controlToken") || "";
  let current = null;
  let busy = false;
  let polling = false;
  let lastJob = "";

  const status = h("div.server-status", { role: "status" }, "Enter the control token to view server status.");
  const key = h("input.input", { type: "password", autocomplete: "off", spellcheck: "false",
    "aria-label": "Server control token", placeholder: "Server control token", value: token });
  const connect = h("button.btn", { type: "button" }, "Connect");
  const unlock = h("div.server-unlock", key, connect);
  const cpu = h("strong", "—"), memory = h("strong", "—");
  const graph = label => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("server-chart");
    svg.setAttribute("viewBox", "0 0 300 56");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    return svg;
  };
  const cpuChart = graph("CPU usage history");
  const memoryChart = graph("Memory usage history");
  const cpuNote = h("span.server-note"), memoryNote = h("span.server-note");
  const card = (label, value, note, graph) => h("div.server-card", h("div.server-label", label), value, note, graph);
  const start = h("button.btn.btn-go", { type: "button" }, icon("play", 14), "Start realm");
  const stop = h("button.btn", { type: "button" }, icon("pause", 14), "Stop realm");
  const services = h("div.server-services");
  const updated = h("p.server-note");
  const notice = h("p.server-note", { role: "status" });
  panel.append(status, unlock, h("div.server-cards",
    card("CPU · realm and database", cpu, cpuNote, cpuChart),
    card("Memory · realm and database", memory, memoryNote, memoryChart)),
  services, h("div.server-actions", start, stop), updated, notice);

  const lock = () => {
    start.disabled = busy || !current?.available || (current.phase !== "stopped" && current.phase !== "unknown");
    stop.disabled = busy || !current?.workshopRunning;
  };
  lock();

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, cache: "no-store", signal: AbortSignal.timeout(25000),
      headers: { ...options.headers, "X-Control-Token": token } });
    const body = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? "Control token rejected." : body.error || `HTTP ${response.status}`);
    return body;
  }

  async function refresh() {
    if (!token || polling || state.panel !== "server") return;
    polling = true;
    try {
      const next = await request("api/server/state");
      current = next;
      const names = { online: "Online", starting: "Starting", stopped: "Stopped", unknown: "Status unknown", unavailable: "Management unavailable" };
      status.textContent = `Realm: ${names[next.phase] || "Status unknown"}`;
      status.classList.toggle("online", next.phase === "online");
      const sample = next.samples.at(-1);
      cpu.textContent = sample ? `${sample.cpuPercent.toFixed(1)}%` : "—";
      memory.textContent = sample ? gib(sample.memoryBytes) : "—";
      cpuNote.textContent = next.logicalCpus ? `${(sample?.cpuPercent / 100 || 0).toFixed(2)} cores of ${next.logicalCpus} logical CPUs` : "100% equals one logical CPU";
      memoryNote.textContent = sample ? "Current container usage" : "No samples yet";
      chart(cpuChart, next.samples, "cpuPercent");
      chart(memoryChart, next.samples, "memoryBytes");
      services.textContent = `Realm container: ${next.workshopRunning ? "running" : "stopped"} · Database: ${next.databaseRunning ? "running" : "stopped"}`;
      updated.textContent = `Checked ${new Date(next.checkedAt).toLocaleTimeString()}`;
      const job = await request("api/server/job");
      if (job?.status === "running") {
        busy = true;
        notice.textContent = `${job.action} in progress…`;
      } else if (busy) {
        busy = false;
        if (job?.id && job.id !== lastJob) {
          lastJob = job.id;
          notice.textContent = job.status === "done" ? `${job.action} finished.` : `${job.action} failed. Check the management service.`;
        }
      }
      lock();
    } catch (error) {
      current = null;
      status.textContent = error.message;
      lock();
    } finally { polling = false; }
  }

  connect.addEventListener("click", () => {
    token = key.value.trim();
    localSet("controlToken", token);
    current = null;
    status.textContent = token ? "Connecting…" : "Enter the control token to view server status.";
    lock();
    void refresh();
  });
  key.addEventListener("keydown", event => { if (event.key === "Enter") connect.click(); });

  async function action(which) {
    if (busy || !current) return;
    if (which === "stop" && !confirm("Stop the realm? Connected players will be disconnected.")) return;
    busy = true;
    lock();
    notice.textContent = `${which} requested…`;
    try {
      const job = await request("api/server/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: which }) });
      lastJob = "";
      notice.textContent = `${job.action} in progress…`;
    } catch (error) {
      busy = false;
      notice.textContent = `${error.message} Check status before trying again.`;
      lock();
    }
    void refresh();
  }
  start.addEventListener("click", () => { void action("start"); });
  stop.addEventListener("click", () => { void action("stop"); });
  on("panel", () => { if (state.panel === "server") void refresh(); });
  setInterval(() => { if (state.panel === "server") void refresh(); }, 15000);
  if (state.panel === "server") void refresh();
}
