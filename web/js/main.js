// Entry point: mount every component, load the static world data, start polling.
import { state, emit } from "./state.js";
import { loadStatic, startPolling } from "./api.js";
import { setContinent, setPanel, clearSelection } from "./actions.js";
import { mountTopbar } from "./components/topbar.js";
import { mountRail } from "./components/rail.js";
import { mountMap } from "./components/mapview.js";
import { mountRoster } from "./components/roster.js";
import { mountFeelings } from "./components/feelings.js";
import { mountFeelingsFull } from "./components/feelings-full.js";
import { mountGroups } from "./components/groups.js";
import { mountGroupsGrid } from "./components/groups-grid.js";
import { mountCompanies } from "./components/companies.js";
import { mountChronicle } from "./components/chronicle.js";
import { mountRumours } from "./components/rumours.js";
import { mountChronicleReader } from "./components/chronicle-reader.js";
import { mountMarket } from "./components/market.js";
import { mountCommands } from "./components/commands.js";
import { mountServer } from "./components/server.js";
import { mountLore } from "./components/lore.js";
import { mountMemories } from "./components/memories.js";
import { mountMemoriesFull } from "./components/memories-full.js";
import { mountJourney } from "./components/journey.js";
import { mountJourneyFull } from "./components/journey-full.js";
import { mountInspector } from "./components/inspector.js";
import { mountSettings } from "./components/settings.js";

import { mountAccounting } from "./components/accounting.js";

const $ = id => document.getElementById(id);

document.documentElement.dataset.theme = state.theme;

mountTopbar($("topbar"));
const panels = mountRail($("rail"), $("dock"));
mountRoster(panels.roster);
mountFeelings(panels.feelings);
mountGroups(panels.groups);
mountCompanies(panels.companies);
mountChronicle(panels.chronicle);
mountRumours(panels.rumours);
mountMarket(panels.market);
mountAccounting(panels.costs, document.body);
mountCommands(panels.commands);
mountServer(panels.server);
mountLore(panels.lore);
mountMemories(panels.memories);
mountJourney(panels.journey);
mountSettings(panels.settings);
mountInspector($("inspector"));
mountChronicleReader(document.body);
mountFeelingsFull(document.body);
mountGroupsGrid(document.body);
mountMemoriesFull(document.body);
mountJourneyFull(document.body);
mountMap($("stage"));

// "/" finds a character, Esc closes the inspector.
document.addEventListener("keydown", e => {
  const typing = e.target.closest("input, textarea, [contenteditable]");
  if (e.key === "/" && !typing) {
    e.preventDefault();
    if (state.panel !== "roster" || !state.dockOpen) setPanel("roster");
    emit("focus-search");
  } else if (e.key === "Escape") {
    if (typing) e.target.blur();
    else clearSelection();
  }
});

startPolling();
await loadStatic();
setContinent(state.continent);
