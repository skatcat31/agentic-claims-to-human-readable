/**
 * End-to-end smoke test: parser, KB round-trip, RAG retrieval accuracy,
 * vector-DB persistence, RAG labeling, and the generated HTML.
 *
 * Run with: npm run build && node dist/test/smoke.js
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { VectorStore } from '../src/vectorstore';
import { parse837, ParsedSegment } from '../src/parse837';
import { kbChunks, parseKbChunk } from '../src/knowledge837';
import { retrieveSegmentSpec, labelClaim } from '../src/rag';
import { buildClaimSummary } from '../src/summary';
import { findKbGaps, ensureKbCoverage } from '../src/aidefinitions';
import { buildHtml } from '../src/generate';
import { ensureVendor } from '../src/vendor';
import { SAMPLES_DIR, VENDOR_DIR, OPENAPI_FILE } from '../src/paths';

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

  // 6. Raw-claim reconstruction (what GET /api/claims/:id/raw returns)
  const rawRebuilt = segs.map((r) => r.text).join('~') + '~';
  const reparsed = parse837(rawRebuilt);
  assert.strictEqual(reparsed.segmentCount, 33, 'reconstructed raw must re-parse to 33 segments');
  assert.deepStrictEqual(
    reparsed.segments.map((s) => s.id),
    segments.map((s) => s.id),
    'segment order must survive the raw round-trip'
  );
  console.log(
    'ok 6 - raw reconstruction (' +
      reparsed.segmentCount +
      ' segments, ' +
      rawRebuilt.length +
      ' chars)'
  );

  // 7. Claim summary (plain English, full + de-identified)
  const full = buildClaimSummary(segments, { deidentify: false });
  assert.ok(full.text.includes('JOHN DOE') && full.text.includes('JANE DOE'), 'full summary must name the patients');
  assert.ok(full.text.includes('$450.00') && full.text.includes('$300.00'), 'full summary must state the billed amounts');
  assert.ok(full.text.includes('99213') && full.text.includes('99214'), 'full summary must include the service codes');
  assert.strictEqual(full.standard, '005010X222', 'standard must come from ST03');
  assert.ok(full.text.includes('(standard 005010X222)'), 'standard must be surfaced in the text');
  assert.strictEqual(full.totalBilled, 750, 'total billed must be 450 + 300');
  assert.ok(!full.usedElements.some((e) => e.startsWith('N3') || e.startsWith('N4')), 'summary must never use addresses');
  const deid = buildClaimSummary(segments, { deidentify: true });
  assert.ok(!deid.text.includes('DOE') && !deid.text.includes('SMITH'), 'de-identified summary must not contain names');
  assert.ok(!deid.text.includes('2025-11-19') && !deid.text.includes('1234567890'), 'de-identified summary must not contain dates or claim numbers');
  assert.ok(deid.text.includes('$450.00') && deid.text.includes('99213'), 'de-identified summary must keep amounts and service codes');
  assert.ok(deid.redactions.length >= 3, 'de-identified summary must report its redactions');
  console.log('ok 7 - claim summary (plain English + de-identified variant)');

  // 8. OpenAPI spec (source file + build copy in dist/)
  const spec = JSON.parse(fs.readFileSync(OPENAPI_FILE, 'utf8'));
  assert.strictEqual(spec.openapi, '3.0.3', 'expected OpenAPI 3.0.3');
  for (const p of ['/', '/api/claims', '/api/claims/{claimId}', '/api/claims/{claimId}/raw', '/api/claims/{claimId}/summary', '/api/claims/{claimId}/export', '/files/{name}', '/api/search', '/healthz', '/openapi.json']) {
    assert.ok(spec.paths && spec.paths[p], 'spec is missing path ' + p);
  }
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'openapi.json')), 'build must copy openapi.json into dist/');
  console.log('ok 8 - OpenAPI spec (' + Object.keys(spec.paths).length + ' paths, dist copy present)');

  // 9. AI KB fill (gap detection + mock OpenAI-compatible endpoint)
  const TRN_CHUNK =
    'SEG TRN Transmission Information\n' +
    'EL 01 TRN01 Transmission Kind Code :: Kind of transmission (1 = normal, 2 = test).\n' +
    'EL 02 TRN02 Transmission Number :: Unique transmission control number.\n' +
    'EL 03 TRN03 Transmission Date :: Date of transmission (YYYYMMDD).\n' +
    'EL 04 TRN04 Transmission Time :: Time of transmission (HHMM).\n' +
    'EL 05 TRN05 Transmission Kind Qualifier :: 1 = normal, 2 = test, X = unspecified.';
  const aiCalls: string[] = [];
  const aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      aiCalls.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Here you go:\n```\n' + TRN_CHUNK + '\n```' } }] }));
    });
  });
  await new Promise<void>((resolve) => aiServer.listen(0, '127.0.0.1', () => resolve()));
  const aiPort = (aiServer.address() as { port: number }).port;
  const aiCfg = { endpoint: 'http://127.0.0.1:' + aiPort + '/v1/chat/completions', model: 'mock-model', timeoutMs: 5000 };
  const quiet = (): void => {};

  // a claim containing a segment the KB does not know (TRN)
  const trnText = raw.replace('ST*837*0001*005010X222~', 'ST*837*0001*005010X222~\nTRN*1*T123*20251119*1045*X~');
  const parsedTrn = parse837(trnText);
  assert.ok(parsedTrn.segments.some((s) => s.id === 'TRN'), 'claim must contain the unknown TRN segment');

  const fillStoreFile = path.join(os.tmpdir(), 'smoke-kb-fill-' + Date.now() + '.json');
  const fillStore = new VectorStore(fillStoreFile);
  await fillStore.load();
  for (const c of kbChunks())
    fillStore.add({ claimId: 'kb', type: 'kb', segId: c.segId, segIndex: 0, text: c.text, meta: { name: c.name } });

  const gaps = findKbGaps(fillStore, parsedTrn.segments);
  assert.strictEqual(gaps.length, 1, 'exactly one KB gap expected (TRN), got ' + JSON.stringify(gaps.map((g) => g.segId)));
  assert.strictEqual(gaps[0].segId, 'TRN');
  assert.deepStrictEqual(gaps[0].missing, [1, 2, 3, 4, 5]);

  const r1 = await ensureKbCoverage(fillStore, parsedTrn.segments, aiCfg, quiet);
  assert.strictEqual(r1.disabled, false);
  assert.strictEqual(r1.filled.length, 1, 'TRN must be filled from the AI endpoint');
  assert.strictEqual(r1.failed.length, 0);
  assert.strictEqual(aiCalls.length, 1, 'exactly one AI call');
  const promptBody = (JSON.parse(aiCalls[0]) as { messages: { content: string }[] }).messages[0].content;
  assert.ok(promptBody.includes('TRN') && promptBody.includes('TRN05'), 'prompt asks for the TRN positions');
  assert.ok(promptBody.includes('005010X222'), 'prompt carries the standard version (ST03)');
  assert.ok(!/DOE|JOHN|1234567890|450\.00/.test(promptBody), 'prompt must not contain claim values (no PHI)');

  const trnSpec = retrieveSegmentSpec(fillStore, 'TRN');
  assert.ok(trnSpec && trnSpec.spec.segId === 'TRN', 'TRN spec now retrievable from the KB');
  assert.ok(trnSpec!.spec.elements[5], 'TRN05 defined');

  labelClaim(fillStore, parsedTrn);
  const trnSeg = parsedTrn.segments.find((s) => s.id === 'TRN')!;
  assert.ok((trnSeg.elements[0].name ?? '').startsWith('TRN01'), 'TRN01 labeled from the AI definition: ' + trnSeg.elements[0].name);
  assert.ok(!/Element 1$/.test(trnSeg.elements[0].name ?? ''), 'no fallback label left on TRN01');

  // persisted round-trip
  fillStore.save();
  const refillStore = new VectorStore(fillStoreFile);
  await refillStore.load();
  assert.ok(retrieveSegmentSpec(refillStore, 'TRN'), 'AI-filled KB chunk survives a reload');

  // idempotent: second run finds no gaps, no extra AI call
  const r2 = await ensureKbCoverage(fillStore, parsedTrn.segments, aiCfg, quiet);
  assert.strictEqual(r2.filled.length, 0, 'no re-fetch when the KB already has the definition');
  assert.strictEqual(aiCalls.length, 1, 'still exactly one AI call');

  // disabled (no endpoint): reports the gap, changes nothing, does not throw
  const gapStore2File = path.join(os.tmpdir(), 'smoke-kb-fill2-' + Date.now() + '.json');
  const gapStore2 = new VectorStore(gapStore2File);
  await gapStore2.load();
  for (const c of kbChunks())
    gapStore2.add({ claimId: 'kb', type: 'kb', segId: c.segId, segIndex: 0, text: c.text, meta: { name: c.name } });
  const r3 = await ensureKbCoverage(gapStore2, parsedTrn.segments, null, quiet);
  assert.strictEqual(r3.disabled, true);
  assert.strictEqual(r3.filled.length, 0);
  assert.ok(!retrieveSegmentSpec(gapStore2, 'TRN'), 'disabled fill must not add KB records');

  // failing endpoint: graceful failure, KB untouched
  const r4 = await ensureKbCoverage(gapStore2, parsedTrn.segments, { endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'x', timeoutMs: 1500 }, quiet);
  assert.strictEqual(r4.disabled, false);
  assert.strictEqual(r4.failed.length, 1, 'failure must be reported');
  assert.strictEqual(r4.failed[0].segId, 'TRN');
  assert.ok(!retrieveSegmentSpec(gapStore2, 'TRN'), 'failed fill must not add KB records');

  // upsert replaces in place (the merge path for a known segment missing positions)
  const before = fillStore.count();
  fillStore.upsert({
    claimId: 'kb',
    type: 'kb',
    segId: 'TRN',
    segIndex: 0,
    text: TRN_CHUNK + '\nEL 06 TRN06 Extra :: Later addition.',
    meta: { name: 'Transmission Information', source: 'ai' },
  });
  assert.strictEqual(fillStore.count(), before, 'upsert replaces, does not add');
  assert.ok(fillStore.get('kb', 'kb', 'TRN', 0)!.text.includes('TRN06'), 'upserted text is in place');

  aiServer.close();
  fs.rmSync(fillStoreFile, { force: true });
  fs.rmSync(gapStore2File, { force: true });
  console.log('ok 9 - AI KB fill (gap detect, mock AI, validate, upsert, idempotent, fail-soft)');

  console.log('\nAll smoke tests passed.');
}

main().catch((err: unknown) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
