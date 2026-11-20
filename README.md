# Agentic Claims to Human-Readable

A **Retrieval-Augmented Generation (RAG) server + local vector database** written in
**TypeScript** that ingests EDI 837 health-care claims, parses them into
segment/element structures, retrieves 837 field definitions from a local vector
store, and exports **self-contained static HTML files** (a complete React bundle
baked in — no CDN, no network) that render the claim in a human-readable format.

Zero runtime npm dependencies: only Node.js (>= 18) and the TypeScript
compiler (dev dependency) are required.

> **Note on PHI:** this is a local development tool — it performs no
> authentication, authorization, or encryption. Read
> [HIPAA considerations](#hipaa-considerations) before processing real claims.

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

## HIPAA considerations

> **Short answer:** this project is a **local development tool, not a
> production PHI system**. It authenticates no one, authorizes nothing, and
> does not encrypt PHI in transit or at rest. It is fine to run as long as it
> only ever sees the bundled **synthetic** sample (which is not PHI) on a
> machine you control. The moment **real claims** flow through it, it fails
> several HIPAA Security Rule (45 CFR §164) technical safeguards. The fix is
> not to re-architect this app but to run it **behind a wrapping API / reverse
> proxy** that performs TLS termination, authentication, per-claim
> authorization, and audit logging. Details below.

### What this design already does right

- **PHI never leaves the machine.** No external APIs, no LLM calls, no CDNs at
  runtime, no telemetry: parsing, RAG, and HTML generation are 100% local, and
  exported HTML is self-contained (works offline). Because no external
  service ever touches the data, **no BAA is required** — *keep it that way*
  (do not swap the local vector DB for a hosted service or add an LLM API
  without a BAA + data-flow review).
- **The bundled sample is synthetic** (`samples/sample-837.txt` uses fake
  payer/provider/claim numbers), so normal dev/test use does not involve PHI.
- `/files/` path handling is traversal-safe (`path.basename` + `.html` only),
  and ingest bodies are capped at 20 MB.

### Why it is NOT HIPAA-safe as-is

1. **No authentication** (`src/server.ts`): the request handler never checks
   who is asking. Anyone who can reach the port can ingest, list, read,
   export, and search. → §164.312(a)(1) access control, §164.312(a)(2)(i)
   unique user identification.
2. **No authorization / no claim-view permissions**: there is no notion of
   users, roles, or per-claim access. `GET /api/claims` (and the index page)
   enumerates *all* claims, and `GET /files/<name>` serves *any* exported
   HTML — with lazy generation on first request. → §164.308(a)(4) access
   management, and Privacy Rule minimum-necessary (§164.502(b)).
3. **No transport encryption**: plain HTTP only (`http.createServer`, no
   TLS) → §164.312(e)(1) transmission security.
4. **PHI at rest is unencrypted plaintext**: `data/vectorstore.json` stores
   every ingested segment's **raw text** (`text: seg.raw`) plus claim
   metadata, and each `output/claim-*.html` is a self-contained copy of the
   **entire claim** that can be carried anywhere and opened in any browser.
   No disk- or field-level encryption → §164.312(a)(1)(ii)(A) (addressable).

5. **Search is a PHI-content oracle**: `GET /api/search?scope=seg` (or
   `all`) returns raw segment text (up to 400 chars) for any ingested claim —
   anyone can query across all claims' PHI content.
6. **No audit controls**: only a stdout request line
   (`method url -> status ms`), no identity, not stored, not protected →
   §164.312(b).
7. **No session management** (no inactivity timeout / automatic logoff) →
   §164.312(a)(1)(ii)(B).
8. **No integrity or contingency safeguards**: a single JSON file, no
   checksums, no backup/DR story → §164.312(c)(1), §164.308(a)(7).
9. **Defaults widen exposure**: the server binds to `0.0.0.0` by default
   (`HOST` env), and 500 responses echo internal `err.message` to the client.

### Making it safe: a wrapping API / proxy that enforces claim-view permissions

Keep the app unchanged (or nearly so) and put an **enforcement layer** in
front of it that owns everything the app does not: TLS, identity,
per-claim permissions, and audit.

```
 user (browser)
    │  HTTPS (TLS terminated here)
    ▼
 wrapping API / reverse proxy
  · authenticate the user (SSO/OIDC/SAML + MFA, or strong unique credentials)
  · enforce claim-view permissions on every PHI-touching route
  · append-only audit log of every allow/deny
  · filter list responses to claims the user may view
    │  plain HTTP, internal only
    ▼
 this app — run with HOST=127.0.0.1 (loopback, unreachable outside the proxy)
```

1. **Loopback-only app.** Run with `HOST=127.0.0.1` (or a private interface)
   so only the proxy can reach it; the app never listens on a public
   interface.
2. **TLS at the proxy.** The wrapper terminates HTTPS (nginx, Caddy, or a TLS
   Node server); nothing PHI-shaped ever crosses a wire in the clear
   (§164.312(e)(1)).
3. **Authentication.** The wrapper authenticates every request (corporate
   SSO/OIDC/SAML with MFA preferred; at minimum unique user IDs —
   §164.312(a)(2)(i)) and holds the session; the app stays stateless.
   Enforce inactivity timeouts / automatic logoff (§164.312(a)(1)(ii)(B)).

4. **Claim-view authorization (the core of it).** The wrapper maintains an
   ACL — e.g. `user → { view: [claimIds] }` or a policy like
   `role = biller AND claim.facility = user.facility` — and checks it before
   forwarding, **deny by default**. Since ingest also flows through the
   wrapper, it can capture claim attributes (payer, facility, submitting
   user) at ingest time and auto-grant visibility (e.g. to the submitting
   user + their group). Route rules:

   | Route | Rule |
   | --- | --- |
   | `GET /api/claims`, `GET /` | forward, then **filter** the list to claims the user may view |
   | `GET /api/claims/:id` | `canView(user, claimId)`, else **403** |
   | `POST\|GET /api/claims/:id/export` | `canView(user, claimId)`, else **403** |
   | `GET /files/claim-<id>.html` | derive `claimId` from the name; `canView(user, claimId)`, else **403** (this also blocks lazy generation for non-viewable claims) |
   | `POST /api/claims` (ingest) | role-gated (e.g. an `ingest` service account / batch role); interactive users denied, or granted visibility only to their own submissions |
   | `GET /api/search` | **deny** (it is a PHI-content oracle); if a demo is needed, allow only `scope=kb` for users holding a search permission |
   | `GET /healthz` | keep it internal; deny at the public edge |

   Log every decision (allow/deny + reason) — this *is* the audit control
   (§164.312(b)).
5. **Treat the exported HTML as a PHI artifact.** Even for an authorized
   viewer, the HTML is a portable, complete copy of the claim. Mitigations:
   serve it only through the wrapper with `Cache-Control: no-store`; prefer
   **short-lived signed URLs** (token bound to `claimId + user + expiry`)
   over the stable `claim-<id>.html` name; add a **per-user watermark**
   (user ID + timestamp) to the generated HTML; and consider generating on
   demand and deleting the file after first authorized delivery (TTL)
   instead of persisting `output/` indefinitely.
6. **Encrypt PHI at rest.** The wrapper cannot encrypt the app's files, so do
   it at the environment: LUKS/dm-crypt (or encrypted cloud volumes) for
   `data/` and `output/`, and run the app as a dedicated least-privilege OS
   user. If file-level (not just disk-level) encryption is required, that is
   an app change: AES-GCM-encrypt segment text in `data/vectorstore.json`
   with a KMS-held key, and stop persisting `output/*.html` — stream the HTML
   from the export endpoint instead.
7. **Integrity + contingency.** Checksum claim text at ingest and verify on
   read (§164.312(c)(1)); encrypted backups of `data/` + a disaster-recovery
   runbook (§164.308(a)(7)).
8. **Operational hygiene.** A risk analysis (§164.308(a)(1)) scoped to the
   wrapper + app; no real PHI in dev environments (keep using the synthetic
   sample); workforce training; and re-audit the data flow before adding
   anything external (LLM API, hosted vector DB) — that would require a BAA.

#### Sketch of the wrapper (Node, schematic — not a full implementation)

```js
// wrapper.js — the enforcement layer in front of the app
const https = require('https');
const BACKEND = 'http://127.0.0.1:8370';        // app: loopback only

const auth  = { /* OIDC/SAML session validation -> { user, roles } */ };
const acl   = { canView(user, claimId) { /* grants or role+attribute policy */ } };
const audit = { log(e) { /* append-only, tamper-protected store */ } };

https.createServer({ key, cert }, (req, res) => {
  const user = auth.user(req);                     // 1) authenticate (else 401)
  if (!user) return res.writeHead(401).end();

  const claimId =
    (req.url.match(/^\/api\/claims\/([A-Za-z0-9-]+)/) || [])[1] ||
    (req.url.match(/^\/files\/claim-([A-Za-z0-9-]+)\.html$/) || [])[1];

  let decision;
  if (req.url === '/healthz' || req.url.startsWith('/api/search'))
    decision = 'deny';                             // no external healthz / search
  else if (req.method === 'POST' && req.url === '/api/claims')
    decision = auth.roles(req).includes('ingest') ? 'allow' : 'deny';
  else if (claimId && !acl.canView(user, claimId))
    decision = 'deny';                             // claim-view permission
  else decision = req.url.startsWith('/api/claims') ? 'filter' : 'allow';

  audit.log({ ts: new Date().toISOString(), user,
              req: req.method + ' ' + req.url, claimId, decision }); // 2) audit
  if (decision === 'deny') return res.writeHead(403).end('Forbidden');
  proxyToBackend(req, res, { decision });          // 3) forward (or filter list)
});
```

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
