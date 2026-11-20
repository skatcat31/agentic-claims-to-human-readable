/**
 * Deterministic, dependency-free sparse embeddings via the hashing trick.
 *
 * Text is tokenized into lowercase alphanumeric tokens; each token (plus
 * adjacent-token bigrams) is hashed into one of `dim` buckets with a
 * hashed sign, producing a sparse vector. Vectors are L2-normalized, so
 * cosine similarity reduces to a dot product over shared buckets.
 *
 * This is more than good enough for near-duplicate EDI segment retrieval
 * (segment IDs and structural tokens dominate the signal) without
 * shipping a neural embedding model or any npm dependency.
 */

export type SparseVec = Array<[number, number]>;

const DIM = 1024;

function fnv1a(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function tokens(text: string): string[] {
  return String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Embed text into a sparse, L2-normalized vector.
 *
 * @param text input text
 * @param dim number of hash buckets
 * @returns [bucket, weight] pairs
 */
export function embedSparse(text: string, dim: number = DIM): SparseVec {
  const toks = tokens(text);
  const buckets = new Map<number, number>();
  const add = (key: string, weight: number): void => {
    const b = fnv1a(key) % dim;
    const sign = fnv1a(key + '\u0001') & 1 ? 1 : -1;
    buckets.set(b, (buckets.get(b) ?? 0) + sign * weight);
  };
  for (const t of toks) add('t:' + t, 1.0);
  for (let i = 0; i + 1 < toks.length; i++) {
    add('g:' + toks[i] + '_' + toks[i + 1], 0.5);
  }
  let norm = 0;
  for (const v of buckets.values()) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return [];
  const out: SparseVec = [];
  for (const [b, v] of buckets) {
    if (Math.abs(v) > 1e-9) out.push([b, v / norm]);
  }
  return out;
}

/** Cosine similarity between two sparse normalized vectors. */
export function cosine(a: SparseVec, b: SparseVec): number {
  if (!a.length || !b.length) return 0;
  const small = a.length <= b.length ? a : b;
  const large = a.length <= b.length ? b : a;
  const map = new Map(large);
  let dot = 0;
  for (const [idx, val] of small) {
    const other = map.get(idx);
    if (other !== undefined) dot += val * other;
  }
  return dot;
}

export { DIM };
