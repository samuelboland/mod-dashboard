// What the Settings panel knows about the keys it may be given (Dashboard.Settings.Keys). Pure, so it
// can be tested without a page. A key not listed here still shows, under its own name, as text.

// kind: "bool" (a 0/1 switch), "int" (a whole number, with optional min/max), or "text".
export const KNOWN = {
  "OllamaChat.Enable": { label: "Bots speak", kind: "bool", group: "Chat",
    help: "The whole chat module. Off silences every bot." },
  "OllamaChat.Conversation.Enable": { label: "Conversation mode", kind: "bool", group: "Conversation",
    help: "A bot you speak to stops, turns to you and keeps answering you until you fall silent or walk away." },
  "OllamaChat.Conversation.HoldSeconds": { label: "Waits for you (seconds)", kind: "int", min: 10, max: 3600, group: "Conversation",
    help: "How long after your last line the bot goes back to what it was doing." },
  "OllamaChat.Conversation.MaxDistance": { label: "Talking distance (yards)", kind: "int", min: 5, max: 100, group: "Conversation",
    help: "Walk further away than this and the conversation ends." },
  "OllamaChat.Conversation.HoldStill": { label: "Stands still while talking", kind: "bool", group: "Conversation",
    help: "Off: it still answers you first, but keeps walking about." },
  "OllamaChat.Delivery.Split": { label: "Long replies as several lines", kind: "bool", group: "Replies",
    help: "A reply longer than one chat message goes out as several, paced like speech." },
  "OllamaChat.Delivery.MaxMessages": { label: "Most lines per reply", kind: "int", min: 0, max: 10, group: "Replies",
    help: "0 = no limit." },
  "OllamaChat.MaxReplyLength": { label: "Longest reply (characters)", kind: "int", min: 40, max: 2000, group: "Replies" },
  "OllamaChat.Reply.Model": { label: "Model for replies to players", kind: "text", group: "Replies",
    help: "The model (or router route) that answers a real player. Empty = the same model as everything else." },
  "OllamaChat.Reply.NumPredict": { label: "Reply length budget (tokens)", kind: "int", min: 0, max: 4000, group: "Replies",
    help: "0 = the general token cap." },
  "OllamaChat.PlayerReplyChance.Say": { label: "Chance a bot answers a say (%)", kind: "int", min: 0, max: 100, group: "Chat" },
  "OllamaChat.BlacklistMastersOnly": { label: "Command words only for your own bots", kind: "bool", group: "Chat",
    help: "On: a line starting “who”, “wait” or “do” is still answered by bots you do not command." },
};

export function describe(key) {
  const known = KNOWN[key];
  return { key, label: known?.label ?? key, help: known?.help ?? "", group: known?.group ?? "Other",
           kind: known?.kind ?? "text", min: known?.min, max: known?.max };
}

// The value to send for what was typed or toggled, or an error message.
export function validate(key, raw) {
  const d = describe(key);
  const text = String(raw ?? "").trim();
  if (d.kind === "bool") {
    if (["1", "true", "on"].includes(text.toLowerCase())) return { value: "1" };
    if (["0", "false", "off", ""].includes(text.toLowerCase())) return { value: "0" };
    return { error: "on or off" };
  }
  if (d.kind === "int") {
    if (!/^-?\d+$/.test(text)) return { error: "a whole number" };
    const n = Number(text);
    if (d.min != null && n < d.min) return { error: `at least ${d.min}` };
    if (d.max != null && n > d.max) return { error: `at most ${d.max}` };
    return { value: String(n) };
  }
  if (/["\r\n]/.test(text)) return { error: "one line, without double quotes" };
  return { value: text };
}

// Settings in panel order: known groups first, in the order above, then everything else by key.
export function grouped(settings) {
  const order = [...new Set(Object.values(KNOWN).map(k => k.group)), "Other"];
  const byGroup = new Map(order.map(g => [g, []]));
  for (const s of settings || []) byGroup.get(describe(s.key).group).push(s);
  const knownKeys = Object.keys(KNOWN);
  const rank = key => { const i = knownKeys.indexOf(key); return i < 0 ? knownKeys.length : i; };
  return order.map(g => ({ group: g, items: byGroup.get(g).sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key)) }))
              .filter(g => g.items.length);
}
