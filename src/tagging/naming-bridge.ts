// =============================================================================
// NAMING BRIDGE — the plugin-side adapter for the optional model naming pass.
//
// It turns the concept-tagging settings into a tag-namer call: the provider
// selection, the per-note context excerpt, the combined cache-validity key,
// the Obsidian requestUrl transport shim, a bounded scrubbed request wrapper,
// and the one orchestrator that never fails — every naming failure leaves the
// local taxonomy in place with a fixed, non-sensitive line. Local naming stays
// the default and the fallback; asking the model is strictly opt-in.
//
// Pure apart from the injected transport and its timeout race: no obsidian
// import (the transport factory takes requestUrl as a plain function), no fs.
// No response body and no API key ever appears in a message this module
// produces — only fixed lines and a numeric status.
// =============================================================================

import type { TaxonomyResult } from "./proposal";
import type { TagNamingOptions, TagNamingRequest } from "./tag-namer";
// Value imports need the ".ts" specifier for Node's runtime (the test chain has
// no extension resolution); the expect-error pins the one tsc complaint.
// @ts-expect-error
import { nameTaxonomyWithModel } from "./tag-namer.ts";

// The plugin gives the opportunistic naming pass no more room to hang than this.
export const NAMING_REQUEST_TIMEOUT_MS = 20000;

// The fixed failure line: concise, non-sensitive, never interpolates the caught error.
const FAILURE_NOTICE = "Concept naming unavailable — local taxonomy kept.";

export interface ModelNamingOutcome {
  taxonomy: TaxonomyResult; // the renamed taxonomy on success, the local one otherwise
  named: boolean;           // true only when the model's renames came back valid
  failure?: string;         // the fixed line, set exactly when a naming attempt failed
}

// The raw transport the plugin has: post what it is handed, return status and
// raw body text — nothing interpreted in between.
export type NamingTransport =
  (url: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number; text: string }>;

// The slice of requestUrl this bridge needs; the real Obsidian function satisfies
// it structurally, so main.ts just passes it and this module stays obsidian-free.
type RequestUrlLike = (
  request: { url: string; method: string; headers: Record<string, string>; body: string; throw: boolean },
) => Promise<{ status: number; text: string }>;

// The Obsidian-side shim: one POST with the body JSON-encoded, throw:false so the
// status comes back for the guard below instead of rejecting inside requestUrl.
export function namingTransportFrom(requestUrl: RequestUrlLike): NamingTransport {
  return async (url, body, headers) => {
    const response = await requestUrl({ url, method: "POST", headers, body: JSON.stringify(body), throw: false });
    return { status: response.status, text: response.text }; // only these two cross the bridge
  };
}

// The settings-shaped provider choice: null means "ask nothing" — local mode, or
// an openai-compatible mode with a blank endpoint or model, keeps the local
// taxonomy with no request at all. A blank key simply sends no Authorization.
export function providerSelectionFrom(
  mode: "local" | "openai-compatible",
  endpoint: string,
  model: string,
  apiKey: string,
): TagNamingOptions | null {
  if (mode !== "openai-compatible") return null;
  if (endpoint.trim() === "" || model.trim() === "") return null; // not configured: naming silently skipped
  return apiKey === "" ? { endpoint, model } : { endpoint, model, apiKey };
}

// One note's context excerpt, from the stripped body text currentTaxonomy already
// read for the local build — capped so the prompt stays bounded per note.
export function excerptNoteText(text: string, cap = 1200): string {
  return text.slice(0, cap);
}

// The naming half of the taxonomy cache's validity key. It carries mode,
// endpoint, model and WHETHER a key is set — never the key's value, so rotating
// the key changes no naming input and invalidates nothing. "\n" separates: it is
// unrepresentable in each field, so two fields can never fake one key.
export function namingCacheKey(
  mode: "local" | "openai-compatible",
  endpoint: string,
  model: string,
  apiKeySet: boolean,
): string {
  return [mode, endpoint, model, apiKeySet ? "key" : "no-key"].join("\n");
}

// Wrap the raw transport in the provider's request signature and bound it: a
// status guard and a JSON parse, both scrubbed, raced against a timeout.
// requestUrl cannot be aborted mid-flight — the raced rejection IS the bound;
// the dangling request is Obsidian-managed.
export function boundedNamingRequest(transport: NamingTransport, timeoutMs: number): TagNamingRequest {
  return async (url, body, headers) => {
    let timer: number | undefined; // window.setTimeout's handle type (node runs behind the tests' window shim)
    const sent = transport(url, body, headers);
    sent.catch(() => {}); // once the timeout wins, nothing else is left to observe a late transport failure
    try {
      const response = await Promise.race([
        sent,
        new Promise<never>((_, reject) => {
          // window-qualified per the popout timer lint: the plugin's realm is the
          // main window; the naming suite's node run shims window to node's timers.
          timer = window.setTimeout(() => reject(new Error("the naming request timed out")), timeoutMs);
        }),
      ]);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`the naming endpoint returned status ${response.status}`); // the status is all this message carries
      }
      try {
        // The parse result stays unknown: the provider casts to its own response
        // shape, so no `any` ever crosses the bridge.
        const parsed: unknown = JSON.parse(response.text); // the provider's parser wants the parsed {choices: ...} object
        return parsed;
      } catch {
        throw new Error("the naming response was not JSON"); // never a fragment of the body
      }
    } finally {
      window.clearTimeout(timer); // qualified for the same popout lint as the arm above
    }
  };
}

// The one orchestrator main.ts calls. A null selection asks nothing; success
// renames; every failure — transport, timeout, status, parse or provider
// validation — keeps the local taxonomy, logs the provider's already-scrubbed
// Error and hands back the fixed line for the caller's Notice.
export async function applyModelNaming(
  taxonomy: TaxonomyResult,
  context: { title: string; text: string; path: string }[],
  selection: TagNamingOptions | null,
  request: TagNamingRequest,
): Promise<ModelNamingOutcome> {
  if (selection === null) return { taxonomy, named: false }; // local or unconfigured: no request, nothing changes
  try {
    return { taxonomy: await nameTaxonomyWithModel(taxonomy, context, selection, request), named: true };
  } catch (e) {
    console.warn("[related-notes] model naming failed", e); // the provider scrubbed note strings and the key before this point
    return { taxonomy, named: false, failure: FAILURE_NOTICE };
  }
}
