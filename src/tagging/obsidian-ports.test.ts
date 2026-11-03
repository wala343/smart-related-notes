// Unit tests for the two Obsidian-side adapters: offline, over synthetic fakes
// of the structural FrontmatterReading / JsonFileAccess shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FrontmatterReading, JsonFileAccess } from "./obsidian-ports";
// Node's transform-types needs the ".ts" specifier; tsc flags it only because tsconfig (not ours to edit)
// omits allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else.
// @ts-expect-error
import { jsonFileLedgerStorage, obsidianFrontmatterPort } from "./obsidian-ports.ts";

// One fake App: path -> the frontmatter record metadataCache reports (null =
// the note has no cache entry), plus a log of what processFrontMatter ended up
// storing. processFrontMatter mutates the record in place, mirroring Obsidian.
function makeFrontmatterApp(notes: Record<string, Record<string, unknown> | null>) {
  const stored: Record<string, Record<string, unknown> | null> = { ...notes };
  const app: FrontmatterReading = {
    vault: {
      getAbstractFileByPath: (path) => (path in stored ? { path } : null),
    },
    metadataCache: {
      // getFileCache reports a cache ENTRY whose .frontmatter is the record.
      getFileCache: (file) => {
        const fm = stored[(file as { path: string }).path];
        return fm === undefined || fm === null ? null : { frontmatter: fm };
      },
    },
    fileManager: {
      processFrontMatter: async (file, mutate) => {
        const path = (file as { path: string }).path;
        const fm: Record<string, unknown> = { ...(stored[path] ?? {}) };
        mutate(fm);
        stored[path] = fm;
      },
    },
  };
  return { app, stored };
}

void test("readNoteTags: array value passes through as-is", async () => {
  const { app } = makeFrontmatterApp({ "a.md": { tags: ["Physics/MRI", "goa"] } });
  assert.deepEqual(await obsidianFrontmatterPort(app).readNoteTags("a.md"), ["Physics/MRI", "goa"]);
});

void test("readNoteTags: lone string reads as the one-element list, empty string as []", async () => {
  const { app } = makeFrontmatterApp({ "a.md": { tags: "Physics" }, "b.md": { tags: "" } });
  const port = obsidianFrontmatterPort(app);
  assert.deepEqual(await port.readNoteTags("a.md"), ["Physics"]);
  assert.deepEqual(await port.readNoteTags("b.md"), []); // key present, empty — distinct from null
});

void test("readNoteTags: any other value form reads as []", async () => {
  const { app } = makeFrontmatterApp({ "a.md": { tags: 42 }, "b.md": { tags: { x: 1 } } });
  const port = obsidianFrontmatterPort(app);
  assert.deepEqual(await port.readNoteTags("a.md"), []);
  assert.deepEqual(await port.readNoteTags("b.md"), []);
});

void test("readNoteTags: non-string array items are coerced, never crash later folds", async () => {
  const { app } = makeFrontmatterApp({ "a.md": { tags: [1, "City", true] } });
  assert.deepEqual(await obsidianFrontmatterPort(app).readNoteTags("a.md"), ["1", "City", "true"]);
});

void test("readNoteTags: absent key, absent frontmatter, absent cache, absent note all read null", async () => {
  const { app } = makeFrontmatterApp({
    "a.md": { aliases: ["A"] }, // frontmatter exists, no tags key
    "b.md": null, // note exists with no metadata cache entry
  });
  const port = obsidianFrontmatterPort(app);
  assert.equal(await port.readNoteTags("a.md"), null);
  assert.equal(await port.readNoteTags("b.md"), null);
  assert.equal(await port.readNoteTags("gone.md"), null); // missing file
});

void test("writeNoteTags: replaces only the tags key, preserving every other key", async () => {
  const { app, stored } = makeFrontmatterApp({ "a.md": { aliases: ["A"], tags: "old", cssclasses: [] } });
  await obsidianFrontmatterPort(app).writeNoteTags("a.md", ["Physics/MRI", "City"]);
  assert.deepEqual(stored["a.md"], { aliases: ["A"], tags: ["Physics/MRI", "City"], cssclasses: [] });
});

void test("writeNoteTags: creates the key when absent and reads back as a list", async () => {
  const { app } = makeFrontmatterApp({ "a.md": {} });
  const port = obsidianFrontmatterPort(app);
  await port.writeNoteTags("a.md", ["City"]);
  assert.deepEqual(await port.readNoteTags("a.md"), ["City"]);
});

void test("writeNoteTags: a missing note throws — apply turns it into a note-unavailable skip", async () => {
  const { app } = makeFrontmatterApp({});
  await assert.rejects(() => obsidianFrontmatterPort(app).writeNoteTags("gone.md", ["x"]));
});

// One fake JSON file: initial null means the file does not exist yet.
function makeLedgerFile(initial: string | null) {
  let text = initial;
  let exists = initial !== null;
  const access: JsonFileAccess = {
    exists: async () => exists,
    read: async () => {
      if (!exists || text === null) throw new Error("ENOENT");
      return text;
    },
    write: async (t) => {
      text = t;
      exists = true;
    },
  };
  return { access, text: () => text, exists: () => exists };
}

void test("jsonFileLedgerStorage: an absent file reads as the empty journal (null)", async () => {
  const file = makeLedgerFile(null);
  assert.equal(await jsonFileLedgerStorage(file.access).readLedgerText(), null);
});

void test("jsonFileLedgerStorage: read hands back stored text verbatim, write lands it verbatim", async () => {
  const file = makeLedgerFile('[{"notePath":"a.md"}]');
  const port = jsonFileLedgerStorage(file.access);
  assert.equal(await port.readLedgerText(), '[{"notePath":"a.md"}]'); // no parsing here — malformed text also passes through
  await port.writeLedgerText("[]");
  assert.equal(file.text(), "[]");
  assert.equal(await port.readLedgerText(), "[]");
});

void test("jsonFileLedgerStorage: write creates the file", async () => {
  const file = makeLedgerFile(null);
  const port = jsonFileLedgerStorage(file.access);
  await port.writeLedgerText("[]");
  assert.equal(file.exists(), true);
  assert.equal(await port.readLedgerText(), "[]");
});
