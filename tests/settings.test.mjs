// node --test tests/settings.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { describe, validate, grouped } from "../web/js/lib/settings.js";

test("a known key has its label and kind; an unknown one shows as text under its own name", () => {
  assert.equal(describe("OllamaChat.Conversation.Enable").kind, "bool");
  const unknown = describe("Some.Other.Key");
  assert.deepEqual([unknown.label, unknown.kind, unknown.group], ["Some.Other.Key", "text", "Other"]);
});

test("switches send 1 or 0", () => {
  assert.deepEqual(validate("OllamaChat.Delivery.Split", true), { value: "1" });
  assert.deepEqual(validate("OllamaChat.Delivery.Split", "off"), { value: "0" });
  assert.ok(validate("OllamaChat.Delivery.Split", "maybe").error);
});

test("persistent progression and automatic resets are separate playerbot switches", () => {
  for (const key of ["AiPlayerbot.PersistentProgression", "AiPlayerbot.LevelBrackets.Enabled", "AiPlayerbot.ResetBotLevel.Enabled"]) {
    assert.equal(describe(key).kind, "bool");
    assert.equal(describe(key).group, "Playerbots");
    assert.deepEqual(validate(key, "on"), { value: "1" });
  }
  assert.match(describe("AiPlayerbot.LevelBrackets.Enabled").help, /Ignored while persistent progression/);
});

test("numbers must be whole and in range", () => {
  assert.deepEqual(validate("OllamaChat.Conversation.HoldSeconds", " 90 "), { value: "90" });
  assert.match(validate("OllamaChat.Conversation.HoldSeconds", "5").error, /at least 10/);
  assert.match(validate("OllamaChat.Conversation.HoldSeconds", "1.5").error, /whole/);
  assert.match(validate("OllamaChat.PlayerReplyChance.Say", "101").error, /at most 100/);
});

test("text is one line with no double quote, which the server's config parser would strip", () => {
  assert.deepEqual(validate("OllamaChat.Reply.Model", "quality"), { value: "quality" });
  assert.ok(validate("OllamaChat.Reply.Model", 'say "hi"').error);
  assert.ok(validate("OllamaChat.Reply.Model", "a\nb").error);
  assert.ok(validate("OllamaChat.Reply.Model", "a\0b").error);
  assert.ok(validate("OllamaChat.Reply.Model", "x".repeat(2001)).error);
});

test("settings are grouped, known ones in their listed order, unknown last", () => {
  const groups = grouped([
    { key: "Zeta.Key", value: "x" },
    { key: "OllamaChat.Conversation.HoldSeconds", value: "120" },
    { key: "OllamaChat.Conversation.Enable", value: "1" },
    { key: "OllamaChat.Delivery.Split", value: "1" },
  ]);
  assert.deepEqual(groups.map(g => g.group), ["Conversation", "Replies", "Other"]);
  assert.deepEqual(groups[0].items.map(s => s.key),
    ["OllamaChat.Conversation.Enable", "OllamaChat.Conversation.HoldSeconds"]);
});
