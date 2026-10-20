// Where the lore gate answers (services/lore/lore_gate.py). It has its own port because this server caps bodies
// at 1024 bytes and never answers a preflight. A realm that reaches the dashboard through a proxy, where the
// gate has an address of its own, replaces this one file in its copy of the page.
export const GATE = `${location.protocol}//${location.hostname}:8788`;

// The gate's token is its own secret, not the dashboard's command token, and every panel that talks to the
// gate shares it.
export const readToken = () => { try { return localStorage.getItem("dash.loreToken") || ""; } catch { return ""; } };
export const saveToken = v => { try { localStorage.setItem("dash.loreToken", v); } catch {} };
