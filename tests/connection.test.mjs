import assert from "node:assert/strict";
import test from "node:test";
import { refreshLive } from "../web/js/api.js";
import { state } from "../web/js/state.js";

test("cold offline start recovers the map and retains explicitly disconnected snapshots", async t => {
  let online = false;
  let mapReads = 0;
  const snapshot = { ts: Math.floor(Date.now() / 1000), players: [], counts: { bots: 3 }, update_ms: { avg: 1 } };
  t.mock.method(globalThis, "fetch", async url => {
    if (!online) throw new Error("offline");
    if (url === "worldmap") mapReads++;
    return { ok: true, json: async () => url === "bots" ? snapshot : { zones: [], continents: {} } };
  });
  state.worldmap = null;
  state.snap = null;
  state.conn = { ok: false, ts: 0, text: "Connecting…" };
  await refreshLive();
  assert.equal(state.conn.ok, false);
  assert.equal(state.snap, null);
  online = true;
  await refreshLive();
  assert.equal(state.conn.ok, true);
  assert.equal(mapReads, 1);
  assert.equal(state.snap, snapshot);
  online = false;
  await refreshLive();
  assert.equal(state.conn.ok, false);
  assert.equal(state.conn.ts, snapshot.ts);
  assert.equal(state.snap, snapshot);
  online = true;
  await refreshLive();
  assert.equal(state.conn.ok, true);
  assert.equal(mapReads, 1);
  // A viewer whose clock is ten minutes off still sees a live realm while the snapshot keeps changing.
  snapshot.ts -= 600;
  await refreshLive();
  assert.equal(state.conn.ok, true);
  // A snapshot that stops changing goes stale by this browser's clock, whatever the server's says.
  const frozenAt = Date.now();
  t.mock.method(Date, "now", () => frozenAt + 31000);
  await refreshLive();
  assert.equal(state.conn.ok, false);
  assert.equal(state.conn.ts, snapshot.ts);
  assert.equal(state.conn.seen <= frozenAt, true);
  assert.match(state.conn.text, /stale/);
});
