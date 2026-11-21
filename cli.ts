/**
 * Small CLI for the RAG server (server must be running).
 *
 *   node dist/cli.js list
 *   node dist/cli.js ingest <file|->
 *   node dist/cli.js export <claimId>
 *   node dist/cli.js raw <claimId>
 *   node dist/cli.js summary <claimId> [deidentified]
 */

import * as fs from 'fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8370';

interface ClaimMetaShape {
  claimId: string;
  segmentCount: number;
  elementCount: number;
  createdAt: string;
  fileName: string;
}

function usage(): void {
  console.log('Usage:');
  console.log('  node dist/cli.js list                 list ingested claims');
  console.log('  node dist/cli.js ingest <file|->      ingest an 837 file (or - for stdin)');
  console.log('  node dist/cli.js export <claimId>     export a claim to static HTML');
  console.log('  node dist/cli.js raw <claimId>        print the raw 837 text (reconstructed)');
  console.log('  node dist/cli.js summary <claimId>    print a plain-English claim summary');
  console.log('  node dist/cli.js summary <claimId> deidentified   same, with PHI redacted');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd) {
    usage();
    return;
  }

  if (cmd === 'list') {
    const r = await fetch(BASE + '/api/claims');
    const j = (await r.json()) as { error?: string; claims?: ClaimMetaShape[] };
    if (!r.ok) {
      console.error('Error:', j.error ?? 'unknown');
      process.exitCode = 1;
      return;
    }
    for (const c of j.claims ?? []) {
      console.log(c.claimId + ' - ' + c.segmentCount + ' segments, ' + c.elementCount + ' fields, ' + c.createdAt);
      console.log('   view: ' + BASE + '/files/' + c.fileName);
    }
    return;
  }

  if (cmd === 'ingest') {
    if (!arg) {
      usage();
      return;
    }
    const text = arg === '-' ? await readStdin() : fs.readFileSync(arg, 'utf8');
    const r = await fetch(BASE + '/api/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    });
    const j = (await r.json()) as {
      error?: string;
      claimId?: string;
      meta?: { segmentCount: number };
      kb?: { filled?: { segId: string; positions: number[] }[]; failed?: { segId: string; error: string }[] };
    };
    if (!r.ok || !j.claimId) {
      console.error('Error:', j.error ?? 'unknown');
      process.exitCode = 1;
      return;
    }
    console.log('Ingested ' + j.claimId + ' (' + (j.meta?.segmentCount ?? '?') + ' segments)');
    for (const f of j.kb?.filled ?? [])
      console.log('KB fill: ' + f.segId + ' (positions ' + f.positions.join(', ') + ') fetched from the AI endpoint');
    for (const f of j.kb?.failed ?? []) console.error('KB fill: ' + f.segId + ' failed: ' + f.error);
    console.log('Export:  node dist/cli.js export ' + j.claimId);
    return;
  }

  if (cmd === 'export') {
    if (!arg) {
      usage();
      return;
    }
    const r = await fetch(BASE + '/api/claims/' + arg + '/export', { method: 'POST' });
    const j = (await r.json()) as { error?: string; fileName?: string; filePath?: string; url?: string };
    if (!r.ok) {
      console.error('Error:', j.error ?? 'unknown');
      process.exitCode = 1;
      return;
    }
    console.log('Exported ' + j.fileName + ' -> ' + j.filePath);
    console.log('View:    ' + BASE + (j.url ?? ''));
    return;
  }

  if (cmd === 'raw') {
    if (!arg) {
      usage();
      return;
    }
    const r = await fetch(BASE + '/api/claims/' + arg + '/raw');
    const j = (await r.json()) as { error?: string; raw?: string; segmentCount?: number };
    if (!r.ok || !j.raw) {
      console.error('Error:', j.error ?? 'unknown');
      process.exitCode = 1;
      return;
    }
    console.log(j.raw);
    return;
  }

  if (cmd === 'summary') {
    if (!arg) {
      usage();
      return;
    }
    const deid = process.argv[4] === 'deidentified';
    const r = await fetch(BASE + '/api/claims/' + arg + '/summary' + (deid ? '?deidentify=1' : ''));
    const j = (await r.json()) as { error?: string; text?: string };
    if (!r.ok || !j.text) {
      console.error('Error:', j.error ?? 'unknown');
      process.exitCode = 1;
      return;
    }
    console.log(j.text);
    return;
  }

  usage();
}

main().catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
