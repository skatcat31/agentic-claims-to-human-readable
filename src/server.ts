/**
 * RAG server for EDI 837 claims.
 *
 *  - Ingests claims (parse -> embed -> store in the vector DB)
 *  - Retrieves claim content + 837 KB definitions from the vector DB
 *  - Generates (augmented) self-contained static HTML with React baked in
 *
 * API:
 *   GET  /                     index page (list of claims + ingest form)
 *   POST /api/claims           ingest a claim (raw text or JSON {claim})
 *   GET  /api/claims           list ingested claims
 *   GET  /api/claims/:id       claim metadata
 *   POST|GET /api/claims/:id/export   generate the static HTML (JSON reply)
 *   GET  /files/:name          serve an exported HTML file (lazy-generated)
 *   GET  /api/search?q=&scope=&k=    similarity search (RAG demo)
 *   GET  /healthz              health check
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { VectorStore } from './vectorstore';
import { parse837 } from './parse837';
import { kbChunks } from './knowledge837';
import { labelClaim, LabelStats } from './rag';
import { buildHtml } from './generate';
import { ensureVendor } from './vendor';
import { DATA_FILE, OUTPUT_DIR, VENDOR_DIR } from './paths';

const PORT = parseInt(process.env.PORT ?? '8370', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

/** Metadata stored for every ingested claim. */
export interface ClaimMeta {
  claimId: string;
  createdAt: string;
  segmentCount: number;
  elementCount: number;
  bytes: number;
  fileName: string;
}

/** Result of generating the static HTML for a claim. */
export interface ExportResult {
  claimId: string;
  fileName: string;
  filePath: string;
  stats: LabelStats;
}

interface IngestResult {
  claimId: string;
  meta: ClaimMeta;
}

export interface ClaimListItem {
  claimId: string;
  segmentCount: number;
  elementCount: number;
  createdAt: string;
  fileName: string;
}

export interface SearchHit {
  score: number;
  claimId: string;
  type: string;
  segId: string;
  segIndex: number;
  text: string;
}

const store = new VectorStore(DATA_FILE);

function newClaimId(): string {
  return '837-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
}

function seedKnowledgeBase(): number {
  if (store.hasKb()) return 0;
  let n = 0;
  for (const chunk of kbChunks()) {
    store.add({
      claimId: 'kb',
      type: 'kb',
      segId: chunk.segId,
      segIndex: 0,
      text: chunk.text,
      meta: { name: chunk.name },
    });
    n++;
  }
  return n;
}

/** Ingest a raw 837 claim into the vector DB. */
function ingestClaim(rawText: string): IngestResult {
  const parsed = parse837(rawText);
  const claimId = newClaimId();

  for (const seg of parsed.segments) {
    store.add({
      claimId,
      type: 'seg',
      segId: seg.id,
      segIndex: seg.index,
      text: seg.raw,
      meta: { rawElementCount: seg.rawElementCount },
    });
  }

  const meta: ClaimMeta = {
    claimId,
    createdAt: new Date().toISOString(),
    segmentCount: parsed.segmentCount,
    elementCount: parsed.segments.reduce((n, s) => n + s.rawElementCount, 0),
    bytes: Buffer.byteLength(rawText, 'utf8'),
    fileName: 'claim-' + claimId + '.html',
  };
  store.add({
    claimId,
    type: 'meta',
    segId: 'META',
    segIndex: 0,
    text: 'claim metadata ' + claimId,
    meta,
  });
  store.save();
  return { claimId, meta };
}

/**
 * RAG export: retrieve the claim's segments from the vector DB, retrieve
 * KB definitions for every segment, then generate the static HTML file.
 */
function exportClaim(claimId: string): ExportResult | null {
  const segs = store.byClaim(claimId, 'seg');
  if (!segs.length) return null;

  const segments = segs.map((r) => {
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

  const stats = labelClaim(store, { segments, segmentCount: segments.length, raw: '' });

  const html = buildHtml({
    claimId,
    generatedAt: new Date().toISOString(),
    segments,
    stats,
  });

  const metaRec = store.get(claimId, 'meta', 'META', 0);
  const fileName = (metaRec && (metaRec.meta as ClaimMeta).fileName) || 'claim-' + claimId + '.html';
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, fileName);
  fs.writeFileSync(filePath, html, 'utf8');
  return { claimId, fileName, filePath, stats };
}

function getMeta(claimId: string): ClaimMeta | null {
  const rec = store.get(claimId, 'meta', 'META', 0);
  return rec ? (rec.meta as ClaimMeta) : null;
}

// ---------------------------------------------------------------- http ---

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendHtml(res: http.ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function readBody(req: http.IncomingMessage, limit = 20 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function indexHtml(claims: ClaimListItem[]): string {
  const rows = claims
    .map(
      (c) =>
        '<tr>' +
        '<td class="mono">' + c.claimId + '</td>' +
        '<td>' + c.segmentCount + '</td>' +
        '<td>' + c.elementCount + '</td>' +
        '<td>' + c.createdAt + '</td>' +
        '<td>' +
        '<a href="/files/' + c.fileName + '">open HTML</a> &middot; ' +
        '<a href="#" data-export="' + c.claimId + '">re-export</a>' +
        '</td></tr>'
    )
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>EDI 837 RAG Server</title>',
    '<style>',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f2f4f8;color:#1d2433;margin:0}',
    '.wrap{max-width:1200px;margin:0 auto;padding:32px 16px}',
    'h1{font-size:22px;margin:0 0 4px}',
    'p.sub{color:#5c6780;margin:0 0 24px;font-size:14px}',
    'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d9e0ea}',
    'th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #e6ebf3;font-size:13.5px}',
    'th{background:#f8fafc;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#66718a}',
    '.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}',
    'a{color:#2563eb;text-decoration:none}',
    'label{display:block;font-size:13px;font-weight:600;margin:24px 0 6px;color:#313b4d}',
    'textarea{width:100%;height:140px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;border:1px solid #d9e0ea;border-radius:8px;padding:10px;box-sizing:border-box}',
    'button{margin-top:10px;background:#2563eb;color:#fff;border:0;border-radius:8px;padding:9px 18px;font-size:14px;cursor:pointer}',
    '#ingest-out{margin-top:10px;font-size:13px;color:#313b4d}',
    '</style></head><body>',
    '<div class="wrap">',
    '<h1>EDI 837 RAG Server</h1>',
    '<p class="sub">Ingest EDI 837 claims into the vector database and export self-contained HTML claim views.</p>',
    '<table><thead><tr><th>Claim ID</th><th>Segments</th><th>Fields</th><th>Created</th><th></th></tr></thead>',
    '<tbody>' + (rows || '<tr><td colspan="5">No claims ingested yet.</td></tr>') + '</tbody></table>',
    '<label for="claim">Paste an EDI 837 claim</label>',
    '<textarea id="claim" placeholder="*ISA*..."></textarea>',
    '<button id="ingest-btn">Ingest claim</button>',
    '<div id="ingest-out"></div>',
    '<script>',
    'document.getElementById("ingest-btn").addEventListener("click", async function () {',
    '  var text = document.getElementById("claim").value;',
    '  var out = document.getElementById("ingest-out");',
    '  if (!text.trim()) { out.textContent = "Paste a claim first."; return; }',
    '  out.textContent = "Ingesting\\u2026";',
    '  var r = await fetch("/api/claims", { method: "POST", headers: { "Content-Type": "text/plain" }, body: text });',
    '  var j = await r.json();',
    '  out.textContent = r.ok ? "Ingested " + j.claimId + " (" + j.meta.segmentCount + " segments). Reloading\\u2026" : "Error: " + j.error;',
    '  if (r.ok) setTimeout(function () { location.reload(); }, 900);',
    '});',
    'document.querySelectorAll("[data-export]").forEach(function (a) {',
    '  a.addEventListener("click", async function (e) {',
    '    e.preventDefault();',
    '    await fetch("/api/claims/" + a.getAttribute("data-export") + "/export", { method: "POST" });',
    '    location.href = "/files/" + encodeURIComponent("claim-" + a.getAttribute("data-export") + ".html");',
    '  });',
    '});',
    '</script>',
    '</div></body></html>',
  ].join('\n');
}
async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const t0 = Date.now();
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const m = req.method;

    if (m === 'GET' && p === '/healthz') {
      sendJson(res, 200, { ok: true, records: store.count() });
      return;
    }

    if (m === 'GET' && p === '/') {
      const claims: ClaimListItem[] = store.listMeta().map((r) => {
        const meta = r.meta as ClaimMeta;
        return {
          claimId: meta.claimId,
          segmentCount: meta.segmentCount,
          elementCount: meta.elementCount,
          createdAt: meta.createdAt,
          fileName: meta.fileName,
        };
      });
      sendHtml(res, 200, indexHtml(claims));
      return;
    }

    if (m === 'POST' && p === '/api/claims') {
      const body = await readBody(req);
      const ct = (req.headers['content-type'] ?? '').toString().toLowerCase();
      let claimText: string | undefined;
      if (ct.includes('application/json')) {
        let j: { claim?: unknown; raw?: unknown; text?: unknown };
        try {
          j = JSON.parse(body) as { claim?: unknown; raw?: unknown; text?: unknown };
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        claimText = (j.claim ?? j.raw ?? j.text) as string | undefined;
        if (typeof claimText !== 'string' || !claimText.trim()) {
          sendJson(res, 400, { error: 'JSON body must include a "claim" string' });
          return;
        }
      } else {
        claimText = body;
      }
      let result: IngestResult;
      try {
        result = ingestClaim(claimText);
      } catch (err) {
        sendJson(res, 400, { error: 'Parse failed: ' + (err instanceof Error ? err.message : String(err)) });
        return;
      }
      sendJson(res, 201, { ...result, url: '/api/claims/' + result.claimId });
      return;
    }

    if (m === 'GET' && p === '/api/claims') {
      const claims: ClaimListItem[] = store.listMeta().map((r) => {
        const meta = r.meta as ClaimMeta;
        return {
          claimId: meta.claimId,
          segmentCount: meta.segmentCount,
          elementCount: meta.elementCount,
          createdAt: meta.createdAt,
          fileName: meta.fileName,
        };
      });
      sendJson(res, 200, { claims });
      return;
    }

    const exportMatch = p.match(/^\/api\/claims\/([A-Za-z0-9-]+)\/export$/);
    if (exportMatch && (m === 'POST' || m === 'GET')) {
      const result = exportClaim(exportMatch[1]);
      if (!result) {
        sendJson(res, 404, { error: 'Claim not found: ' + exportMatch[1] });
        return;
      }
      sendJson(res, 200, {
        claimId: result.claimId,
        fileName: result.fileName,
        filePath: result.filePath,
        url: '/files/' + result.fileName,
        rag: result.stats,
      });
      return;
    }

    const claimMatch = p.match(/^\/api\/claims\/([A-Za-z0-9-]+)$/);
    if (claimMatch && m === 'GET') {
      const meta = getMeta(claimMatch[1]);
      if (!meta) {
        sendJson(res, 404, { error: 'Claim not found: ' + claimMatch[1] });
        return;
      }
      sendJson(res, 200, meta);
      return;
    }
    const fileMatch = p.match(/^\/files\/([\w.-]+)$/);
    if (fileMatch && m === 'GET') {
      const name = path.basename(fileMatch[1]);
      if (!/\.html$/.test(name)) {
        sendJson(res, 400, { error: 'Only .html files can be served' });
        return;
      }
      const filePath = path.join(OUTPUT_DIR, name);
      if (!fs.existsSync(filePath)) {
        // lazy generation: serve freshly on first request
        const claimId = name.replace(/^claim-/, '').replace(/\.html$/, '');
        const exported = exportClaim(claimId);
        if (!exported || exported.fileName !== name) {
          sendJson(res, 404, { error: 'File not found: ' + name });
          return;
        }
      }
      const body = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }

    if (m === 'GET' && p === '/api/search') {
      const q = url.searchParams.get('q') ?? '';
      const scope = url.searchParams.get('scope') ?? 'kb';
      const k = Math.min(parseInt(url.searchParams.get('k') ?? '5', 10), 25);
      if (!q.trim()) {
        sendJson(res, 400, { error: 'Missing ?q=' });
        return;
      }
      const scopeType: 'kb' | 'seg' | 'meta' | undefined =
        scope === 'all' ? undefined : scope === 'kb' || scope === 'seg' || scope === 'meta' ? scope : 'kb';
      const hits = store.search(q, { limit: k, type: scopeType });
      const out: SearchHit[] = hits.map((h) => ({
        score: Number(h.score.toFixed(4)),
        claimId: h.claimId,
        type: h.type,
        segId: h.segId,
        segIndex: h.segIndex,
        text: h.text.length > 400 ? h.text.slice(0, 400) + '\u2026' : h.text,
      }));
      sendJson(res, 200, { query: q, scope: scope === 'all' ? 'all' : scope, hits: out });
      return;
    }

    sendJson(res, 404, { error: 'Not found: ' + m + ' ' + p });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    console.log(req.method, req.url, '->', res.statusCode, Date.now() - t0 + 'ms');
  }
}

export async function boot(): Promise<void> {
  await ensureVendor(VENDOR_DIR);
  await store.load();
  const seeded = seedKnowledgeBase();
  if (seeded) store.save();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  server.listen(PORT, HOST, () => {
    console.log('EDI 837 RAG server listening on http://localhost:' + PORT);
    console.log(
      '  vector DB: ' +
        DATA_FILE +
        ' (' +
        store.count() +
        ' records' +
        (seeded ? ', seeded ' + seeded + ' KB chunks' : '') +
        ')'
    );
    console.log('  exports:   ' + OUTPUT_DIR);
  });
}

