// Server polling. Each loop reschedules itself after it finishes, so slow responses never pile up.
import { state, emit } from "./state.js";
import { isAccountingSnapshot } from "./lib/accounting.js";

const REFRESH_MS = 2000;
const DATA_MS = 30000;
const LORE_MS = 300000;
const MARKET_MS = 60000;   // market.py rewrites its file every 10 minutes
const JOURNEY_MS = 60000;  // the journeys are rebuilt on the same ten-minute cadence
const HISTORY = 90;   // samples kept for the top-bar sparklines (3 minutes at 2 s)

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(res.status === 503 ? "snapshot not ready" : `HTTP ${res.status}`);
  return res.json();
}

function loop(fn, ms) {
  const tick = async () => {
    try { await fn(); } catch {} finally { setTimeout(tick, ms); }
  };
  tick();
}

const push = (arr, v) => { arr.push(v); if (arr.length > HISTORY) arr.shift(); };

export async function refreshWorldmap() {
  try {
    state.worldmap = await getJSON("worldmap");
    emit("continent", { fit: true });
  } catch { /* Retried with live polling until the realm becomes available. */ }
}

export async function loadStatic() {
  try { state.mapArt = await getJSON("maps/manifest.json"); } catch { state.mapArt = []; }
  emit("continent", { fit: false });
}

export async function refreshCommands() {
  try {
    state.commands = await getJSON("commands");
    emit("commands");
  } catch {}
}

// A person's whole standing lives in a file of its own, fetched when their Ties tab is opened:
// a well-travelled bot has upwards of 150 ties, far too many to carry in regard.json. The cache
// entry is stamped with the regard.json it was fetched beside, so a new cycle refetches it; the
// ties already on screen stay there while it does, and `at` tells the inspector to redraw.
export function loadTies(guid) {
  const stamp = state.regard?.generated;
  const held = state.ties.get(guid);
  if (held && held.stamp === stamp) return;
  state.ties.set(guid, { stamp, doc: held?.doc || null, at: held?.at || 0 });
  const land = doc => { state.ties.set(guid, { stamp, doc, at: Date.now() }); emit("ties", guid); };
  getJSON(`data/ties/${guid}.json`).then(land, () => land(held?.doc || { feels: [], felt_by: [] }));
}

// Everything one bot carries, fetched when their Memories tab is opened. Same shape as the ties above and
// for the same reason: the panel's own file holds only the newest 400 across the whole world, so a bot's
// own memories are not in it. Stamped against memories.json, so a new cycle refetches.
export function loadMemories(guid) {
  const stamp = state.memories?.generated;
  const held = state.botMemories.get(guid);
  if (held && held.stamp === stamp) return;
  state.botMemories.set(guid, { stamp, doc: held?.doc || null, at: held?.at || 0 });
  const land = doc => { state.botMemories.set(guid, { stamp, doc, at: Date.now() }); emit("botmemories", guid); };
  getJSON(`data/memories/${guid}.json`).then(land, () => land(held?.doc || { memories: [] }));
}

// One character's whole record, fetched when their journey is opened (plans/42). Same shape as the
// ties and memories above and for the same reason: the index beside it is a light list of who has one,
// and a well-travelled character's own record runs to a thousand entries and 300 KB.
export function loadJourney(guid) {
  const stamp = state.journeys?.generated;
  const held = state.journey.get(guid);
  if (held && held.stamp === stamp && held.doc) return;
  state.journey.set(guid, { stamp, doc: held?.doc || null, at: held?.at || 0, failed: false });
  const land = (doc, failed) => { state.journey.set(guid, { stamp, doc, at: Date.now(), failed }); emit("journey", guid); };
  getJSON(`data/journeys/${guid}.json`).then(doc => land(doc, false), () => land(held?.doc || null, true));
}

// The whole of one of the Feelings panel's lists -- every moment, every conversation overheard, every
// tie ranked warmest to coldest. Megabytes each, so they are fetched only when a full-screen view asks
// for one, and re-fetched when regard.py has written a newer set.
export function loadArchive(name, force = false) {
  const stamp = state.regard?.generated;
  const held = state.archive.get(name);
  if (held && held.stamp === stamp && !force) return;
  state.archive.set(name, { stamp, doc: held?.doc || null, at: held?.at || 0, failed: false });
  const land = (doc, failed) => { state.archive.set(name, { stamp, doc, at: Date.now(), failed }); emit("archive", name); };
  getJSON(`data/${name}.json`).then(doc => land(doc, false), () => land(held?.doc || null, true));
}

let accountingPending = null;
export function refreshAccounting() {
  if (accountingPending) return accountingPending;
  accountingPending = (async () => {
    try {
      const next = await getJSON("data/accounting.json");
      if (!isAccountingSnapshot(next))
        throw new Error("Unsupported accounting snapshot");
      state.accounting = next;
      state.accountingError = "";
    } catch {
      state.accountingError = "Accounting data could not be refreshed.";
    } finally {
      accountingPending = null;
      emit("accounting");
    }
  })();
  return accountingPending;
}

export function startPolling() {
  loop(refreshAccounting, DATA_MS);
  loop(refreshLive, REFRESH_MS);

  // Data files are rewritten by services; these remain readable without the realm.
  const stampOf = doc => doc.generated ?? doc.generated_at;
  const watch = (url, key, ms) => loop(async () => {
    const next = await getJSON(url);
    if (!state[key] || stampOf(next) === undefined || stampOf(next) !== stampOf(state[key])) {
      state[key] = next;
      emit(key);
    }
  }, ms);
  watch("data/regard.json", "regard", DATA_MS);
  watch("data/companies.json", "companies", DATA_MS);
  watch("data/chronicle.json", "chronicle", DATA_MS);
  watch("data/rumours.json", "rumours", DATA_MS);
  watch("data/lore.json", "lore", LORE_MS);
  watch("data/lore-edit.json", "loreEdit", DATA_MS);
  watch("data/market.json", "market", MARKET_MS);
  watch("data/chat.json", "chat", DATA_MS);
  watch("data/memories.json", "memories", DATA_MS);
  watch("data/journeys.json", "journeys", JOURNEY_MS);
}

// Staleness is judged on this browser's clock alone: how long since the snapshot last changed.
// Comparing snap.ts with Date.now() would mark a live realm dead from a viewer whose clock is off.
const STALE_MS = 30000;
let lastTs = null, lastChange = 0;

export async function refreshLive() {
  try {
    const snap = await getJSON("bots");
    if (!Number.isFinite(snap.ts)) throw new Error("world snapshot has no time");
    const now = Date.now();
    if (snap.ts !== lastTs) { lastTs = snap.ts; lastChange = now; }
    else if (now - lastChange > STALE_MS) throw new Error("world snapshot is stale");
    state.snap = snap;
    state.players = snap.players;
    state.byGuid = new Map(snap.players.map(p => [p.guid, p]));
    push(state.history.bots, snap.counts.bots);
    push(state.history.avg, snap.update_ms.avg);
    state.conn = { ok: true, ts: snap.ts, seen: now, text: "" };
    emit("snapshot");
  } catch (e) {
    state.conn = { ok: false, ts: state.conn.ts, seen: state.conn.seen, text: e.message };
  }
  emit("conn");
  if (state.conn.ok) {
    if (!state.worldmap) await refreshWorldmap();
    if (state.panel === "commands" && state.dockOpen) refreshCommands();
  }
}
