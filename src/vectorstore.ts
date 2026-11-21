/**
 * A small file-backed vector database.
 *
 * Records:
 *   { id, claimId, type, segId, segIndex, text, meta, vector }
 *
 * `type` is one of:
 *   'kb'   – knowledge-base chunk (837 segment/element definitions)
 *   'seg'  – one segment of an ingested claim (text = raw segment)
 *   'meta' – claim metadata summary (text = JSON-able summary marker)
 *
 * Persistence is a single JSON file with sparse vectors, suitable for
 * demo scale. Swap in Qdrant/Chroma/pgvector for production scale.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { embedSparse, cosine, DIM, SparseVec } from './embedding';

export type RecordType = 'kb' | 'seg' | 'meta';

export interface VectorRecord {
  id: string;
  claimId: string;
  type: RecordType;
  segId: string;
  segIndex: number;
  text: string;
  meta: object;
  vector: SparseVec;
}

export interface AddOptions {
  id?: string;
  claimId: string;
  type: RecordType;
  segId: string;
  segIndex?: number;
  text: string;
  meta?: object;
}

export interface SearchOptions {
  limit?: number;
  claimId?: string;
  type?: RecordType;
  segId?: string;
}

export type ScoredRecord = VectorRecord & { score: number };

export class VectorStore {
  readonly file: string;
  readonly dim: number;
  records: VectorRecord[];
  private byKey: Map<string, VectorRecord>;

  constructor(file: string, dim: number = DIM) {
    this.file = file;
    this.dim = dim;
    this.records = [];
    this.byKey = new Map(); // `${claimId}:${type}:${segId}:${segIndex}` -> record
  }

  async load(): Promise<void> {
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { records?: VectorRecord[] };
      this.records = raw.records ?? [];
    }
    this._index();
  }

  private _index(): void {
    this.byKey = new Map();
    for (const r of this.records) this.byKey.set(this._keyOf(r), r);
  }

  private _keyOf(r: VectorRecord): string {
    return r.claimId + ':' + r.type + ':' + r.segId + ':' + r.segIndex;
  }

  /** Insert a record (idempotent on the logical key). */
  add(opts: AddOptions): VectorRecord {
    const record: VectorRecord = {
      id: opts.id ?? crypto.randomBytes(8).toString('hex'),
      claimId: opts.claimId,
      type: opts.type,
      segId: opts.segId,
      segIndex: opts.segIndex ?? -1,
      text: opts.text,
      meta: opts.meta ?? {},
      vector: embedSparse(opts.text, this.dim),
    };
    const k = this._keyOf(record);
    const existing = this.byKey.get(k);
    if (existing) return existing;
    this.byKey.set(k, record);
    this.records.push(record);
    return record;
  }

  /**
   * Insert or replace a record on the logical key
   * (`claimId:type:segId:segIndex`). Used by the AI KB fill (see
   * src/aidefinitions.ts) to refresh an existing definition instead of
   * adding a duplicate.
   */
  upsert(opts: AddOptions): VectorRecord {
    const key = opts.claimId + ':' + opts.type + ':' + opts.segId + ':' + (opts.segIndex ?? -1);
    const existing = this.byKey.get(key);
    if (existing) {
      existing.text = opts.text;
      existing.meta = opts.meta ?? {};
      existing.vector = embedSparse(opts.text, this.dim);
      return existing;
    }
    return this.add(opts);
  }

  /** Similarity search with optional filters, sorted by score desc. */
  search(queryText: string, opts: SearchOptions = {}): ScoredRecord[] {
    const q = embedSparse(queryText, this.dim);
    const hits: ScoredRecord[] = [];
    for (const r of this.records) {
      if (opts.claimId !== undefined && r.claimId !== opts.claimId) continue;
      if (opts.type !== undefined && r.type !== opts.type) continue;
      if (opts.segId !== undefined && r.segId !== opts.segId) continue;
      hits.push({ ...r, score: cosine(q, r.vector) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.limit ?? 5);
  }

  /** All records for a claim of a given type, ordered by segIndex. */
  byClaim(claimId: string, type?: RecordType): VectorRecord[] {
    return this.records
      .filter((r) => r.claimId === claimId && (type === undefined || r.type === type))
      .sort((a, b) => a.segIndex - b.segIndex || (a.id < b.id ? -1 : 1));
  }

  get(claimId: string, type: RecordType, segId: string, segIndex: number): VectorRecord | undefined {
    return this.byKey.get(claimId + ':' + type + ':' + segId + ':' + segIndex);
  }

  hasKb(): boolean {
    return this.records.some((r) => r.type === 'kb');
  }

  listMeta(): VectorRecord[] {
    return this.records.filter((r) => r.type === 'meta');
  }

  count(): number {
    return this.records.length;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ dim: this.dim, records: this.records }, null, 0));
    fs.renameSync(tmp, this.file);
  }
}
