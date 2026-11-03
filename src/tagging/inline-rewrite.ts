// =============================================================================
// INLINE REWRITE — the concept-tag pipeline's real inline `#tag` mutation core.
//
// Three pure functions carry an approved rewrite to the `#tags` in a note's body,
// not only its frontmatter block list: one turns live cache spans plus note
// text into an exact, validated replacement plan, another folds EVERY approved
// replacement of a note into ONE such plan so same-note rewrites cannot overwrite
// each other at commit time, the third undoes a committed
// plan later without clobbering whatever the user retyped in between. Spans
// come from Obsidian's metadata cache, which never emits a tag occurrence
// inside a code fence, inline code, a link or a URL — that exclusion is the
// caller's contract, so this module holds no fence or markdown parsing of its
// own: it revalidates offsets against the text it was handed, and nothing else.
// Note storage stays behind the injected InlineRewriteAccess below (the port's
// vocabulary, order 0011). The module imports nothing at runtime, takes no
// clock, and never throws on well-formed input.
// =============================================================================

// One cached inline occurrence: offsets into the note text plus the occurrence
// exactly as it appears, "#" included.
export interface InlineTagSpan {
  start: number;
  end: number;
  text: string;
}

// One rewrite as recorded in the ledger: note-text offsets that locate the
// rewritten occurrence, plus the exact strings either side of it.
export interface InlineEditRecord {
  start: number;
  end: number;
  before: string;
  after: string;
}

// The I/O seam, declared here for the command port to carry: the adapter reads
// note content and the live cache's spans, and writes text back.
export interface InlineRewriteAccess {
  readNoteContent(notePath: string): Promise<string | null>; // null: note missing
  writeNoteContent(notePath: string, text: string): Promise<void>;
  inlineTagSpans(notePath: string): Promise<InlineTagSpan[]>; // live cache positions; code fences excluded by construction
}

export interface InlineRewritePlan {
  content: string;
  edits: InlineEditRecord[];
}

// Rewrite every span whose text is exactly "#"+replacesTag into "#"+tagPath. The plan's
// edits carry note-text offsets ascending; spans are emitted by the caller merged in
// document order. Returns null when ANY target span's slice fails equality with its
// text (offset revalidation) — a stale cache must veto, never mis-cut. Spans are read in
// the given content's frame, records in the frame the plan returns: each record's slice
// there is its `after`, which is what makes a later revert revalidatable per record.
export function computeInlineRewrite(
  content: string,
  spans: InlineTagSpan[],
  replacesTag: string,
  tagPath: string,
): InlineRewritePlan | null {
  const before = `#${replacesTag}`;
  const after = `#${tagPath}`; // verbatim after "#": no case folding anywhere here
  // filter already copies, so the sort cannot reorder the caller's spans.
  const targets = spans.filter((s) => s.text === before).sort((a, b) => a.start - b.start);
  // Revalidation up front, over every target, before a single character is cut: one
  // stale span vetoes the whole call, so a partial plan can never reach a writer.
  for (const s of targets) {
    if (content.slice(s.start, s.end) !== s.text) return null;
  }
  const edits: InlineEditRecord[] = [];
  let out = "";
  let pos = 0;
  let shift = 0; // this plan's own running length delta
  for (const s of targets) {
    if (s.start < pos) continue; // a duplicated or overlapping span is the SAME occurrence, not another one
    out += content.slice(pos, s.start) + after; // one pass, ascending original offsets
    pos = s.end;
    // A record's anchor is its span's start carried into the REWRITTEN text, so the
    // guard's slice(start, end) is exactly `after` there — and stays a valid anchor even
    // when a revert is handed only some of the plan's records.
    edits.push({ start: s.start + shift, end: s.start + shift + after.length, before, after });
    shift += after.length - before.length;
  }
  return { content: out + content.slice(pos), edits };
}

// One approved replacement for a note, as a batch request carries it: the tag being
// replaced and the path it becomes. The batch folds a note's whole list, in the given order.
export interface InlineReplacementRequest {
  replacesTag: string;
  tagPath: string;
}

export interface InlineRewriteBatch {
  source: string; // the content the plan was computed from: the commit-time revalidation basis
  content: string; // the fully rewritten document
  editGroups: InlineEditRecord[][]; // aligns with requests: group i holds request i's records
}

// A region the fold has cut, held in the ORIGINAL content's frame: the document is rebuilt
// from there in one pass, and each record's frame is whatever that pass makes of it.
interface FoldCut {
  start: number;
  end: number;
  before: string;
  after: string;
  group: number; // which request's group this cut's record lands in
}

// Does a span's region clash with the fold's cuts (kept ascending, so the scan stops early)?
// "straddle": the span starts before a cut and runs into it, so part of the text it caches has
// already been replaced in the document the fold walks — that is drift, and it vetoes.
// "inside": the span STARTS inside a cut region, i.e. it is the same occurrence handed over
// again (the caller's merge, or a later request naming a tag an earlier request already
// renamed); the earlier request owns it, exactly as a duplicated span belongs to the first
// cut within a single plan.
function clashOf(cuts: FoldCut[], start: number, end: number): "none" | "inside" | "straddle" {
  let inside = false;
  for (const c of cuts) {
    if (c.end <= start) continue; // entirely before the span: its cut only shifts the span
    if (c.start >= end) break; // ascending: every later cut lies further after the span still
    if (start < c.start) return "straddle";
    inside = true;
  }
  return inside ? "inside" : "none";
}

// ONE revalidated document plan for ALL of a note's approved replacements, folded in the given
// request order. Each request's targets (`text === "#"+replacesTag`, from the spans still
// unclaimed) are revalidated against the document the earlier requests produced — spans carry
// across those edits' length deltas — and NO character is cut until every target of every
// request has held, so one stale span leaves the whole batch as null and no partial plan
// reaches a writer. A request with no matching spans yields an EMPTY group, not drift. Records
// land in the FINAL frame: each is the cut's original start carried by every earlier cut's
// length delta, so each group's slices are simultaneously valid against `content` and a batch
// can be journaled truthfully and reverted per entry. The single-replacement planner above
// stays as it is for the modal preview.
export function computeInlineRewriteBatch(
  content: string,
  spans: InlineTagSpan[],
  requests: InlineReplacementRequest[],
): InlineRewriteBatch | null {
  const cuts: FoldCut[] = [];
  const claimed = new Set<InlineTagSpan>(); // one span object is one occurrence: one request takes it
  for (let i = 0; i < requests.length; i++) {
    const before = `#${requests[i].replacesTag}`;
    const after = `#${requests[i].tagPath}`; // verbatim after "#": no case folding anywhere here
    // filter already copies, so the sort cannot reorder the caller's spans.
    const targets = spans
      .filter((s) => !claimed.has(s) && s.text === before)
      .sort((a, b) => a.start - b.start);
    for (const s of targets) {
      claimed.add(s);
      const clash = clashOf(cuts, s.start, s.end);
      if (clash === "straddle") return null; // its cached text is gone from the frame it is read in
      if (clash === "inside") continue; // the same occurrence, already taken by an earlier request
      // Revalidation against the evolving document, per target, before any cut: the offsets are
      // the span's own and the fold only ever rewrites OTHER regions, so the slice here is the
      // slice the fold sees at this span's translated position.
      if (content.slice(s.start, s.end) !== s.text) return null;
      cuts.push({ start: s.start, end: s.end, before, after, group: i });
      cuts.sort((a, b) => a.start - b.start); // stays ascending, and disjoint by the two checks above
    }
  }
  // One pass over the ORIGINAL offsets rebuilds the document and anchors every record in the
  // frame it returns: `shift` carries the record past all the cuts before it in the document,
  // so guard-slicing any group against the batch's content finds exactly its `after`.
  const editGroups: InlineEditRecord[][] = requests.map(() => []);
  let out = "";
  let pos = 0;
  let shift = 0; // the fold's running length delta, across EVERY request
  for (const c of cuts) {
    if (c.start < pos) continue; // belt-and-braces: the clash checks above keep cuts disjoint
    out += content.slice(pos, c.start) + c.after;
    pos = c.end;
    editGroups[c.group].push({
      start: c.start + shift,
      end: c.start + shift + c.after.length,
      before: c.before,
      after: c.after,
    });
    shift += c.after.length - c.before.length;
  }
  return { source: content, content: out + content.slice(pos), editGroups };
}

export interface InlineRevertResult {
  content: string;
  reverted: number;
  skipped: number;
}

// Revert committed records. A record is restored ONLY where content.slice(start, end)
// === record.after (the intervening-edit guard: anything the user retyped in that span
// is left alone and counted skipped). Result carries the reverted content and counts.
export function revertInlineRewrites(
  content: string,
  edits: InlineEditRecord[],
): InlineRevertResult {
  const records = [...edits].sort((a, b) => a.start - b.start); // copy: the ledger keeps its order
  let out = "";
  let pos = 0;
  let reverted = 0;
  let skipped = 0;
  for (const e of records) {
    // Guard: an anchor whose slice no longer equals `after` was moved or retyped — leave
    // that region exactly as it is. An anchor inside an already-restored region (the same
    // record handed twice) is the same case: skip it, never cut twice.
    if (e.start < pos || content.slice(e.start, e.end) !== e.after) {
      skipped += 1;
      continue;
    }
    out += content.slice(pos, e.start) + e.before;
    pos = e.end;
    reverted += 1;
  }
  return { content: out + content.slice(pos), reverted, skipped };
}
