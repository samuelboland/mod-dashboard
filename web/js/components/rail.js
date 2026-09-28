// Icon rail and the dock it controls. Returns one empty panel element per id for the panel components.
import { state, on } from "../state.js";
import { h, icon } from "../lib/dom.js";
import { setPanel, setDock } from "../actions.js";

export const PANELS = [
  { id: "roster", icon: "users", label: "Roster", title: "Roster", desc: "Everyone in the world right now" },
  { id: "feelings", icon: "heart", label: "Feelings", title: "Feelings", desc: "Who has warmed to or cooled on whom" },
  { id: "groups", icon: "handshake", label: "Groups", title: "Groups", desc: "Who is standing together right now, and what they are saying" },
  { id: "companies", icon: "shield", label: "Companies", title: "Companies", desc: "Seats, lands, feuds and who is joining" },
  { id: "chronicle", icon: "scroll", label: "Chronicle", title: "Chronicle", desc: "Each faction scribe's watches and the word going around" },
  { id: "rumours", icon: "message", label: "Rumours", title: "Rumours", desc: "How word travels the roads, and who has been heard passing it on" },
  { id: "market", icon: "coins", label: "Market", title: "Market", desc: "The auction houses: stalls, sales and what goods fetch" },
  { id: "costs", icon: "coins", label: "Costs", title: "Model costs", desc: "Recorded spending, usage and request purposes" },
  { id: "commands", icon: "terminal", label: "Commands", title: "Commands", desc: "Pause or resume a bot on the world server" },
  { id: "server", icon: "activity", label: "Server", title: "Server", desc: "Realm status, resource use and lifecycle controls" },
  { id: "lore", icon: "scroll", label: "Lore", title: "Your own lore", desc: "Write your characters' story, and let the world check it" },
  { id: "memories", icon: "book", label: "Memories", title: "Memories", desc: "What the bots still carry: their deeds and what they made of them" },
  { id: "journey", icon: "route", label: "Journey", title: "A player's journey", desc: "Everything one character has done, in the order it happened" },
  { id: "settings", icon: "sliders", label: "Settings", title: "Settings", desc: "Bot progression and conversation settings" },
];

export function mountRail(rail, dock) {
  const buttons = new Map(PANELS.map(p => [p.id,
    h("button.rail-btn", { type: "button", title: p.desc, on: { click: () => setPanel(p.id) } }, icon(p.icon, 20), h("span.lbl", p.label))]));
  const collapse = h("button.icon-btn.collapse", { type: "button", on: { click: () => setDock(!state.dockOpen) } }, icon("panel", 18));
  const community = h("a.icon-btn.rail-link", { href: "https://discord.com/invite/zpnYXhDs3X", target: "_blank", rel: "noopener",
    title: "Discord \u2014 ask about Headless DM" }, icon("message", 18));
  rail.replaceChildren(...buttons.values(), h("div.rail-spacer"), community, collapse);

  const title = h("h1.dock-title");
  const desc = h("div.dock-desc");
  const panels = Object.fromEntries(PANELS.map(p => [p.id, h("section.panel", { dataset: { panel: p.id }, hidden: true })]));
  dock.replaceChildren(h("div.dock-head", title, desc), h("div.dock-body", Object.values(panels)));

  const sync = () => {
    const current = PANELS.find(p => p.id === state.panel) || PANELS[0];
    title.textContent = current.title;
    desc.textContent = current.desc;
    for (const [id, b] of buttons) {
      const on = id === current.id && state.dockOpen;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    for (const [id, el] of Object.entries(panels)) el.hidden = id !== current.id;
    collapse.title = state.dockOpen ? "Hide the side panel" : "Show the side panel";
    document.getElementById("app").classList.toggle("dock-closed", !state.dockOpen);
  };
  on("panel", sync);
  sync();
  return panels;
}
