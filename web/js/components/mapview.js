// World map: continent art, zone outlines and names, company holdings, character markers,
// plus the floating controls (continent switch, layers, legend, zoom).
import { state, on, emit, localGet, localSet } from "../state.js";
import { h, icon, esc } from "../lib/dom.js";
import { CONTINENTS, CLASS_COLORS } from "../lib/format.js";
import { css, STATES, stateOf, onContinent, describe, where, isContinent, companyColor, companyName } from "../lib/world.js";
import { select, selectCompany, setContinent } from "../actions.js";
import { HOP_NAMES } from "./rumours.js";

const ZONE_ART_ZOOM = -3.5;   // zone images replace the continent image's detail from here in
const LABEL_ZOOM = -3;

// WoW world axes: +x is north, +y is west. Leaflet lat grows north, lng east.
const toLatLng = (x, y) => [x, -y];
const areaBounds = a => L.latLngBounds(toLatLng(a.bottom, a.left), toLatLng(a.top, a.right));

export function mountMap(stage) {
  const el = stage.querySelector("#map");
  if (!window.L) {
    stage.append(h("div.map-error", icon("alert", 18), "The map library could not load. The panels still work."));
    return;
  }

  const map = L.map(el, { crs: L.CRS.Simple, minZoom: -6, maxZoom: 3, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: false, zoomControl: false });
  // Explicit panes keep the stacking fixed: art < zone art < outlines < holdings < markers < selection ring.
  for (const [name, z] of [["art", 210], ["zoneart", 220], ["zones", 380], ["holdings", 390], ["rumours", 400], ["dots", 420]]) map.createPane(name).style.zIndex = z;
  const zoneRenderer = L.svg({ pane: "zones" });
  const holdingRenderer = L.svg({ pane: "holdings" });
  const dotRenderer = L.svg({ pane: "dots" });

  const artLayer = L.layerGroup().addTo(map);
  const zoneArtLayer = L.layerGroup().addTo(map);
  const zoneLayer = L.layerGroup().addTo(map);
  const holdingLayer = L.layerGroup().addTo(map);
  const rumourLayer = L.layerGroup().addTo(map);
  const rumourRenderer = L.svg({ pane: "rumours" });
  const markerLayer = L.layerGroup().addTo(map);
  const ring = L.marker([0, 0], { icon: L.divIcon({ className: "sel-ring", html: "<i></i><i></i>", iconSize: [38, 38] }), interactive: false, keyboard: false });

  const markers = new Map();
  const zoneArt = new Map();   // manifest file -> L.imageOverlay
  let bounds = null;

  // ---- Art ----
  const artOn = () => state.layers.art && state.mapArt.length > 0;
  const continentArt = () => state.mapArt.filter(a => String(a.map) === state.continent && !a.zone);
  const areaSize = a => Math.abs((a.top - a.bottom) * (a.left - a.right));
  // Big zones first so cities and small zones draw on top of their neighbours.
  const zoneArtEntries = () => state.mapArt.filter(a => String(a.map) === state.continent && a.zone).sort((a, b) => areaSize(b) - areaSize(a));

  function drawArt() {
    artLayer.clearLayers();
    zoneArtLayer.clearLayers();
    zoneArt.clear();
    el.classList.toggle("art", artOn());
    if (!artOn()) return;
    for (const a of continentArt()) L.imageOverlay("maps/" + a.file, areaBounds(a), { interactive: false, pane: "art" }).addTo(artLayer);
    updateZoneArt();
  }

  // Zone images are only loaded near the current view, and only when zoomed in.
  function updateZoneArt() {
    if (!artOn()) return;
    const show = map.getZoom() >= ZONE_ART_ZOOM;
    const view = map.getBounds().pad(0.25);
    const entries = zoneArtEntries();
    for (const a of entries) {
      const wanted = show && view.intersects(areaBounds(a));
      const existing = zoneArt.get(a.file);
      if (wanted && !existing) {
        const overlay = L.imageOverlay("maps/" + a.file, areaBounds(a), { interactive: false, pane: "zoneart" });
        zoneArt.set(a.file, overlay);
        zoneArtLayer.addLayer(overlay);
      } else if (!wanted && existing) {
        zoneArtLayer.removeLayer(existing);
        zoneArt.delete(a.file);
      }
    }
    for (const a of entries) zoneArt.get(a.file)?.bringToFront();
  }

  // ---- Zones ----
  function drawZones() {
    zoneLayer.clearLayers();
    if (!state.worldmap) return null;
    const outlines = state.layers.outlines || !artOn();
    let b = null;
    for (const z of state.worldmap.zones) {
      if (String(z.map) !== state.continent) continue;
      const zb = areaBounds(z);
      b = b ? b.extend(zb) : zb;
      if (outlines) L.rectangle(zb, { renderer: zoneRenderer, color: css("--zone"), weight: 1, fill: false, interactive: false }).addTo(zoneLayer);
      L.marker(zb.getCenter(), { icon: L.divIcon({ className: "zone-anchor", iconSize: [0, 0] }), interactive: false, keyboard: false })
        .bindTooltip(esc(z.name), { permanent: true, direction: "center", className: "zone-label" })
        .addTo(zoneLayer);
    }
    return b;
  }

  const updateLabels = () => el.classList.toggle("labels", map.getZoom() >= LABEL_ZOOM);

  // ---- Company holdings ----
  function drawHoldings() {
    holdingLayer.clearLayers();
    const co = state.companies;
    if (!co || !state.worldmap || !state.layers.holdings) return;
    const gid = state.selectedCompany;
    const mine = gid ? co.companies[String(gid)] : null;
    const seatZones = new Set((mine?.seats || []).map(s => s.zone));
    for (const z of state.worldmap.zones) {
      if (String(z.map) !== state.continent) continue;
      const land = co.lands[String(z.zone)];
      if (!land || (!land.holder && !seatZones.has(z.zone))) continue;
      const seat = seatZones.has(z.zone);
      const color = land.holder ? companyColor(land.holder) : css("--zone");
      const rect = L.rectangle(areaBounds(z), {
        renderer: holdingRenderer,
        color: seat ? companyColor(gid) : color,
        weight: seat ? 3 : land.challenger ? 2 : 1,
        dashArray: land.challenger ? "6 4" : null,
        fillColor: color,
        fillOpacity: mine ? (land.holder === gid ? 0.35 : 0.06) : 0.18,
      }).addTo(holdingLayer);
      const tip = h("div",
        h("div.tt-title", `${land.name} (${land.levels[0]}–${land.levels[1]})`),
        h("span.tt-line", land.holder ? `Held by ${companyName(land.holder)}` : "Held by nobody"),
        land.challenger && h("span.tt-line", `Contested by ${companyName(land.challenger)}`),
        land.influence.length > 0 && h("span.tt-line", "Influence: " + land.influence.slice(0, 3).map(([g, v]) => `${companyName(g)} ${v}`).join(", ")),
        seat && h("span.tt-line", `${companyName(gid)} keep a seat here`));
      rect.bindTooltip(tip, { sticky: true, className: "map-tip" });
      if (land.holder) rect.on("click", () => selectCompany(land.holder));
    }
  }

  // ---- Markers ----
  const tooltip = m => {
    const p = m._p;
    return `<div class="tt-name" style="color:${CLASS_COLORS[p.class] || "#fff"}">${esc(p.name)}</div>`
      + `<div class="tt-sub">${esc(describe(p))}</div><div class="tt-zone">${esc(where(p) || "")}</div>`;
  };

  function drawMarkers() {
    const counts = Object.fromEntries(STATES.map(([k]) => [k, 0]));
    const perMap = {};
    const seen = new Set();
    const ringColor = css("--dot-ring"), edge = css("--dot-edge");
    const colors = Object.fromEntries(STATES.map(([k]) => [k, css("--" + k)]));
    let selectedMarker = null;
    for (const p of state.players) {
      if (!p.instance) perMap[p.map] = (perMap[p.map] || 0) + 1;
      if (!onContinent(p)) continue;
      const st = stateOf(p);
      counts[st]++;
      if (state.hidden.has(st)) continue;
      seen.add(p.guid);
      const sel = p.guid === state.selected;
      const loud = !p.bot || p.paused || sel;
      const style = {
        renderer: dotRenderer,
        radius: sel ? 7.5 : !p.bot ? 7 : p.paused ? 6 : 4.5,
        color: loud ? ringColor : edge,
        weight: loud ? 2 : 1,
        opacity: 1,
        fillColor: colors[st],
        fillOpacity: 0.95,
      };
      let m = markers.get(p.guid);
      if (!m) {
        m = L.circleMarker(toLatLng(p.x, p.y), style).addTo(markerLayer);
        m.on("click", () => select(m._p.guid, false));
        m.bindTooltip(tooltip, { direction: "top", offset: [0, -6], className: "dot-tip" });
        markers.set(p.guid, m);
      } else {
        m.setLatLng(toLatLng(p.x, p.y)).setStyle(style);
      }
      m._p = p;
      if (!p.bot || p.paused) m.bringToFront();
      if (sel) selectedMarker = m;
    }
    for (const [guid, m] of markers) {
      if (!seen.has(guid)) { markerLayer.removeLayer(m); markers.delete(guid); }
    }
    if (selectedMarker) {
      selectedMarker.bringToFront();
      ring.setLatLng(selectedMarker.getLatLng());
      if (!map.hasLayer(ring)) ring.addTo(map);
    } else if (map.hasLayer(ring)) {
      ring.remove();
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    emit("mapcounts", { total, counts, perMap });
  }

  function redraw(fit) {
    markerLayer.clearLayers();
    markers.clear();
    const b = drawZones();
    if (b) bounds = b;
    if (fit && b) map.fitBounds(b, { padding: [30, 30] });
    drawArt();
    drawHoldings();
    updateLabels();
    drawMarkers();
    for (const btn of segButtons) btn.classList.toggle("on", btn.dataset.id === state.continent);
  }

  // ---- Rumours (the Rumours panel): one story's spread, or where word is going around now ----
  let rumourFitPending = false;   // the story's own continent is being switched to; fit it once it is there
  const HOP_OPACITY = [1, 0.8, 0.6, 0.42];   // one hue per side, fading with every stop along the road
  const zoneOf = id => state.worldmap?.zones.find(z => z.zone === id && isContinent(z.map));
  const centre = id => { const z = zoneOf(id); return z ? { map: String(z.map), at: areaBounds(z).getCenter() } : null; };
  const rumoursShown = () => state.panel === "rumours" && state.dockOpen && state.rumours && state.worldmap;
  const sideColor = team => css(team === 1 ? "--horde" : "--alliance");

  // A gentle bow from a to b, so two roads out of one land do not lie on top of each other.
  function arc(a, b) {
    const dx = b.lng - a.lng, dy = b.lat - a.lat;
    const mid = L.latLng(a.lat + dy / 2 - dx * 0.18, a.lng + dx / 2 + dy * 0.18);
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, u = 1 - t;
      pts.push([u * u * a.lat + 2 * u * t * mid.lat + t * t * b.lat, u * u * a.lng + 2 * u * t * mid.lng + t * t * b.lng]);
    }
    return pts;
  }

  function drawRumours(fit) {
    rumourLayer.clearLayers();
    rumourKey.hidden = true;
    el.classList.toggle("rumour-mode", !!rumoursShown());
    if (!rumoursShown()) return;
    const r = state.rumours;
    const s = state.rumourRoot != null ? r.stories.find(x => x.root === state.rumourRoot) : null;
    if (s) drawStory(s, fit);
    else drawNow(r);
  }

  // Where word is going around right now, one ring per side per land, sized by how many tales.
  function drawNow(r) {
    const now = Date.now() / 1000;
    const per = new Map();   // "zone|team" -> tellings
    for (const s of r.stories) {
      if (state.rumourSide !== "all" && (state.rumourSide === "H") !== (s.team === 1)) continue;
      for (const t of s.tellings) if (t.until > now) for (const z of t.places) {
        const k = `${z}|${s.team}`;
        per.set(k, [...(per.get(k) || []), { s, t }]);
      }
    }
    for (const [k, list] of per) {
      const [zone, team] = k.split("|").map(Number);
      const c = centre(zone);
      if (!c || c.map !== state.continent) continue;
      const at = team === 1 ? L.latLng(c.at.lat - 90, c.at.lng + 90) : L.latLng(c.at.lat + 90, c.at.lng - 90);
      const tip = h("div", h("div.tt-title", r.places[String(zone)]?.name || ""),
        h("span.tt-line", `${list.length} ${list.length === 1 ? "tale" : "tales"} going around among the ${team === 1 ? "Horde" : "Alliance"}`),
        list.slice(0, 3).map(({ t }) => h("span.tt-line.tt-rumour", `“${t.words}”`)));
      L.circleMarker(at, { renderer: rumourRenderer, radius: 5 + Math.sqrt(list.length) * 4, color: sideColor(team), weight: 1.5,
        fillColor: sideColor(team), fillOpacity: 0.22 })
        .bindTooltip(tip, { sticky: true, className: "map-tip" })
        .on("click", () => { state.rumourRoot = list[0].s.root; emit("rumour-focus", { scroll: true }); })
        .addTo(rumourLayer);
    }
    const sides = state.rumourSide === "all" ? [0, 1] : [state.rumourSide === "H" ? 1 : 0];
    rumourKey.replaceChildren(h("div.pop-title", "Word going around now"),
      ...sides.map(t => h("div.rkey-row", h("i.rkey-ring", { style: { borderColor: sideColor(t), background: `color-mix(in srgb, ${sideColor(t)} 22%, transparent)` } }),
        `Told among the ${t === 1 ? "Horde" : "Alliance"}`)),
      h("div.rkey-away", "The bigger the ring, the more tales. Open a story to see how it travelled."));
    rumourKey.hidden = false;
  }

  function drawStory(s, fit) {
    const r = state.rumours;
    const color = sideColor(s.team);
    const roads = new Set(r.roads.map(([a, b]) => `${a}|${b}`));
    const road = (a, b) => roads.has(`${Math.min(a, b)}|${Math.max(a, b)}`);
    const origin = centre(s.origin);
    if (origin && origin.map !== state.continent && fit) { rumourFitPending = true; setContinent(origin.map, false); return; }
    const byId = new Map(s.tellings.map(t => [t.id, t]));
    const seen = [];
    const node = (zone, t, first) => {
      const c = centre(zone);
      if (!c || c.map !== state.continent) return;
      seen.push(c.at);
      const hop = Math.min(t.hop, 3);
      const tip = h("div", h("div.tt-title", r.places[String(zone)]?.name || ""),
        h("span.tt-line", first ? "Where it happened" : `${HOP_NAMES[hop]} · told ${new Date(t.told * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`),
        h("span.tt-line.tt-rumour", `“${t.words}”`));
      L.circleMarker(c.at, { renderer: rumourRenderer, radius: first ? 9 : 6, color: first ? css("--dot-ring") : color, weight: first ? 2.5 : 1.5,
        fillColor: color, fillOpacity: HOP_OPACITY[hop], className: `rumour-node hop${hop}` })
        .bindTooltip(tip, { sticky: true, className: "map-tip" }).addTo(rumourLayer);
    };
    for (const t of s.tellings) {
      const parent = byId.get(t.parent);
      const from = parent ? (parent.hop === 0 ? [s.origin] : parent.places) : [];
      for (const z of t.places) {
        if (t.hop === 0) continue;
        // The stop it came from: a land on the road to it, else the nearest place the telling before it was told.
        const to = centre(z);
        if (!to || to.map !== state.continent) continue;
        const src = from.find(f => road(f, z)) ?? from.map(f => [f, centre(f)]).filter(([, c]) => c && c.map === state.continent)
          .sort((a, b) => a[1].at.distanceTo(to.at) - b[1].at.distanceTo(to.at))[0]?.[0];
        const a = src != null && centre(src);
        if (!a || a.map !== state.continent || src === z) continue;
        L.polyline(arc(a.at, to.at), { renderer: rumourRenderer, color, weight: 2.5, opacity: HOP_OPACITY[Math.min(t.hop, 3)],
          className: `rumour-road hop${Math.min(t.hop, 3)}`, interactive: false }).addTo(rumourLayer);
      }
    }
    // Nodes over the roads, the farthest first so where it happened sits on top.
    for (const t of [...s.tellings].reverse()) for (const z of t.places) if (!(t.hop > 0 && z === s.origin)) node(z, t, false);
    node(s.origin, s.tellings[0], true);

    // Where someone was heard passing it on: a speech mark with the count.
    const heard = new Map();
    for (const e of r.evidence) if (e.root === s.root) heard.set(e.zone, [...(heard.get(e.zone) || []), e]);
    for (const [zone, lines] of heard) {
      const c = centre(zone);
      if (!c || c.map !== state.continent) continue;
      const tip = h("div", h("div.tt-title", `Heard in ${r.places[String(zone)]?.name || ""}`),
        lines.slice(0, 4).map(e => h("span.tt-line", h("b", e.name), ` “${e.text.length > 110 ? e.text.slice(0, 110) + "…" : e.text}”`)));
      L.marker(L.latLng(c.at.lat + 160, c.at.lng + 160), { pane: "rumours", keyboard: false,
        icon: L.divIcon({ className: "rumour-heard", html: `<span>${icon("message", 11).innerHTML}${lines.length}</span>`, iconSize: [34, 20], iconAnchor: [0, 20] }) })
        .bindTooltip(tip, { sticky: true, className: "map-tip" }).addTo(rumourLayer);
    }

    const away = s.places.filter(z => { const c = centre(z); return c && c.map !== state.continent; }).map(z => r.places[String(z)]?.name).filter(Boolean);
    rumourKey.replaceChildren(...[
      h("div.pop-title", s.origin_name ? `Word from ${s.origin_name}` : "Word going around"),
      HOP_NAMES.slice(0, s.hops + 1).map((name, i) => h("div.rkey-row", h("i.rkey-swatch", { style: { background: color, opacity: HOP_OPACITY[i] } }), name)),
      heard.size > 0 && h("div.rkey-row", h("span.rkey-heard", icon("message", 11)), "Heard passing it on"),
      away.length > 0 && h("div.rkey-away", `Over the sea to ${away.join(", ")}`)].flat().filter(Boolean));
    rumourKey.hidden = false;
    if (fit && seen.length) map.fitBounds(L.latLngBounds(seen), { padding: [70, 70], maxZoom: -1.5 });
  }

  // ---- Floating controls ----
  const segButtons = CONTINENTS.map(([id, name]) =>
    h("button", { type: "button", dataset: { id }, on: { click: () => setContinent(id) } }, name, h("span.n")));
  const seg = h("div.map-ctl.map-top.seg", { role: "tablist", "aria-label": "Continent" }, segButtons);

  const LAYERS = [["art", "Map art", "The painted world map"], ["outlines", "Zone outlines", "A border around each zone"], ["holdings", "Company holdings", "Lands held or contested"]];
  const pop = h("div.map-ctl.pop", { hidden: true },
    h("div.pop-title", "Layers"),
    LAYERS.map(([key, label, hint]) => h("label.switch-row",
      h("span", label, h("small", hint)),
      h("input.switch", { type: "checkbox", checked: state.layers[key], on: { change: e => setLayer(key, e.target.checked) } }))));
  const layersBtn = h("button.map-ctl.ctl-btn", { type: "button", "aria-haspopup": "true", on: { click: e => { e.stopPropagation(); pop.hidden = !pop.hidden; layersBtn.classList.toggle("on", !pop.hidden); } } },
    icon("layers", 16), "Layers");
  const layersWrap = h("div.map-layers", layersBtn, pop);
  document.addEventListener("click", e => { if (!layersWrap.contains(e.target)) { pop.hidden = true; layersBtn.classList.remove("on"); } });

  function setLayer(key, value) {
    state.layers[key] = value;
    localSet(key, value ? "1" : "0");
    if (key === "holdings") drawHoldings();
    else redraw(false);
  }

  const legendCounts = new Map();
  const legendTotal = h("span.n", "0");
  const legendList = h("div.legend", STATES.map(([key, label]) => {
    const n = h("span.n", "0");
    legendCounts.set(key, n);
    const b = h("button", { type: "button", class: "st-" + key, title: "Show or hide on the map", on: { click: () => {
      if (state.hidden.has(key)) state.hidden.delete(key); else state.hidden.add(key);
      b.classList.toggle("off", state.hidden.has(key));
      drawMarkers();
    } } }, h("i.dot"), label, n);
    return b;
  }));
  // Collapsed when the viewer closed it, and by default on phones where it would cover the map.
  const legendSaved = localGet("legend");
  const legendCollapsed = legendSaved === "0" || (legendSaved === null && matchMedia("(max-width: 760px)").matches);
  const legend = h("div.map-ctl.map-legend", { class: legendCollapsed ? "collapsed" : "" },
    h("button.legend-head", { type: "button", on: { click: () => { legend.classList.toggle("collapsed"); localSet("legend", legend.classList.contains("collapsed") ? "0" : "1"); } } },
      h("span", "On this map"), legendTotal, icon("chevron", 14)),
    legendList);

  const zoomBtn = (ic, title, fn) => h("button.icon-btn", { type: "button", title, on: { click: fn } }, icon(ic, 16));
  const zoom = h("div.map-ctl.map-zoom",
    zoomBtn("plus", "Zoom in", () => map.zoomIn()),
    zoomBtn("minus", "Zoom out", () => map.zoomOut()),
    h("span.sep"),
    zoomBtn("expand", "Fit the continent", () => bounds && map.fitBounds(bounds, { padding: [30, 30] })));

  const rumourKey = h("div.map-ctl.rumour-key", { hidden: true });
  stage.append(h("div.vignette"), seg, layersWrap, legend, zoom, rumourKey);

  // ---- Wiring ----
  map.on("zoomend", updateLabels);
  map.on("moveend", updateZoneArt);
  let resizeQueued = false;
  new ResizeObserver(() => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; map.invalidateSize({ pan: false }); });
  }).observe(el);

  on("continent", opts => { redraw(opts?.fit !== false); const fitStory = rumourFitPending; rumourFitPending = false; drawRumours(fitStory); });
  on("panel rumours", () => drawRumours(false));
  on("rumour-focus rumour-replay", () => drawRumours(true));
  on("theme", () => { redraw(false); drawRumours(false); });
  on("snapshot", drawMarkers);
  on("selection", () => { drawMarkers(); drawHoldings(); });
  on("companies", drawHoldings);
  on("focus", p => map.setView(toLatLng(p.x, p.y), Math.max(map.getZoom(), -1)));
  on("focus-zone", zoneId => {
    const z = state.worldmap?.zones.find(z => z.zone === zoneId && isContinent(z.map));
    if (!z) return;
    if (String(z.map) !== state.continent) setContinent(String(z.map), false);
    map.fitBounds(areaBounds(z), { padding: [40, 40], maxZoom: 0 });
  });
  on("mapcounts", ({ total, counts, perMap }) => {
    legendTotal.textContent = total.toLocaleString();
    for (const [key, n] of legendCounts) n.textContent = counts[key].toLocaleString();
    for (const b of segButtons) b.querySelector(".n").textContent = perMap[b.dataset.id] ? perMap[b.dataset.id].toLocaleString() : "";
  });
}
