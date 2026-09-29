// App state and a tiny publish/subscribe bus. Components read `state` and subscribe to topics:
//   snapshot  /bots arrived               conn       connection status changed
//   regard, lore, companies, chronicle, commands, memories   a data file changed
//   ties (guid)    one person's tie file arrived        archive (name)  a whole-list file arrived
//   botmemories (guid)  one bot's memory file arrived   open-memories   shows every memory, full screen
//   journeys   the index of who has a journey changed   journey (guid)  one character's record arrived
//   open-journey ({ guid }) shows one character's whole record, full screen
//   open-feelings ({ view }) shows one of the Feelings lists whole, full screen
//   selection, continent, panel, theme, busy, layers   UI state changed
//   focus (player), focus-zone (zone id), mapcounts ({ total, counts, perMap }), focus-search
//   chronicle-faction (the scribe being read), open-chronicle ({ mine } shows the full-screen reader, mine: the player's own)
//   open-groups ({ key } shows the wall of bot companies, key: one company's own map and talk)
//   rumours (data file), rumour-focus ({ scroll }) the story on the map changed, rumour-replay draws its spread again

export function localGet(key) { try { return localStorage.getItem("dash." + key); } catch { return null; } }
export function localSet(key, value) { try { localStorage.setItem("dash." + key, value); } catch {} }

export const state = {
  // Data from the server
  snap: null,
  players: [],
  byGuid: new Map(),
  worldmap: null,
  mapArt: [],             // maps/manifest.json entries, [] when no art is installed
  regard: null,           // data/regard.json from regard.py
  lore: null,             // data/lore.json from gen_backstories.py
  companies: null,        // data/companies.json from regard.py (plan 14)
  chronicle: null,        // data/chronicle.json from chronicler.py (plan 19)
  rumours: null,          // data/rumours.json from chronicler.py (overheard.py): stories, their spread, who passed them on
  accounting: null,       // data/accounting.json from accounting.export: model request costs (Costs page)
  accountingError: "",
  market: null,           // data/market.json from market.py (plan 17 §3.E)
  chat: null,             // data/chat.json from regard.py: the party lines, for the Groups panel
  memories: null,         // data/memories.json from regard.py: what the bots still carry (plan 38)
  ties: new Map(),        // guid -> { stamp, doc }: one person's whole standing, fetched on demand
  botMemories: new Map(), // guid -> { stamp, doc }: everything one bot carries, fetched on demand
  journeys: null,         // data/journeys.json from regard.py: who has a journey, and every place named
  journey: new Map(),     // guid -> { stamp, doc }: one character's whole record, fetched on demand
  archive: new Map(),     // "moments" | "talks" | "ranked" -> { stamp, doc }: the whole of a list, on demand
  commands: null,         // GET /commands
  history: { bots: [], avg: [] },
  conn: { ok: false, ts: 0, seen: 0, text: "Connecting…" }, // seen: browser ms of the last fresh snapshot

  // UI
  theme: localGet("theme") === "light" ? "light" : "dark",
  continent: localGet("continent") || "0",
  panel: localGet("panel") || "roster",
  dockOpen: localGet("dock") !== "0",
  inspectorTab: localGet("itab") || "story",
  chronicleFaction: localGet("chronicle") || "A",
  chronicleHouse: localGet("house") || "",   // whose own chronicle: a main guid from chronicle.json households
  rosterView: localGet("roster") || "notable",
  rumourSide: localGet("rside") || "all",   // "all" | "A" | "H"
  rumourSort: localGet("rsort") || "new",
  rumourRoot: null,       // the story drawn on the map (its first telling's id), null: where word is now
  query: "",
  token: localGet("token") || "",
  layers: {
    art: localGet("art") !== "0",
    outlines: localGet("outlines") === "1",
    holdings: localGet("holdings") !== "0",
  },
  hidden: new Set(),      // marker states hidden from the map via the legend
  selected: null,         // character guid
  selectedCompany: null,  // guild id, shown when no character is selected
  lastResult: null,       // { guid, ok, text } of the last command
  busy: false,
};

const subs = new Map();

export function on(topics, fn) {
  for (const t of topics.split(/\s+/).filter(Boolean)) {
    if (!subs.has(t)) subs.set(t, new Set());
    subs.get(t).add(fn);
  }
}

export function emit(topic, payload) {
  for (const fn of subs.get(topic) || []) {
    try { fn(payload); } catch (e) { console.error(`[dashboard] ${topic} handler failed`, e); }
  }
}
