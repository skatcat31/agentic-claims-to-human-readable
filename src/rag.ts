/**
 * The RAG (retrieval-augmented) layer.
 *
 * RETRIEVAL:
 *   1. Claim content is retrieved from the vector database by claimId
 *      (each ingested segment is a vector record).
 *   2. For every distinct segment ID in the claim, the segment-definition
 *      KB chunk is retrieved via a similarity search against the vector
 *      DB knowledge base.
 *
 * AUGMENTATION:
 *   Retrieved definitions augment the raw elements with human-readable
 *   field names + descriptions, which the generator then bakes into the
 *   static HTML.
 */

import { VectorStore } from './vectorstore';
import { parseKbChunk, ParsedSpec } from './knowledge837';
import { ParsedClaim } from './parse837';

const pad2 = (n: number): string => String(n).padStart(2, '0');

export interface LabelStats {
  labeledElements: number;
  totalElements: number;
  kbHits: number;
}

export interface SpecHit {
  spec: ParsedSpec;
  score: number;
}

/**
 * Retrieve the field-definition spec for one segment ID from the vector
 * DB knowledge base (top-k similarity search, then match on segment ID).
 *
 * The query mirrors the KB chunk structure — the `SEG <id>` header plus
 * the expected element codes (`<id>01`, `<id>02`, ...) — so the correct
 * chunk shares a strong, distinctive signal while other chunks share
 * little beyond the generic `seg` token.
 */
export function retrieveSegmentSpec(store: VectorStore, segId: string): SpecHit | null {
  const codes: string[] = [];
  for (let i = 1; i <= 12; i++) codes.push(segId + String(i).padStart(2, '0'));
  const query = 'SEG ' + segId + ' ' + segId + ' ' + codes.join(' ');
  const hits = store.search(query, { limit: 5, type: 'kb' });
  for (const hit of hits) {
    const spec = parseKbChunk(hit.text);
    if (spec && spec.segId === segId) return { spec, score: hit.score };
  }
  const fallback = hits.length ? parseKbChunk(hits[0].text) : null;
  return fallback ? { spec: fallback, score: hits[0].score } : null;
}

/**
 * Label every element of a parsed claim using RAG-retrieved definitions.
 * Mutates `parsed.segments` (adds `name`/`description` to elements and
 * `name` to segments) and returns retrieval stats.
 */
export function labelClaim(store: VectorStore, parsed: ParsedClaim): LabelStats {
  const specs = new Map<string, SpecHit | null>();
  for (const seg of parsed.segments) {
    if (!specs.has(seg.id)) specs.set(seg.id, retrieveSegmentSpec(store, seg.id));
  }

  let labeled = 0;
  for (const seg of parsed.segments) {
    const hit = specs.get(seg.id) ?? null;
    if (hit) seg.name = hit.spec.name;
    for (const el of seg.elements) {
      const spec = hit ? hit.spec.elements[el.index + 1] : undefined;
      if (spec) {
        el.name = spec.code + ' ' + spec.name;
        el.description = spec.desc;
        labeled++;
      } else {
        el.name = seg.id + pad2(el.index + 1) + ' Element ' + (el.index + 1);
        el.description = 'No definition retrieved from the knowledge base.';
      }
    }
  }

  return {
    labeledElements: labeled,
    totalElements: parsed.segments.reduce((n, s) => n + s.elements.length, 0),
    kbHits: [...specs.values()].filter((v) => v !== null).length,
  };
}
