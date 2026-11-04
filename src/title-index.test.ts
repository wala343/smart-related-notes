// Unit tests for TitleIndex's exact-case surface regime (order 0023's port of
// the hand-patched behavior): normalize preserves case (NFC + whitespace
// collapse only), and compiledFor compiles the mention alternation without the
// ignore-case flag — an exactly-cased mention matches, a re-cased one never
// does. Offline and synthetic: a tiny fake App over file literals.
//
// Run (flagless — type stripping is default-on from Node 22.18; the --import
// prefix maps `obsidian`, which title-index.ts imports as a value, onto
// bench/obsidian-stub.mjs):
//   node --import ./bench/register-stub.mjs --test src/title-index.test.ts src/link-text.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
// The ".ts" specifier is for node's type stripping; tsc (no
// allowImportingTsExtensions) charges it on value imports — the ledger.test.ts
// precedent. The type-only obsidian import below needs no directive.
// @ts-expect-error
import { TitleIndex } from "./title-index.ts";
import type { App, TFile } from "obsidian";

// The reader-candidates.test.ts precedent: a file literal stands in for a TFile
// (only .path/.basename are read here; no instance checks run on them).
function mkFile(path: string): TFile {
  const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- offline double: a real TFile cannot exist in a node:test process
  return { path, basename, extension: "md" } as unknown as TFile;
}

// The minimum App surface TitleIndex touches: vault.getMarkdownFiles,
// vault.getAbstractFileByPath, metadataCache.getFileCache.
function mkApp(files: TFile[]): App {
  return {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (path: string) =>
        files.find((f) => f.path === path) ?? null,
    },
    metadataCache: { getFileCache: () => null },
  } as unknown as App;
}

void test("normalize preserves case, still NFC-normalizes and collapses whitespace", () => {
  const idx = new TitleIndex(mkApp([]), () => []);
  assert.equal(idx.normalize("Café  Note"), "Café Note"); // case kept, blanks collapsed
  assert.equal(idx.normalize("café note"), "café note");
  assert.notEqual(idx.normalize("Café  Note"), idx.normalize("café note")); // no case folding
  // NFC still applied: decomposed e+combining-acute collapses to the composed é.
  assert.equal(idx.normalize("cafe\u0301 note"), "café note");
});

void test("compiledFor matches an exactly-cased mention and never a re-cased one", () => {
  const idx = new TitleIndex(mkApp([mkFile("notes/Berlin.md")]), () => []);
  const re = idx.compiledFor("scratch/Today.md");
  assert.ok(re, "a vault with one note must yield an alternation");
  assert.equal(re.flags, "gu"); // global + unicode, never ignorecase
  re.lastIndex = 0;
  assert.ok(re.test("I have visited Berlin before"));
  re.lastIndex = 0;
  assert.ok(!re.test("i have visited berlin before"));
  // Lookups follow the same regime: the exact case resolves, the re-cased form doesn't.
  assert.equal(idx.resolve("Berlin")?.file.path, "notes/Berlin.md");
  assert.equal(idx.resolve("berlin"), null);
});
