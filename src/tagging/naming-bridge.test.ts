// Unit tests for the naming bridge: offline, synthetic, mock transports under the
// REAL provider. Nothing here touches the network, the fs or a vault; every
// response is scripted.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaxonomyNode, TaxonomyResult } from "./proposal";
import type { NamingTransport } from "./naming-bridge";
// Node's type stripping needs the ".ts" specifier; tsc flags it only because tsconfig (not ours to edit)
// omits allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else. One line:
// the complaint lands on the specifier, and the directive only pins the line right below it.
// @ts-expect-error
import { applyModelNaming, boundedNamingRequest, excerptNoteText, namingCacheKey, namingTransportFrom, providerSelectionFrom } from "./naming-bridge.ts";
// @ts-expect-error
import { joinSegments } from "./proposal.ts";

const ENDPOINT = "https://llm.example.test/v1/chat/completions";
const KEY = "sk-bridge-secret-0123456789"; // >= 8 chars: the provider's scrubber covers it

// The bridge arms its timeout via window (the popout-lint house form); node has no
// window, so the whole suite runs behind this shim delegating to node's real timers
// — the same pattern src/reader/reader-candidates.test.ts establishes for its shims.
// eslint-disable-next-line obsidianmd/no-global-this -- node:test shims the browser globals here; production never runs in this process
const g = globalThis as unknown as { window: unknown };
g.window = { setTimeout, clearTimeout }; // real node timers: the timeout test must race a real macrotask

function node(level: number, segments: string[], notePaths: string[]): TaxonomyNode {
  return { level, segments, notePaths };
}

// A legal taxonomy: every node's notes are its own, leafAssignment covers them all.
function taxonomy(nodes: TaxonomyNode[]): TaxonomyResult {
  const leafAssignment = new Map<string, string>();
  for (const n of nodes) {
    for (const path of n.notePaths) leafAssignment.set(path, joinSegments(n.segments));
  }
  return { nodes, leafAssignment };
}

const TWO_LEVEL = () =>
  taxonomy([
    node(1, ["MachineLearning"], ["notes/ml1.md", "notes/ml2.md"]),
    node(2, ["MachineLearning", "NeuralNetworks"], ["notes/nn1.md", "notes/nn2.md"]),
    node(2, ["MachineLearning", "DecisionTrees"], ["notes/dt1.md"]),
  ]);

const CONTEXT = ["notes/ml1.md", "notes/ml2.md", "notes/nn1.md", "notes/nn2.md", "notes/dt1.md"].map(
  (path, i) => ({ path, title: `Note ${i}`, text: `body ${i} `.repeat(200) }),
);

const chat = (map: unknown) => ({ choices: [{ message: { content: JSON.stringify(map) } }] });
const RENAMED = { n0: "AI", n1: "DeepLearning", n2: "Trees" };

// Scripted transport: records every call, answers with a raw {status, text}.
function mockTransport(answer: () => { status: number; text: string }) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const transport: NamingTransport = async (url, body, headers) => {
    calls.push({ url, body, headers });
    return answer();
  };
  return { calls, transport };
}

const copy = (t: TaxonomyResult) => structuredClone({ nodes: t.nodes, leaf: [...t.leafAssignment] });

// --- providerSelectionFrom -----------------------------------------------------

void test("selection: local mode and unconfigured endpoints select nothing; configured selects the provider", () => {
  assert.equal(providerSelectionFrom("local", ENDPOINT, "gpt-4o-mini", KEY), null, "local mode asks nothing");
  assert.equal(providerSelectionFrom("openai-compatible", "", "gpt-4o-mini", KEY), null, "blank endpoint");
  assert.equal(providerSelectionFrom("openai-compatible", "  ", "gpt-4o-mini", KEY), null, "whitespace endpoint");
  assert.equal(providerSelectionFrom("openai-compatible", ENDPOINT, "", KEY), null, "blank model");
  assert.equal(providerSelectionFrom("openai-compatible", ENDPOINT, "  ", KEY), null, "whitespace model");
  assert.deepEqual(
    providerSelectionFrom("openai-compatible", ENDPOINT, "gpt-4o-mini", KEY),
    { endpoint: ENDPOINT, model: "gpt-4o-mini", apiKey: KEY },
  );
  assert.deepEqual(
    providerSelectionFrom("openai-compatible", ENDPOINT, "gpt-4o-mini", ""),
    { endpoint: ENDPOINT, model: "gpt-4o-mini" },
    "a blank key sends no Authorization: the option is simply absent",
  );
});

// --- excerptNoteText ------------------------------------------------------------

void test("excerpt: capped per note at the requested cap and at the 1200 default", () => {
  assert.equal(excerptNoteText("short body", 1200), "short body", "under the cap: unchanged");
  assert.equal(excerptNoteText("x".repeat(5000), 300), "x".repeat(300), "over the cap: sliced");
  assert.equal(excerptNoteText("y".repeat(5000)).length, 1200, "the default cap is 1200");
});

// --- namingCacheKey --------------------------------------------------------------

void test("cache key: changes with mode, endpoint or model; a key-value rotation leaves it alone", () => {
  const base = namingCacheKey("openai-compatible", ENDPOINT, "gpt-4o-mini", true);
  assert.notEqual(namingCacheKey("local", ENDPOINT, "gpt-4o-mini", true), base, "mode change invalidates");
  assert.notEqual(namingCacheKey("openai-compatible", "https://other.test/c", "gpt-4o-mini", true), base, "endpoint change invalidates");
  assert.notEqual(namingCacheKey("openai-compatible", ENDPOINT, "gpt-4.1-mini", true), base, "model change invalidates");
  assert.notEqual(namingCacheKey("openai-compatible", ENDPOINT, "gpt-4o-mini", false), base, "key removed: naming changes");
  // The point of apiKeySet: a key-value rotation arrives as the same boolean, so the
  // caller's key string is what stays stable across it. And no key value can leak in.
  assert.equal(namingCacheKey("openai-compatible", ENDPOINT, "gpt-4o-mini", true), base, "same shape: same key");
  assert.ok(!base.includes(KEY), "the key value never enters the cache key");
});

// --- boundedNamingRequest ---------------------------------------------------------

void test("bounded request: passes url, body and headers through untouched and hands back the parsed object", async () => {
  const answer = chat(RENAMED);
  const { calls, transport } = mockTransport(() => ({ status: 200, text: JSON.stringify(answer) }));
  const body = { model: "gpt-4o-mini", messages: [{ role: "system", content: "..." }] };
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };
  const parsed = await boundedNamingRequest(transport, 5000)(ENDPOINT, body, headers);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.deepEqual(calls[0].body, body, "the provider's body reaches the transport untouched");
  assert.deepEqual(calls[0].headers, headers, "the provider's headers reach the transport untouched");
  assert.deepEqual(parsed, answer, "valid JSON returns the parsed {choices: ...} the provider's parser reads");
});

void test("bounded request: non-2xx names only the status; the body fragment and key stay out", async () => {
  const leaky = `Internal Server Error: ${KEY} while processing ${CONTEXT[0].text.slice(0, 40)}`;
  const { transport } = mockTransport(() => ({ status: 503, text: leaky }));
  await assert.rejects(
    () => boundedNamingRequest(transport, 5000)(ENDPOINT, {}, {}),
    (err: Error) => {
      assert.equal(err.message, "the naming endpoint returned status 503");
      assert.ok(!err.message.includes(KEY), "the key never enters the message");
      assert.ok(!err.message.includes("processing"), "no word of the response body enters the message");
      return true;
    },
  );
});

void test("bounded request: an unsettled transport loses to the timeout, with the fixed line", async () => {
  const never: NamingTransport = () => new Promise(() => {});
  await assert.rejects(
    () => boundedNamingRequest(never, 10)(ENDPOINT, {}, {}),
    /the naming request timed out/,
  );
});

void test("bounded request: an unparseable 2xx body rejects with the fixed line, not the body", async () => {
  const { transport } = mockTransport(() => ({ status: 200, text: "<html>nginx down page</html>" }));
  await assert.rejects(
    () => boundedNamingRequest(transport, 5000)(ENDPOINT, {}, {}),
    (err: Error) => {
      assert.equal(err.message, "the naming response was not JSON");
      assert.ok(!err.message.includes("nginx"), "no fragment of the body enters the message");
      return true;
    },
  );
});

// --- namingTransportFrom -----------------------------------------------------------

void test("transport factory: namingTransportFrom POSTs JSON with throw:false and returns only status and text", async () => {
  let seen: { url: string; method: string; headers: Record<string, string>; body: string; throw: boolean } | undefined;
  const requestUrl = async (req: {
    url: string; method: string; headers: Record<string, string>; body: string; throw: boolean;
  }) => {
    seen = req;
    return { status: 201, text: '{"ok":true}' };
  };
  const result = await namingTransportFrom(requestUrl)(ENDPOINT, { model: "m" }, { Authorization: `Bearer ${KEY}` });
  assert.ok(seen !== undefined);
  assert.equal(seen.url, ENDPOINT);
  assert.equal(seen.method, "POST");
  assert.equal(seen.throw, false, "a non-2xx must come back as a status, not reject inside requestUrl");
  assert.deepEqual(JSON.parse(seen.body), { model: "m" }, "the body crosses as JSON text");
  assert.deepEqual(seen.headers, { Authorization: `Bearer ${KEY}` });
  assert.deepEqual(result, { status: 201, text: '{"ok":true}' }, "only status and text cross the bridge");
});

// --- applyModelNaming, end-to-end through the REAL provider --------------------------

void test("end-to-end: a valid renames response renames a synthetic taxonomy through the real provider", async () => {
  const input = TWO_LEVEL();
  const { calls, transport } = mockTransport(() => ({ status: 200, text: JSON.stringify(chat(RENAMED)) }));
  const selection = providerSelectionFrom("openai-compatible", ENDPOINT, "gpt-4o-mini", KEY);
  const outcome = await applyModelNaming(input, CONTEXT, selection, boundedNamingRequest(transport, 5000));
  assert.equal(outcome.named, true);
  assert.equal(outcome.failure, undefined);
  assert.deepEqual(
    outcome.taxonomy.nodes.map((n) => n.segments),
    [["AI"], ["AI", "DeepLearning"], ["AI", "Trees"]],
  );
  assert.equal(outcome.taxonomy.leafAssignment.get("notes/dt1.md"), "AI/Trees", "assignments follow the renames");
  assert.equal(calls.length, 1, "exactly one wire call");
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`, "the provider's own bearer header crossed untouched");
});

void test("end-to-end failure: timeout, non-2xx and unparseable responses keep the local taxonomy with the fixed line", async (t) => {
  const warn = t.mock.method(console, "warn", () => {}); // the fixed notice is main.ts's job; the bridge logs the scrubbed Error
  const failures: [string, NamingTransport][] = [
    ["timeout", () => new Promise(() => {})], // never settles
    ["non-2xx", mockTransport(() => ({ status: 500, text: `INTERNAL ${KEY} ${CONTEXT[0].text.slice(0, 40)}` })).transport],
    ["unparseable", mockTransport(() => ({ status: 200, text: "I would rename them all" })).transport],
  ];
  for (const [name, transport] of failures) {
    const input = TWO_LEVEL();
    const before = copy(input);
    const selection = providerSelectionFrom("openai-compatible", ENDPOINT, "gpt-4o-mini", KEY);
    const outcome = await applyModelNaming(input, CONTEXT, selection, boundedNamingRequest(transport, 10));
    assert.equal(outcome.named, false, `${name}: not named`);
    assert.equal(outcome.failure, "Concept naming unavailable — local taxonomy kept.", `${name}: the fixed line only`);
    assert.deepEqual(copy(outcome.taxonomy), before, `${name}: the local taxonomy kept, unmutated`);
  }
  assert.equal(warn.mock.callCount(), failures.length, "one warn per failed naming attempt");
  const logged = warn.mock.calls[0].arguments;
  assert.equal(logged[0], "[related-notes] model naming failed");
  assert.ok(logged[1] instanceof Error, "the console carries the Error"); // narrows the element access for the lines below
  const message = logged[1].message;
  assert.match(message, /^model naming failed: /, "the provider's own scrubbed wrapper");
  assert.ok(!message.includes(KEY) && !message.includes(CONTEXT[0].text.trim()), "logged already scrubbed");
});

void test("null selection: no transport call, no change, no failure", async () => {
  const input = TWO_LEVEL();
  const { calls, transport } = mockTransport(() => ({ status: 200, text: "never read" }));
  const outcome = await applyModelNaming(input, CONTEXT, null, boundedNamingRequest(transport, 5000));
  assert.equal(calls.length, 0, "local mode asks nothing");
  assert.equal(outcome.named, false);
  assert.equal(outcome.failure, undefined, "silence, not a failure");
  assert.equal(outcome.taxonomy, input, "the very same local taxonomy flows downstream");
});
