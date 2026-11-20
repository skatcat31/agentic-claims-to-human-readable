/**
 * End-to-end smoke test: parser, KB round-trip, RAG retrieval accuracy,
 * vector-DB persistence, RAG labeling, and the generated HTML.
 *
 * Run with: npm run build && node dist/test/smoke.js
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VectorStore } from '../src/vectorstore';
import { parse837, ParsedSegment } from '../src/parse837';
import { kbChunks, parseKbChunk } from '../src/knowledge837';
import { retrieveSegmentSpec, labelClaim } from '../src/rag';
import { buildHtml } from '../src/generate';
import { ensureVendor } from '../src/vendor';
import { SAMPLES_DIR, VENDOR_DIR } from '../src/paths';

interface PayloadElement {
  key: string;
  value: string;
  display: string;
  name: string;
  description: string;
}

interface PayloadSegment {
  index: number;
  id: string;
  name: string | null;
  elements: PayloadElement[];
}

interface Payload {
  claimId: string;
  generatedAt: string;
  segmentCount: number;
  elementCount: number;
  rag: { labeledElements: number; totalElements: number; kbHits: number };
  segments: PayloadSegment[];
}

async function main(): Promise<void> {
  const raw = fs.readFileSync(path.join(SAMPLES_DIR, 'sample-837.txt'), 'utf8');

  // 1. Parser
  const parsed = parse837(raw);
  assert.strictEqual(parsed.segmentCount, 33, 'expected 33 segments, got ' + parsed.segmentCount);
  assert.strictEqual(parsed.segments[0].id, 'ISA');
  assert.strictEqual(parsed.segments[0].elements.length, 15, 'ISA should have 15 elements');
  assert.strictEqual(parsed.segments[3].id, 'BHT');
  assert.strictEqual(parsed.segments[3].elements[1].display, '1', 'BHT02 = claim type 1');
  console.log('ok 1 - parser (' + parsed.segmentCount + ' segments, ISA padded to 15 elements)');

  // 2. KB round-trip
  const chunks = kbChunks();
  assert.ok(chunks.length >= 30, 'expected a substantial KB, got ' + chunks.length);
  for (const c of chunks) {
    const spec = parseKbChunk(c.text);
    assert.ok(spec && spec.segId === c.segId, 'KB round-trip failed for ' + c.segId);
    assert.strictEqual(Object.keys(spec!.elements).length, c.text.split('\n').length - 1);
  }
  console.log('ok 2 - KB round-trip (' + chunks.length + ' chunk specs)');

  // 3. RAG retrieval accuracy
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '837-'));
  const store = new VectorStore(path.join(tmp, 'vectorstore.json'));
  for (const c of chunks) {
    store.add({ claimId: 'kb', type: 'kb', segId: c.segId, segIndex: 0, text: c.text });
  }
  let ok = 0;
  for (const c of chunks) {
    const hit = retrieveSegmentSpec(store, c.segId);
    if (hit && hit.spec.segId === c.segId) ok++;
  }
  assert.ok(ok >= chunks.length - 2, 'RAG retrieval accuracy too low: ' + ok + '/' + chunks.length);
  console.log('ok 3 - RAG retrieval ' + ok + '/' + chunks.length + ' segment specs retrieved');

  // 4. Ingest + persistence + reload + RAG labeling
  parsed.segments.forEach((seg) => {
    store.add({ claimId: 'TEST', type: 'seg', segId: seg.id, segIndex: seg.index, text: seg.raw });
  });
  store.save();

  const reloaded = new VectorStore(path.join(tmp, 'vectorstore.json'));
  await reloaded.load();
  const segs = reloaded.byClaim('TEST', 'seg');
  assert.strictEqual(segs.length, 33, 'claim segments should survive a round-trip');

  const segments: ParsedSegment[] = segs.map((r) => {
    const values = r.text.split('*').map((v) => v.trim()).slice(1); // drop the segment ID token
    return {
      index: r.segIndex,
      id: r.segId,
      raw: r.text,
      rawElementCount: values.length,
      elements: values.map((value, i) => ({
        index: i,
        key: r.segIndex + '-' + i,
        value,
        display: value,
      })),
    };
  });
  const stats = labelClaim(reloaded, { segments, segmentCount: segments.length, raw: '' });
  assert.ok(stats.labeledElements > 100, 'expected most elements labeled, got ' + stats.labeledElements);
  const bht = segments.find((s) => s.id === 'BHT');
  assert.ok(bht && bht.elements[1].name === 'BHT02 Claim Type Code', 'BHT02 should be labeled via RAG');
  console.log('ok 4 - ingest + persistence + label (' + stats.labeledElements + '/' + stats.totalElements + ' labeled)');

  // 5. Static HTML generation
  await ensureVendor(VENDOR_DIR);
  const html = buildHtml({ claimId: 'TEST', generatedAt: new Date().toISOString(), segments, stats });
  assert.ok(html.includes('window.__CLAIM__ = {'), 'claim payload must be inlined');
  assert.ok(html.includes('max-width: 1200px'), 'page must be capped at 1200px');
  assert.ok(html.includes('el-hl') && html.includes('data-key'), 'hover highlight wiring must be present');
  assert.ok(html.includes('BHT02 Claim Type Code'), 'RAG labels must be in the payload');
  assert.ok(html.includes('createRoot'), 'React bundle must be baked in');
  // Exactly three closing script tags: react, react-dom, and the app payload.
  // (Opening `<script>` strings inside a bundle are legal and don't end the inline script.)
  assert.strictEqual(html.split('</script>').length - 1, 3, 'expected exactly 3 inline scripts');

  const m = html.match(/^window\.__CLAIM__ = (.+);$/m);
  assert.ok(m, 'payload line not found');
  const payload = JSON.parse(m![1]) as Payload;
  assert.strictEqual(payload.segmentCount, 33);
  const keys = new Set<string>();
  for (const s of payload.segments) {
    for (const e of s.elements) {
      assert.ok(!keys.has(e.key), 'duplicate element key ' + e.key);
      keys.add(e.key);
    }
  }
  console.log(
    'ok 5 - static HTML (' +
      Math.round(html.length / 1024) +
      ' KB self-contained, ' +
      payload.elementCount +
      ' fields, all keys unique)'
  );

  console.log('\nAll smoke tests passed.');
}

main().catch((err: unknown) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
