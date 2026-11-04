// Unit tests for the tag namer: offline, synthetic, an injected fake transport.
// Nothing here touches the network, the fs or a vault; every response is scripted.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaxonomyNode, TaxonomyResult } from "./proposal";
import type { TagNamingOptions, TagNamingRequest } from "./tag-namer";
// Node's type stripping needs the ".ts" specifier; tsc flags it only because tsconfig (not ours to edit)
// omits allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else.
// @ts-expect-error
import { joinSegments } from "./proposal.ts";
// @ts-expect-error
import { EXCERPT_CHARS, MAX_NODES, SAMPLES_PER_NODE, nameTaxonomyWithModel } from "./tag-namer.ts";

const OPTIONS: TagNamingOptions = {
  endpoint: "https://llm.example.test/v1/chat/completions",
  model: "gpt-4o-mini",
  apiKey: "sk-secret-abcdef0123456789",
};

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

// Scripted transport: records every call, answers with content or throws.
function transport(answer: () => unknown, fails?: (url: string, body: unknown) => Error) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const request: TagNamingRequest = async (url, body, headers) => {
    calls.push({ url, body: body as Record<string, unknown>, headers });
    if (fails) throw fails(url, body);
    return answer();
  };
  return { calls, request };
}

const chat = (map: unknown) => ({ choices: [{ message: { content: JSON.stringify(map) } }] });

// One node as the namer sends it, inside the user message's JSON payload.
type SentNode = { id: string; currentPath: string; samples: { title: string; excerpt: string }[] };

// The user message's payload: one {id, currentPath, samples} per sent node.
function payload(body: Record<string, unknown>): SentNode[] {
  const messages = body.messages as { role: string; content: string }[];
  return JSON.parse(messages[1].content) as SentNode[]; // the assertion is the boundary: no `any` leaves this helper
}

const copy = (t: TaxonomyResult) => structuredClone({ nodes: t.nodes, leaf: [...t.leafAssignment] });

const RENAMED = { n0: "AI", n1: "DeepLearning", n2: "Trees" };

// Registrations are fire-and-forget by design: `void` marks the returned promise handled
// and keeps every test concurrent, which is how node:test schedules a file's tests.
void test("(a) two-level rename: same order, levels and notePaths; renamed segments; leafAssignment follows", async () => {
  const input = TWO_LEVEL();
  const { calls, request } = transport(() => chat(RENAMED));
  const out = await nameTaxonomyWithModel(input, CONTEXT, OPTIONS, request);
  assert.equal(calls.length, 1, "exactly one transport call");
  assert.equal(calls[0].url, OPTIONS.endpoint, "the endpoint is passed verbatim");
  assert.deepEqual(out.nodes.map((n) => n.level), [1, 2, 2], "levels unchanged");
  assert.deepEqual(
    out.nodes.map((n) => n.notePaths),
    [["notes/ml1.md", "notes/ml2.md"], ["notes/nn1.md", "notes/nn2.md"], ["notes/dt1.md"]],
    "membership unchanged",
  );
  assert.deepEqual(out.nodes.map((n) => n.segments), [["AI"], ["AI", "DeepLearning"], ["AI", "Trees"]]);
  assert.deepEqual(
    [...out.leafAssignment],
    [
      ["notes/ml1.md", "AI"],
      ["notes/ml2.md", "AI"],
      ["notes/nn1.md", "AI/DeepLearning"],
      ["notes/nn2.md", "AI/DeepLearning"],
      ["notes/dt1.md", "AI/Trees"],
    ],
  );
  assert.deepEqual(copy(input), copy(TWO_LEVEL()), "the input taxonomy is never mutated");
});

void test("(b) three-level remap: children compose the renamed parents", async () => {
  const deep = taxonomy([
    node(1, ["Science"], ["notes/sci.md"]),
    node(2, ["Science", "Biology"], ["notes/bio.md"]),
    node(3, ["Science", "Biology", "Genetics"], ["notes/gen.md"]),
    node(3, ["Science", "Biology", "Ecology"], ["notes/eco.md"]),
  ]);
  const context = ["notes/sci.md", "notes/bio.md", "notes/gen.md", "notes/eco.md"].map((path) => ({ path, title: path, text: "text" }));
  const { request } = transport(() => chat({ n0: "Knowledge", n1: "LifeScience", n2: "DNA", n3: "Nature" }));
  const out = await nameTaxonomyWithModel(deep, context, OPTIONS, request);
  assert.deepEqual(out.nodes.map((n) => n.segments), [
    ["Knowledge"],
    ["Knowledge", "LifeScience"],
    ["Knowledge", "LifeScience", "DNA"],
    ["Knowledge", "LifeScience", "Nature"],
  ]);
  assert.deepEqual(out.nodes.map((n) => n.level), [1, 2, 3, 3], "depth unchanged");
  assert.equal(out.leafAssignment.get("notes/gen.md"), "Knowledge/LifeScience/DNA");
});

void test("(c) every invalid or malicious response throws and leaves the input untouched", async () => {
  const bad: [string, () => unknown][] = [
    ["unknown node key", () => chat({ ...RENAMED, n9: "Intruder" })],
    ["missing node key", () => chat({ n0: "AI", n1: "DeepLearning" })],
    ["non-string value", () => chat({ n0: "AI", n1: 42, n2: "Trees" })],
    ["multi-segment value", () => chat({ n0: "AI", n1: "Foo/Bar", n2: "Trees" })],
    ["lowercase-start value", () => chat({ n0: "AI", n1: "deepLearning", n2: "Trees" })],
    ["no choices", () => ({})],
    ["non-JSON content", () => ({ choices: [{ message: { content: "rename them all please" } }] })],
  ];
  for (const [name, answer] of bad) {
    const input = TWO_LEVEL();
    const before = copy(input);
    const { request } = transport(answer);
    await assert.rejects(() => nameTaxonomyWithModel(input, CONTEXT, OPTIONS, request), /model naming failed/, name);
    assert.deepEqual(copy(input), before, `${name}: input unmutated`);
  }
});

void test("(d) sibling collisions throw — identical and case-variant, without naming the model's segment", async () => {
  for (const pair of [["DeepLearning", "DeepLearning"], ["DeepLearning", "DEEPLEARNING"]]) {
    const input = TWO_LEVEL();
    const before = copy(input);
    const { request } = transport(() => chat({ n0: "AI", n1: pair[0], n2: pair[1] }));
    await assert.rejects(
      () => nameTaxonomyWithModel(input, CONTEXT, OPTIONS, request),
      (err: Error) => {
        assert.match(err.message, /siblings/, pair.join(" vs "));
        assert.ok(!err.message.includes(pair[1]), `the rejected segment ${pair[1]} is not quoted back`);
        return true;
      },
    );
    assert.deepEqual(copy(input), before, "input unmutated");
  }
});

void test("(e) a transport error carrying the key and note text surfaces redacted", async () => {
  const secretText = CONTEXT[0].text;
  const { request } = transport(
    () => ({}),
    () => new Error(`POST ${OPTIONS.endpoint} failed with key=${OPTIONS.apiKey} and body=${secretText}`),
  );
  await assert.rejects(
    () => nameTaxonomyWithModel(TWO_LEVEL(), CONTEXT, OPTIONS, request),
    (err: Error) => {
      assert.match(err.message, /\[redacted\]/, "the key is replaced");
      assert.ok(!err.message.includes(OPTIONS.apiKey!), "the key never surfaces");
      assert.ok(!err.message.includes(secretText.trim()), "no note text surfaces");
      return true;
    },
  );
});

void test("(e2) a short note title echoed by the transport is redacted too", async () => {
  const short = taxonomy([node(1, ["Money"], ["notes/bills.md"])]);
  const shortContext = [{ path: "notes/bills.md", title: "Bills", text: "gas bill paid" }]; // title is 5 chars
  const { request } = transport(
    () => ({}),
    () => new Error(`POST refused the note titled Bills about gas bill paid`),
  );
  await assert.rejects(
    () => nameTaxonomyWithModel(short, shortContext, OPTIONS, request),
    (err: Error) => {
      assert.match(err.message, /\[redacted\]/, "the short title is replaced");
      assert.ok(!err.message.includes("Bills"), "no short title surfaces");
      assert.ok(!err.message.includes("gas bill paid"), "no short text surfaces");
      return true;
    },
  );

  // The edge the lead's rule accepts: a 1-char secret is scrubbed like any other, so it
  // cannot surface — even though that letter is also eaten everywhere else in the line.
  const one = taxonomy([node(1, ["Money"], ["notes/a.md"])]);
  const oneChar = transport(() => ({}), () => new Error("refused: titled Z with body Q"));
  await assert.rejects(
    () => nameTaxonomyWithModel(one, [{ path: "notes/a.md", title: "Z", text: "Q" }], OPTIONS, oneChar.request),
    (err: Error) => {
      assert.ok(!err.message.includes("Z") && !err.message.includes("Q"), "a 1-char secret never surfaces");
      assert.match(err.message, /\[redacted\]/);
      return true;
    },
  );

  // The one thing that must never be scrubbed: the empty string of an empty note, because
  // split("") would shred the diagnostic into one long "[redacted]" run.
  const blank = taxonomy([node(1, ["Money"], ["notes/empty.md"])]);
  const blankCtx = transport(() => ({}), () => new Error("upstream exploded"));
  await assert.rejects(
    () => nameTaxonomyWithModel(blank, [{ path: "notes/empty.md", title: "", text: "" }], OPTIONS, blankCtx.request),
    /model naming failed: upstream exploded/,
  );
});

void test("(f) bounded prompts: SAMPLES_PER_NODE samples of EXCERPT_CHARS each; MAX_NODES nodes", async () => {
  const many = Array.from({ length: SAMPLES_PER_NODE + 4 }, (_, i) => `notes/big${i}.md`);
  const big = taxonomy([node(1, ["Big"], many)]);
  const context = many.map((path) => ({ path, title: `T ${path}`, text: "x".repeat(EXCERPT_CHARS * 3) }));
  const { calls, request } = transport(() => chat({ n0: "Huge" }));
  await nameTaxonomyWithModel(big, context, OPTIONS, request);
  const [sent] = payload(calls[0].body);
  assert.equal(sent.samples.length, SAMPLES_PER_NODE, "at most SAMPLES_PER_NODE samples");
  assert.ok(sent.samples.every((s) => s.excerpt.length <= EXCERPT_CHARS), "each excerpt is bounded");

  const over = taxonomy(
    Array.from({ length: MAX_NODES + 3 }, (_, i) => node(1, [`Topic${i}`], [`notes/t${i}.md`])),
  );
  const overContext = Array.from({ length: MAX_NODES + 3 }, (_, i) => ({ path: `notes/t${i}.md`, title: `T${i}`, text: "text" }));
  const overCalls = transport(() =>
    chat(Object.fromEntries(Array.from({ length: MAX_NODES }, (_, i) => [`n${i}`, `Renamed${i}`]))),
  );
  const out = await nameTaxonomyWithModel(over, overContext, OPTIONS, overCalls.request);
  assert.deepEqual(
    payload(overCalls.calls[0].body).map((p) => p.id),
    Array.from({ length: MAX_NODES }, (_, i) => `n${i}`),
    "exactly the first MAX_NODES ids are sent",
  );
  assert.equal(out.nodes[0].segments[0], "Renamed0");
  assert.deepEqual(out.nodes[MAX_NODES].segments, [`Topic${MAX_NODES}`], "extras keep their local segments");
  assert.equal(out.nodes.length, MAX_NODES + 3, "the whole hierarchy still comes back");
});

void test("(g) empty nodes or empty context never call the transport", async () => {
  for (const [name, input, context] of [
    ["no nodes", taxonomy([]), CONTEXT],
    ["no context", TWO_LEVEL(), []],
  ] as [string, TaxonomyResult, { title: string; text: string; path: string }[]][]) {
    const { calls, request } = transport(() => chat({}));
    const out = await nameTaxonomyWithModel(input, context, OPTIONS, request);
    assert.equal(calls.length, 0, `${name}: no request`);
    assert.deepEqual(copy(out), copy(input), `${name}: unchanged`);
  }
});

void test("(h) body carries options.model; the bearer header appears iff apiKey is set", async () => {
  const withKey = transport(() => chat(RENAMED));
  await nameTaxonomyWithModel(TWO_LEVEL(), CONTEXT, OPTIONS, withKey.request);
  assert.equal(withKey.calls[0].body.model, OPTIONS.model);
  assert.equal(withKey.calls[0].headers.Authorization, `Bearer ${OPTIONS.apiKey}`);

  const noKey = transport(() => chat(RENAMED));
  const keyless: TagNamingOptions = { endpoint: OPTIONS.endpoint, model: OPTIONS.model }; // the same call, no key
  await nameTaxonomyWithModel(TWO_LEVEL(), CONTEXT, keyless, noKey.request);
  assert.equal("Authorization" in noKey.calls[0].headers, false, "no key, no Authorization header");
});

void test("(i) an all-caps acronym segment is accepted", async () => {
  const { request } = transport(() => chat({ n0: "AI", n1: "API", n2: "Trees" }));
  const out = await nameTaxonomyWithModel(TWO_LEVEL(), CONTEXT, OPTIONS, request);
  assert.deepEqual(out.nodes[1].segments, ["AI", "API"]);
});
