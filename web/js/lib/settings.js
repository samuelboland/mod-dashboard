// What the Settings panel knows about the keys it may be given (Dashboard.Settings.Keys). Pure, so it
// can be tested without a page. A key not listed here still shows, under its own name, as text.

// kind: "bool" (a 0/1 switch), "int", "number" (finite decimals), or "text".
export const KNOWN = {
  "AiPlayerbot.PersistentProgression": { label: "Persistent progression mode", kind: "int", min: 0, max: 2, group: "Playerbots",
    help: "0: off. 1: protect all random bots after provisioning. 2: protect anchored bots only; unmet bots keep configured maintenance. Enable anchor on meeting below to record human encounters automatically. Bots can still log out or teleport." },
  "AiPlayerbot.PersistentProgression.AnchorOnMeeting": { label: "Anchor bots when players meet them", kind: "bool", group: "Playerbots",
    help: "Requires persistence mode 1 or 2. A human whisper, selected-bot say, shared party (including LFG), completed trade or targeted friendly emote anchors that bot to the first human. Existing anchors are kept; new interactions only. Use mode 2 to protect met bots only." },
  "AiPlayerbot.PersistentProgression.FollowGap": { label: "Anchor level catch-up gap", kind: "int", min: 0, max: 80, group: "Playerbots",
    help: "Mode 2 only. 0: earned leveling only. Otherwise, raise an anchored bot that falls this many levels behind its anchor to 1–3 levels below them, when out of view and not grouped with a human." },
  "AiPlayerbot.PersistentProgression.AnchorInterval": { label: "Anchor reload interval (seconds)", kind: "int", min: 30, group: "Playerbots",
    help: "Mode 2 only. How often external anchor changes and optional level catch-up are checked. New encounters protect a bot immediately." },
  "AiPlayerbot.LevelBrackets.Enabled": { label: "Rebalance bot levels", kind: "bool", group: "Playerbots",
    help: "Rebuild selected bots at different levels to meet the configured population distribution. Ignored for protected bots; can still affect unmet bots when protection is limited to met bots." },
  "AiPlayerbot.ResetBotLevel.Enabled": { label: "Reset bot levels", kind: "bool", group: "Playerbots",
    help: "Reset or skip levels using the configured thresholds and chances. Ignored for protected bots; can still affect unmet bots when protection is limited to met bots." },
  "OllamaChat.Enable": { label: "Bots speak", kind: "bool", group: "Chat",
    help: "The whole chat module. Off silences every bot." },
  "OllamaChat.Conversation.Enable": { label: "Conversation mode", kind: "bool", group: "Conversation",
    help: "Healthy, ungrouped bots can pause and keep their attention on you. Damage or danger releases the pause. Grouped or mastered companions can still answer while continuing their tasks." },
  "OllamaChat.Conversation.HoldSeconds": { label: "Waits for you (seconds)", kind: "int", min: 10, max: 3600, group: "Conversation",
    help: "How long after your last line the bot goes back to what it was doing." },
  "OllamaChat.Conversation.MaxDistance": { label: "Talking distance (yards)", kind: "number", min: 5, max: 100, group: "Conversation",
    help: "Walk further away than this and the conversation ends." },
  "OllamaChat.Conversation.HoldStill": { label: "Stands still while talking", kind: "bool", group: "Conversation",
    help: "Off: it still answers you first, but keeps walking about." },
  "OllamaChat.Delivery.Split": { label: "Long replies as several lines", kind: "bool", group: "Replies",
    help: "A reply longer than one chat message goes out as several, paced like speech." },
  "OllamaChat.Delivery.MaxMessages": { label: "Most lines per reply", kind: "int", min: 0, max: 10, group: "Replies",
    help: "0 = no limit." },
  "OllamaChat.MaxReplyLength": { label: "Longest reply (characters)", kind: "int", min: 40, max: 2000, group: "Replies" },
  "OllamaChat.Reply.Model": { label: "Model for replies to players", kind: "text", group: "Replies",
    help: "The model (or router route) that answers a real player. In Headless DM it names a route: ambient, quality, chronicle, prose, utility or moment (see Models); anything else is answered by ambient. Empty = the same model as everything else." },
  "OllamaChat.Reply.NumPredict": { label: "Reply length budget (tokens)", kind: "int", min: 0, max: 4000, group: "Replies",
    help: "0 = the general token cap." },
  "OllamaChat.PlayerReplyChance.Say": { label: "Chance a bot answers a say (%)", kind: "int", min: 0, max: 100, group: "Chat" },
  "OllamaChat.BlacklistMastersOnly": { label: "Command words only for your own bots", kind: "bool", group: "Chat",
    help: "On: a line starting “who”, “wait” or “do” is still answered by bots you do not command." },
};

export function describe(key, policy = {}) {
  const known = KNOWN[key];
  return { key, label: known?.label ?? key, help: known?.help ?? "", group: known?.group ?? "Other",
           kind: policy.kind ?? known?.kind ?? "text",
           min: policy.kind ? policy.min : known?.min, max: policy.kind ? policy.max : known?.max };
}

// The value to send for what was typed or toggled, or an error message.
export function validate(key, raw, policy = {}) {
  const d = describe(key, policy);
  const text = String(raw ?? "").trim();
  if (d.kind === "bool") {
    if (["1", "true", "on"].includes(text.toLowerCase())) return { value: "1" };
    if (["0", "false", "off", ""].includes(text.toLowerCase())) return { value: "0" };
    return { error: "on or off" };
  }
  if (d.kind === "int" || d.kind === "number") {
    if (d.kind === "int" && !/^-?\d+$/.test(text)) return { error: "a whole number" };
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return { error: "a finite number" };
    const n = Number(text);
    if (!Number.isFinite(n)) return { error: "a finite number" };
    if (d.kind === "int" && !Number.isSafeInteger(n)) return { error: "a safe whole number" };
    if (d.min != null && n < d.min) return { error: `at least ${d.min}` };
    if (d.max != null && n > d.max) return { error: `at most ${d.max}` };
    return { value: String(n) };
  }
  if (new TextEncoder().encode(text).length > 2000 || /["\x00-\x1f\x7f]/.test(text)) return { error: "at most 2000 bytes, without quotes or control characters" };
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
