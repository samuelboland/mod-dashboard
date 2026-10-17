// node --test tests/models.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { checkModel, sameChain, moveBackend, removeBackend, addBackend, addable, chainProblem, keyLabel, usedBy,
         routerWords, APPLIES, ROUTE_HELP } from "../web/js/lib/models.js";

const backends = [
  { name: "local", usable: true, key: "not needed" },
  { name: "spare", usable: true, key: "not needed" },
  { name: "remote", usable: false, key: "missing" },
];

test("a model name is a slug or a file name, trimmed", () => {
  for (const ok of ["qwen3-14b", "anthropic/claude-haiku-4.5", "qwen/qwen3-next-80b:free", "llama-3.1-8b@q4_k_m", " spaced-edges "]) {
    assert.deepEqual(checkModel(ok), { value: ok.trim() });
  }
  assert.ok(checkModel("x".repeat(200)).value);
});

test("a model name with a space, a quote, a control character or no letters is refused", () => {
  for (const bad of ["", "   ", "two words", 'quo"te', "new\nline", "tab\tbed", "../up", "-leading", "modèle", "x".repeat(201), null, undefined]) {
    assert.ok(checkModel(bad).error, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("moving a backend swaps it with its neighbour and stops at the ends", () => {
  const chain = ["local", "spare", "remote"];
  assert.deepEqual(moveBackend(chain, 1, -1), ["spare", "local", "remote"]);
  assert.deepEqual(moveBackend(chain, 1, 1), ["local", "remote", "spare"]);
  assert.equal(moveBackend(chain, 0, -1), chain);
  assert.equal(moveBackend(chain, 2, 1), chain);
  assert.deepEqual(chain, ["local", "spare", "remote"], "the original list is not edited");
});

test("a backend can be taken out, and added once", () => {
  assert.deepEqual(removeBackend(["a", "b", "c"], 1), ["a", "c"]);
  assert.deepEqual(addBackend(["a"], "b"), ["a", "b"]);
  assert.deepEqual(addBackend(["a", "b"], "b"), ["a", "b"]);
  assert.deepEqual(addable(backends, ["local"]), ["spare", "remote"]);
  assert.ok(sameChain(["a", "b"], ["a", "b"]));
  assert.ok(!sameChain(["a", "b"], ["b", "a"]));
  assert.ok(!sameChain(["a"], ["a", "b"]));
});

test("a route needs a backend that can answer", () => {
  assert.match(chainProblem([], backends), /at least one/);
  assert.match(chainProblem(["remote"], backends), /API key/);
  assert.equal(chainProblem(["remote", "local"], backends), null);
  assert.match(chainProblem(["local", "spare", "remote"], backends, 2), /At most 2/);
});

test("keys are described, never shown", () => {
  assert.equal(keyLabel("set"), "key set");
  assert.equal(keyLabel("missing"), "no key");
  assert.equal(keyLabel("not needed"), "no key needed");
});

test("what a backend is used by reads as one line", () => {
  assert.equal(usedBy({ used_by: { routes: ["ambient", "quality"], lane: true, judge: "judge" } }),
    "routes ambient, quality · writing lanes · the judge");
  assert.equal(usedBy({ used_by: { routes: [], lane: false, judge: "fallback" } }), "judge (second choice)");
  assert.equal(usedBy({ used_by: { routes: [], lane: false, judge: null } }), "nothing yet");
});

test("every state of the router has words, and an error says why", () => {
  for (const state of ["live", "waiting", "error", "down", "old", "unknown", undefined]) {
    assert.ok(routerWords({ state }).title, `no title for ${state}`);
  }
  assert.equal(routerWords({ state: "live" }).tone, "ok");
  assert.match(routerWords({ state: "error", error: "no [routes]" }).text, /no \[routes\]/);
  assert.match(routerWords({ state: "old" }).text, /Restart it once/);
});

test("the table of what a change needs covers the router, the writing lanes, the judge and keys", () => {
  const areas = APPLIES.map(a => a.area).join(" | ");
  for (const word of ["Chat routes", "Writing", "judge", "keys", "Replies"]) assert.match(areas, new RegExp(word, "i"));
  const judge = APPLIES.find(a => /judge/i.test(a.area));
  assert.match(judge.text, /wow-regard wow-chronicler wow-dm/);
  assert.ok(ROUTE_HELP.ambient && ROUTE_HELP.moment);
});
