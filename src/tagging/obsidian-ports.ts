// =============================================================================
// OBSIDIAN PORTS — the concept-tag pipeline's two vault-side adapters.
//
// Deliberately free of any "obsidian" import: the App surface is described by
// structural, method-syntax interfaces (method bivariance lets the real App
// satisfy them), so this file loads headless under node:test and both adapters
// stay testable over synthetic fakes. The pure layers own every rule (apply
// merges, the ledger parses); these functions only marshal across the vault
// boundary — no parsing, no clock, no path logic here.
// =============================================================================

import type { ApplyFrontmatterPort } from "./apply";
import type { LedgerStoragePort } from "./ledger";

// The exact App members the frontmatter port touches, structural so no
// "obsidian" import is needed.
export interface FrontmatterReading {
  vault: { getAbstractFileByPath(path: string): { path: string } | null };
  metadataCache: { getFileCache(file: unknown): { frontmatter?: Record<string, unknown> } | null };
  fileManager: { processFrontMatter(file: unknown, mutate: (frontmatter: Record<string, unknown>) => void): Promise<void> };
}

// One plugin-directory JSON file, bound by the caller (main.ts owns the path).
export interface JsonFileAccess {
  exists(): Promise<boolean>;
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

// The tags channel of this vault is the `tags:` frontmatter key alone — inline
// #tags are read by nothing here. An array value passes through as-is; a lone
// string is the one-element list; an absent key (or missing note) is null,
// which apply reads as "no tags key" while [] means "key present, empty".
export function obsidianFrontmatterPort(app: FrontmatterReading): ApplyFrontmatterPort {
  return {
    readNoteTags: async (notePath: string): Promise<string[] | null> => {
      const file = app.vault.getAbstractFileByPath(notePath);
      if (!file) return null; // missing note: no tags key; apply turns any later write into note-unavailable
      const raw = app.metadataCache.getFileCache(file)?.frontmatter?.tags;
      if (raw === undefined) return null; // key absent — distinct from the [] below
      if (Array.isArray(raw)) return raw.map(String); // a YAML number/list item must not reach apply's toLowerCase fold uncoerced
      if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
      return []; // any other value form: the key exists and reads empty; the write normalizes it
    },
    writeNoteTags: async (notePath: string, tags: string[]): Promise<void> => {
      const file = app.vault.getAbstractFileByPath(notePath);
      if (!file) throw new Error(`note-unavailable: ${notePath}`); // apply's per-note guard skips, never crashes
      // An array value serializes as a YAML block list; every other frontmatter key survives untouched.
      await app.fileManager.processFrontMatter(file, (fm) => {
        fm.tags = tags;
      });
    },
  };
}

// The undo journal as one JSON file: absent file reads as null (the ledger's
// "no journal yet"); text is stored verbatim, parse errors belong to ledger.ts.
export function jsonFileLedgerStorage(file: JsonFileAccess): LedgerStoragePort {
  return {
    readLedgerText: async (): Promise<string | null> => ((await file.exists()) ? await file.read() : null),
    writeLedgerText: (text: string): Promise<void> => file.write(text),
  };
}
