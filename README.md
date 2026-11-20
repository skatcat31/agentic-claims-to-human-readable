# Agentic Claims to Human-Readable

A **Retrieval-Augmented Generation (RAG) server + local vector database** written in
**TypeScript** that ingests EDI 837 health-care claims, parses them into
segment/element structures, retrieves 837 field definitions from a local vector
store, and exports **self-contained static HTML files** (a complete React bundle
baked in — no CDN, no network) that render the claim in a human-readable format.

Zero runtime npm dependencies: only Node.js (>= 18) and the TypeScript
compiler (dev dependency) are required.

## How it works

```
 raw 837 claim                RAG retrieval                      static HTML
 ┌──────────────┐   ┌─────────────────────────────┐   ┌──────────────────────┐
 │  ~-terminated │──▶│  1. parse837: split into     │──▶│  window.__CLAIM__    │
 │  837 segments │   │     segments + elements     │   │  + React 18 UMD      │
 └──────────────┘   │  2. embed each segment into  │   │  + a small React app │
                    │     a local vector DB       │   │  (1200px, 2 columns) │
                    │  3. retrieve the 837 KB     │   │  hover a field ⇄     │
                    │     definition for every    │   │  highlight in the    │
                    │     segment (top-k cosine)  │   │  raw electronic claim│
                    │  4. label every element     │   └──────────────────────┘
                    └─────────────────────────────┘
```

1. **Ingest** — the claim is parsed (`src/parse837.ts`) and each segment is
   embedded (deterministic hashing-trick sparse vectors, `src/embedding.ts`)
   and stored in a file-backed vector database (`src/vectorstore.ts`,
   `data/vectorstore.json`).
2. **Knowledge base** — at startup a built-in 837 (X12, professional)
   knowledge base (`src/knowledge837.ts`, 39 segment specs / ~200 element
   definitions) is embedded and seeded into the same vector DB as `kb`
   records.
3. **RAG export** — on export the claim's segments are retrieved from the
   vector DB by claim id, and for every distinct segment id the matching
   definition spec is retrieved via a similarity search
   (`src/rag.ts`). Each element is then labeled with its field name +
   description.
4. **Static HTML** — `src/generate.ts` bakes the React 18 + ReactDOM UMD
   bundles (downloaded to `vendor/` on first run, `src/vendor.ts`), the
   labeled claim payload, and a small React app into a single HTML file
   under `output/`.

## Quick start

```bash
npm install
npm start                # build (tsc) + boot the server on :8370

# ingest the bundled sample claim
node dist/cli.js ingest samples/sample-837.txt
node dist/cli.js list
node dist/cli.js export <claimId>

# open the exported page (also opens in any browser, fully offline)
#   output/claim-<id>.html
```

Run the end-to-end smoke test (parser, KB round-trip, retrieval accuracy,
persistence, HTML generation):

```bash
npm test
```

### HTTP API

| Method | Path                              | Description                                    |
| ------ | --------------------------------- | ---------------------------------------------- |
| GET    | `/`                               | Index page: claim list + paste-to-ingest form  |
| POST   | `/api/claims`                     | Ingest a claim (raw text or JSON `{claim}`)    |
| GET    | `/api/claims`                     | List ingested claims                           |
| GET    | `/api/claims/:id`                 | Claim metadata                                 |
| POST   | `/api/claims/:id/export`          | Generate the static HTML (JSON reply)          |
| GET    | `/files/:name`                    | Serve an exported HTML (lazy-generated)        |
| GET    | `/api/search?q=&scope=&k=`        | Similarity search over the vector DB (RAG demo)|
## The exported page

1200px max content width, two side-by-side cards (stacked on narrow screens):
the **electronic claim** (raw EDI, every element individually addressable) and
the **parsed fields** (read-only form fields — field name = data type from the
RAG-retrieved 837 definition, value = the data). Hovering either side
highlights the exact span of that element in the other.

```
┌──────────────────────────  EDI 837 Claim  ──────────────────────────────┐
│  Claim ID: 837-…  ·  33 segments  ·  142 fields  ·  generated …       │
│                                                                       │
│ ┌─────────────────────────────────┐ ┌─────────────────────────────────┐│
│ │ Electronic Claim                │ │ Parsed Fields                   ││
│ │                                 │ │                                 ││
│ │  8. CLM*1234567890*1234567893*  │ │  CLM — Claim                   ││
│ │  45*70*450.00*25*56*22*A        │ │  ┌───────────────────────────┐  ││
│ │        ▲ hovered element is     │ │  │ CLM01 Claim Number        │  ││
│ │        highlighted in yellow    │ │  │ [1234567890             ] │  ││
│ │                                 │ │  ├───────────────────────────┤  ││
│ │  9. SV1*46*99213                │ │  │ CLM04 Claim Type Code     │  ││
│ │                                 │ │  │ [70                     ] │  ││
│ └─────────────────────────────────┘ └─────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

## EDI 837 format notes

The parser (`src/parse837.ts`) targets the standard X12 4010/5010 interchange
layout used by 837 claims:

- segments are terminated by `~` (the ISA additionally carries the
  end-of-interchange `:~` / `>~` control marker),
- elements — **including inside the ISA segment** — are separated by `*`,
- a legacy fallback handles `|`-separated, one-segment-per-line files,
- known element counts (e.g. `CLM` = 9 in this knowledge base) are used to
  pad short segments so every labeled field keeps a stable
  `<segmentIndex>-<elementIndex>` key for the hover mapping.

## Project layout

```
server.ts             entry point (boots the server)
cli.ts                small CLI: list / ingest / export
src/paths.ts          project-root resolution (dist/-safe)
src/embedding.ts      hashing-trick sparse embeddings + cosine similarity
src/vectorstore.ts    file-backed vector DB (JSON) with top-k search
src/parse837.ts       X12 837 parser (segments, elements, stable keys)
src/knowledge837.ts   837 field-definition knowledge base (39 segments)
src/rag.ts            retrieval + labeling pipeline
src/generate.ts       self-contained HTML generator (React baked in)
src/vendor.ts         one-time download of the React UMD bundles
src/server.ts         HTTP API + index page
test/smoke.ts         end-to-end smoke test
samples/sample-837.txt  example 837P (005010X222) claim
data/                 vector DB (generated, git-ignored)
output/               exported HTML files (generated, git-ignored)
vendor/               React UMD bundles (downloaded, git-ignored)
```

## References

External references consulted while building this project:

- **TrueCommerce/node-x12** — ASC X12 parser + real X12 test fixtures
  (850/856 interchanges) used to confirm the 4010/5010 segment/element
  delimiter conventions (`~` segment terminator, `*` element separator,
  15-element ISA layout with the trailing `:~`/`>~` control marker):
  https://github.com/TrueCommerce/node-x12
- **@mrfentmen/x12-837-mcp** — 837-specific X12 validator with a canonical
  00501 837 sample (ISA layout, `ST*837*…~`, `SE`/`GE`/`IEA` counters):
  https://www.npmjs.com/package/@mrfentmen/x12-837-mcp
- **React 18.3.1 UMD bundles** (baked into every exported HTML file),
  mirrored from unpkg with a jsDelivr fallback:
  https://unpkg.com/react@18.3.1/umd/react.production.min.js
- **X12 837 (005010X222, professional) segment/element definitions** —
  the field names and descriptions in `src/knowledge837.ts` (ISA, GS, ST,
  BHT, N1, N3, N4, HL, CLM, SV1, L, ALX, NT, SBR, BAI, SE, GE, IEA and
  related segments).
