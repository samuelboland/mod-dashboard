import { z } from "zod";

const count = z.number().int().nonnegative();
const player = z.looseObject({
  guid: count, name: z.string(), bot: z.boolean(), level: count, class: count,
  race: count, team: count, map: count, zone: count, zone_name: z.string(),
  map_name: z.string(), x: z.number(), y: z.number(), z: z.number(),
  instance: z.boolean(), combat: z.boolean(), dead: z.boolean(),
  mounted: z.boolean(), flight: z.boolean(), group_leader: count,
  active: z.boolean().optional(), paused: z.boolean().optional(), rpg: z.number().int().optional(),
  master: count.optional(), paused_since: count.optional(),
  strategies: z.array(z.string()).optional(), combat_strategies: z.array(z.string()).optional(),
  saved_strategies: z.array(z.string()).optional(),
});
export const bots = z.looseObject({
  ts: count, players: z.array(player),
  counts: z.looseObject({ bots: count, real: count, active: count, paused: count }),
  update_ms: z.looseObject({ avg: z.number(), max: z.number(), last: z.number() }),
});
const bounds = z.looseObject({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() });
export const worldmap = z.looseObject({
  zones: z.array(bounds.extend({ zone: count, map: count, virtual_map: z.number(), name: z.string() })),
  continents: z.record(z.string(), z.string()),
});
export const commands = z.looseObject({
  enabled: z.boolean(),
  recent: z.array(z.looseObject({ guid: count, ts: count, cmd: z.string(), ok: z.boolean(), message: z.string() })),
});
export const health = z.object({ ok: z.boolean() });
export const settings = z.looseObject({
  enabled: z.boolean(), writable: z.boolean(), file: z.string(), reload: z.string(),
  settings: z.array(z.looseObject({ key: z.string(), value: z.string() })),
});
export const commandBody = z.strictObject({ guid: count.max(4294967295) });
// The worldserver checks the key against its own list; this only bounds the size of what is forwarded.
export const settingBody = z.strictObject({
  key: z.string().min(1).max(200),
  value: z.union([z.string().max(2000), z.number(), z.boolean()]),
});
export const commandResult = z.looseObject({ ok: z.boolean(), message: z.string() });
export const liveSchemas = { "/bots": bots, "/worldmap": worldmap, "/commands": commands, "/health": health,
  "/settings": settings };
export type LivePath = keyof typeof liveSchemas;
export type Command = "pause" | "resume";
