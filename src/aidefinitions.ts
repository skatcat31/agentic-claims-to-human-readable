/**
 * AI-assisted knowledge-base fill.
 *
 * When ingesting a claim, every segment id and element position is checked
 * against the vector-DB knowledge base. For anything the KB does not
 * define, an optional call is made to a configurable AI endpoint (any
 * OpenAI-compatible /chat/completions API) to fetch the official X12
 * definitions of the missing fields. The response is validated with the
 * same parseKbChunk() used for the built-in KB, then upserted into the
 * vector store as a normal `kb` record (meta.source = 'ai') — so later
 * RAG retrievals (exports, summaries, re-ingests) pick it up automatically.
 *
 * Enabled only when AI_ENDPOINT is set; otherwise ingestion behaves exactly
 * as before (unknown fields keep the "Element N" fallback label). AI
 * failures never block ingestion.
 *
 * HIPAA: the prompt contains only the segment id, 1-based element
 * positions, the interchange standard version (ST03) and existing KB
 * definitions — never claim data values. No PHI leaves the machine.
 */

import { VectorStore } from './vectorstore';
import { ParsedSegment } from './parse837';
import { parseKbChunk, ParsedSpec } from './knowledge837';
import { retrieveSegmentSpec } from './rag';

export interface AIConfig {
  /** Full URL of an OpenAI-compatible chat-completions endpoint. */
  endpoint: string;
  /** Bearer token (omit for local/proxy endpoints that need none). */
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

/** Read the AI config from the environment; null when AI_ENDPOINT is unset. */
export function aiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AIConfig | null {
  const endpoint = (env.AI_ENDPOINT ?? '').trim();
  if (!endpoint) return null;
  return {
    endpoint,
    apiKey: (env.AI_API_KEY ?? '').trim() || undefined,
    model: (env.AI_MODEL ?? '').trim() || 'gpt-4o-mini',
    timeoutMs: parseInt((env.AI_TIMEOUT_MS ?? '').trim(), 10) || 30000,
  };
}

/** A segment (or element positions within it) missing from the KB. */
export interface KbGap {
  segId: string;
  /** 1-based element positions the KB does not define. */
  missing: number[];
  /** Highest element position observed in the claim (1-based). */
  maxObserved: number;
  /** Current KB chunk text for this segment (when the KB knows the segment). */
  existing: string | null;
}

export interface KbFillResult {
  /** True when no AI endpoint is configured and the fill was skipped. */
  disabled: boolean;
  /** Segments whose missing definitions were fetched and stored. */
  filled: { segId: string; positions: number[] }[];
  /** Segments where the AI fetch or validation failed. */
  failed: { segId: string; error: string }[];
}

/** Serialize a ParsedSpec back to KB chunk text. */
function specToChunkText(segId: string, spec: ParsedSpec): string {
  let text = 'SEG ' + segId + ' ' + spec.name;
  const indices = Object.keys(spec.elements)
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b);
  for (const i of indices) {
    const el = spec.elements[i];
    text += '\nEL ' + String(i).padStart(2, '0') + ' ' + el.code + ' ' + el.name + ' :: ' + el.desc;
  }
  return text;
}

/**
 * Which segment element positions does the vector-DB KB fail to define,
 * for the segments present in the parsed claim?
 */
export function findKbGaps(store: VectorStore, segments: ParsedSegment[]): KbGap[] {
  const bySeg = new Map<string, ParsedSegment[]>();
  for (const s of segments) {
    const arr = bySeg.get(s.id) ?? [];
    arr.push(s);
    bySeg.set(s.id, arr);
  }
  const gaps: KbGap[] = [];
  for (const [segId, segs] of bySeg) {
    const hit = retrieveSegmentSpec(store, segId);
    const spec = hit && hit.spec.segId.toUpperCase() === segId.toUpperCase() ? hit.spec : null;
    const maxObserved = Math.max(...segs.map((s) => s.elements.length));
    const missing: number[] = [];
    for (let pos = 1; pos <= maxObserved; pos++) if (!spec || !spec.elements[pos]) missing.push(pos);
    if (!missing.length) continue;
    gaps.push({ segId, missing, maxObserved, existing: spec ? specToChunkText(segId, spec) : null });
  }
  return gaps;
}

/** ST03 (interchange standard version), when present in the claim. */
function claimStandard(segments: ParsedSegment[]): string {
  const st = segments.find((s) => s.id === 'ST');
  return st && st.elements[2] ? st.elements[2].display : '';
}

/** Prompt asking the AI for the X12 definitions in KB chunk format. */
export function kbFillPrompt(gap: KbGap, standard: string): string {
  const codes = gap.missing.map((p) => gap.segId + String(p).padStart(2, '0')).join(', ');
  const lines = [
    'You are an expert on the X12 EDI standard, specifically healthcare 837 claims.',
    'Interchange standard version of the claim: ' + (standard || 'unknown'),
    'I need element definitions for X12 segment ' + gap.segId + '.',
    gap.existing
      ? 'My knowledge base currently holds this definition for the segment (keep these entries verbatim):'
      : 'My knowledge base has no definition for this segment yet.',
  ];
  if (gap.existing) lines.push(gap.existing);
  lines.push(
    'Element positions missing from my knowledge base (1-based, in segment order): ' + codes + '.',
    'The claim contains values up to position ' +
      gap.maxObserved +
      ', so cover at least positions 1..' +
      gap.maxObserved +
      ', and include the remaining standard positions for this segment as well.',
    '',
    'Respond with ONLY a chunk in exactly this format - no commentary, no markdown, no code fences:',
    'SEG ' + gap.segId + ' <Segment Name>',
    'EL 01 ' + gap.segId + '01 <Element Name> :: <one-sentence definition>',
    'EL 02 ' + gap.segId + '02 <Element Name> :: <one-sentence definition>',
    'One EL line per position, in ascending order, positions zero-padded to two digits.'
  );
  return lines.join('\n');
}

/** Call the AI endpoint (OpenAI-compatible chat completions). */
async function chatCompletion(cfg: AIConfig, prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('AI endpoint returned HTTP ' + res.status);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const first = j.choices && j.choices.length ? j.choices[0] : undefined;
    const content = first && first.message ? first.message.content : undefined;
    if (!content) throw new Error('AI response contained no message content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the SEG/EL chunk out of a model response (tolerates code fences). */
export function extractKbChunk(raw: string): string | null {
  let text = raw.trim();
  const fence = text.match(/```[\w-]*\s*\n([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const start = lines.findIndex((l) => /^SEG\s/.test(l));
  if (start < 0) return null;
  let end = lines.length - 1;
  while (end > start && !/^EL\s/.test(lines[end])) end--;
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Check a parsed claim against the vector-DB KB and, for every missing
 * definition, ask the AI endpoint for the X12 definitions and store the
 * result in the KB. Non-blocking: gaps without an AI endpoint (or with a
 * failing endpoint) are reported in the result, never thrown.
 */
export async function ensureKbCoverage(
  store: VectorStore,
  segments: ParsedSegment[],
  cfg: AIConfig | null,
  log: (msg: string) => void = (m) => console.log('[kb-fill] ' + m)
): Promise<KbFillResult> {
  const gaps = findKbGaps(store, segments);
  if (!gaps.length) return { disabled: !cfg, filled: [], failed: [] };
  if (!cfg) {
    for (const g of gaps)
      log('gap: ' + g.segId + ' position(s) ' + g.missing.join(', ') + ' undefined in KB (set AI_ENDPOINT to auto-fill)');
    return { disabled: true, filled: [], failed: [] };
  }

  const standard = claimStandard(segments);
  const filled: KbFillResult['filled'] = [];
  const failed: KbFillResult['failed'] = [];
  for (const gap of gaps) {
    try {
      const raw = await chatCompletion(cfg, kbFillPrompt(gap, standard));
      const chunk = extractKbChunk(raw);
      if (!chunk) throw new Error('response contained no SEG/EL chunk');
      const spec = parseKbChunk(chunk);
      if (!spec) throw new Error('chunk did not parse');
      if (spec.segId.toUpperCase() !== gap.segId.toUpperCase())
        throw new Error('chunk is for segment ' + spec.segId + ', expected ' + gap.segId);
      const stillMissing = gap.missing.filter((p) => !spec.elements[p]);
      if (stillMissing.length)
        throw new Error(
          'positions still missing: ' + stillMissing.map((p) => gap.segId + String(p).padStart(2, '0')).join(', ')
        );
      store.upsert({
        claimId: 'kb',
        type: 'kb',
        segId: gap.segId,
        segIndex: 0,
        text: chunk,
        meta: { name: spec.name, source: 'ai', filledAt: new Date().toISOString(), positions: gap.missing },
      });
      log('stored AI definition for ' + gap.segId + ' (positions ' + gap.missing.join(', ') + ')');
      filled.push({ segId: gap.segId, positions: gap.missing });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('failed for ' + gap.segId + ': ' + msg);
      failed.push({ segId: gap.segId, error: msg });
    }
  }
  if (filled.length) store.save();
  return { disabled: false, filled, failed };
}