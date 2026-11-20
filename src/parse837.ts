/**
 * EDI 837 (X12) parser.
 *
 * Handles the standard X12 4010/5010 interchange layout:
 *   - segments are terminated by `~`
 *   - elements (including inside the ISA segment) are separated by `*`
 *   - the ISA segment carries the end-of-interchange `:~` marker
 *
 * A legacy fallback is included for files that use `|` element
 * separators (one segment per line, or `*`-separated fragments).
 *
 * Each parsed element gets a stable key (`<segIndex>-<elemIndex>`) so the
 * static UI can map a field back to its exact position in the claim.
 */

export interface ParsedElement {
  index: number;
  key: string;
  /** Exact value as received (padding preserved). */
  value: string;
  /** Value shown in form fields (trimmed). */
  display: string;
  /** Human-readable label, added by the RAG labeling step. */
  name?: string;
  /** Description, added by the RAG labeling step. */
  description?: string;
}

export interface ParsedSegment {
  index: number;
  id: string;
  /** Raw segment text (segment ID + elements joined by `*`). */
  raw: string;
  /** Number of elements actually present in the raw text. */
  rawElementCount: number;
  /** Segment name, added by the RAG labeling step. */
  name?: string;
  elements: ParsedElement[];
}

export interface ParsedClaim {
  segments: ParsedSegment[];
  segmentCount: number;
  raw: string;
}

// Known element counts per segment ID (005010X222 / 004010X222).
export const SEGMENT_LENGTHS: Readonly<Record<string, number>> = {
  ISA: 15, GS: 7, ST: 3, SE: 2, BHT: 5, HOID: 3, DTM: 3,
  N1: 11, N3: 5, N4: 4, HL: 2,
  CLM: 9, SV1: 2, L: 2, ALX: 7, NT: 3,
  SBR: 11, BAI: 9,
  FFS: 6, CAS: 4, CUR: 2, REF: 3, PER: 6, N7: 7, N8: 14, N9: 3,
  RDM: 3, CQ1: 2, EQT: 2, LQ1: 2, LQ2: 2,
  AK1: 5, AK3: 5, AK4: 4, CR1: 2, CR2: 4, RFA: 2,
  GE: 2, IEA: 2,
};

function normalize(raw: string): string {
  return String(raw).replace(/\r\n?/g, '\n').trim();
}

/**
 * Register one parsed segment (id + element values) on the list,
 * padding the element list to the known spec length when known.
 */
function addSegment(
  segments: ParsedSegment[],
  idRaw: string,
  values: string[],
  rawText: string
): void {
  const id = idRaw.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(id)) return; // ignore malformed fragments

  const knownLen = SEGMENT_LENGTHS[id] ?? 0;
  const count = Math.max(values.length, knownLen);
  const padded: string[] = [];
  for (let i = 0; i < count; i++) padded.push(i < values.length ? values[i] : '');

  const idx = segments.length;
  segments.push({
    index: idx,
    id,
    raw: rawText,
    rawElementCount: values.length,
    elements: padded.map((value, i) => ({
      index: i,
      key: idx + '-' + i,
      value,
      display: value.trim(),
    })),
  });
}

/**
 * Parse a raw 837 claim (X12 interchange).
 *
 * @param rawText raw 837 text, in either the `~`-terminated (4010/5010)
 *        layout or the legacy `|`-element layout
 */
export function parse837(rawText: string): ParsedClaim {
  const raw = normalize(rawText);
  if (!raw) throw new Error('Empty claim');

  const segments: ParsedSegment[] = [];

  if (raw.includes('~')) {
    // Standard X12 4010/5010 layout: `~` terminates each segment and
    // `*` separates elements (including inside the ISA segment).
    const pieces = raw.split('~');
    for (const piece of pieces) {
      let text = piece.replace(/\n/g, ' ').trim();
      if (!text) continue;
      // Tolerate files that prefix each segment with a `*` marker.
      if (text.startsWith('*')) text = text.slice(1).trim();
      if (!text) continue;
      // Drop the end-of-interchange control marker: `*:` / `*>` (from `:~` /
      // `>~`) or a bare `:` / `>` stuck to the last element.
      if (text.endsWith('*:') || text.endsWith('*>')) text = text.slice(0, -2).trim();
      else if (text.endsWith(':') || text.endsWith('>')) text = text.slice(0, -1).trim();
      const values = text.split('*').map((v) => v.trim());
      const id = values[0].toUpperCase();
      // A trailing dangling `*` (segment written as `...elem*~`) leaves an
      // empty final token.
      if (values.length > 1 && values[values.length - 1] === '') values.pop();
      addSegment(segments, id, values.slice(1), text);
    }
  } else {
    // Legacy layout: one segment per line; elements separated by `|`
    // (fall back to `*` element separation when a line has no pipes).
    for (const line of raw.split('\n')) {
      let text = line.trim();
      if (!text) continue;
      if (text.startsWith('*')) text = text.slice(1).trim();
      if (!text) continue;
      const separator = text.includes('|') ? '|' : '*';
      const values = text.split(separator).map((v) => v.trim());
      addSegment(segments, values[0], values.slice(1), text);
    }
  }

  if (!segments.length) throw new Error('No valid segments found in claim');
  return { segments, segmentCount: segments.length, raw };
}
