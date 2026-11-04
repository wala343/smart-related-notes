// Link-text contract tests (order 0023): buildWikiLink preserves the typed
// surface — an exact basename match collapses to [[basename]], everything else
// links as [[basename|surface]] with the casing verbatim — and detectMentions
// end-to-end glows an exactly-cased mention while ignoring a re-cased one.
// Offline and synthetic: a tiny fake App over file literals; no vault, no CM6
// DOM — only the pure scan/link functions of link-glow.ts are exercised.
//
// Run (flagless; the --import prefix maps `obsidian` onto bench/obsidian-stub.mjs):
//   node --import ./bench/register-stub.mjs --test src/title-index.test.ts src/link-text.test.ts
// link-glow.ts imports editorLivePreviewField as a VALUE, which the shared stub
// does not export, so this file installs its own resolve hook first (the
// reader-candidates.test.ts precedent): `obsidian` maps to a shim re-exporting
// the WHOLE bench stub (one instance for every importer) plus that one field
// (a stand-in never exercised here — it exists only so the named import binds).
// register() must precede the dynamic imports below, because static imports
// hoist ahead of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { App, TFile } from "obsidian";

const dataUrl = (src: string): string =>
  "data:text/javascript," + encodeURIComponent(src);
const OBSIDIAN_SHIM = dataUrl(
  `export * from ${JSON.stringify(new URL("../bench/obsidian-stub.mjs", import.meta.url).href)};\n` +
    "export const editorLivePreviewField = {};\n",
);
register(
  dataUrl(
    `export async function resolve(specifier, context, next) {\n` +
      `  if (specifier === "obsidian") return { url: ${JSON.stringify(OBSIDIAN_SHIM)}, shortCircuit: true };\n` +
      `  return next(specifier, context);\n` +
      `}\n`,
  ),
  import.meta.url,
);
// Extensionless specifiers, resolved at runtime by the register-stub prefix's
// stub-loader (adds .ts); tsc's Bundler resolution accepts them — the
// reader-candidates.test.ts precedent.
const { TitleIndex } = await import("./title-index");
const { buildWikiLink, detectMentions } = await import("./link-glow");

function mkFile(path: string): TFile {
  const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- offline double: a real TFile cannot exist in a node:test process
  return { path, basename, extension: "md" } as unknown as TFile;
}
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

void test("buildWikiLink keeps the typed surface; only an exact basename match collapses", () => {
  const berlin = mkFile("notes/Berlin.md");
  const idx = new TitleIndex(mkApp([berlin]), () => []);
  assert.equal(buildWikiLink(berlin, "Berlin", idx), "[[Berlin]]");
  // A re-cased surface is linkable prose, not the basename: keep it verbatim.
  assert.equal(buildWikiLink(berlin, "berlin", idx), "[[Berlin|berlin]]");
  // An alias surface links with the text exactly as typed.
  assert.equal(buildWikiLink(berlin, "Berliner Mauer", idx), "[[Berlin|Berliner Mauer]]");
});

void test("detectMentions links an exact-cased mention and skips a re-cased one", () => {
  const idx = new TitleIndex(mkApp([mkFile("notes/Berlin.md")]), () => []);
  const doc = "Prior work on Berlin, and more prior work on berlin, says it all.";
  const mentions = detectMentions(doc, idx, "scratch/Today.md", {
    all: true,
    allowAmbiguous: false,
  });
  assert.equal(mentions.length, 1); // the lowercase mention produces nothing
  assert.equal(mentions[0].surface, "Berlin");
  assert.equal(doc.slice(mentions[0].from, mentions[0].to), "Berlin");
});
