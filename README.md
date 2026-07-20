# Document Intelligence RAG

An answer it cannot cite is an answer it must not give.

[![CI](https://github.com/jakemorganlabs/document-intelligence-rag/actions/workflows/ci.yml/badge.svg)](https://github.com/jakemorganlabs/document-intelligence-rag/actions/workflows/ci.yml)
[![Eval](https://github.com/jakemorganlabs/document-intelligence-rag/actions/workflows/evals.yml/badge.svg)](https://github.com/jakemorganlabs/document-intelligence-rag/actions/workflows/evals.yml)

**Status:** v1.0.0, deployed and live.
**Query endpoint:** `https://docs.jakemorganlabs.dev/query` (HMAC signed).
**Health probe:** `https://docs.jakemorganlabs.dev/health` (no auth, no model call).

## Live demo

A signed request and a grounded answer, then the same system refusing a question it has no evidence for. The refusal is the point.

**Signed request:**
```bash
BODY='{"question":"What is the maximum permanent link length in horizontal cabling?"}'
TIMESTAMP=$(date +%s)
SIG=$(printf '%s' "${TIMESTAMP}${BODY}" | openssl dgst -sha256 -hmac "${HMAC_SECRET}" -binary | base64)
curl -s -H "X-Timestamp: $TIMESTAMP" -H "X-Signature: $SIG" \
     -H "Content-Type: application/json" -d "$BODY" \
     https://docs.jakemorganlabs.dev/query | jq .
```

**Answered:**
```json
{
  "status": "answered",
  "answer": "The horizontal permanent link is limited to 90 metres.",
  "citations": [
    { "chunk_id": "c-12", "source": "01_horizontal_cabling.pdf", "page": 4, "snippet": "limited to 90 m" }
  ],
  "audit_id": "<uuid>"
}
```

**Abstention:**
```json
{
  "status": "insufficient_evidence",
  "answer": "I don't have enough information in the provided documents to answer that.",
  "citations": [],
  "audit_id": "<uuid>"
}
```

The abstention is not a fallback. It is a deterministic gate. If nothing clears the similarity floor, the generator is never called. Zero tokens consumed. Zero hallucination surface. Most RAG demos only show the success path; the refusal path is the engineering signal.

## What it does

A small RAG system that treats every answer as a claim traceable to a passage in the corpus. PDFs are chunked, embedded into pgvector, and retrieved via cosine ANN. A two-stage grounding gate runs after retrieval: a pre-generation relevance floor, then a post-generation citation verifier that demands verbatim snippet matches. Either gate failing means an abstention rather than a guess. Eval-gated on three metrics, HMAC-authenticated at the edge, deployed behind a Cloudflare tunnel so only `/query` and `/health` are reachable.

## Architecture

```mermaid
graph LR
    subgraph Operator
        A[Drop PDF into corpus/]
    end
    A --> B[Python sidecar extract.py]
    B --> C[Chunker]
    C --> D[Embedder OpenAI text-embedding-3-small]
    D --> E[(pgvector HNSW)]
    P[User query] --> F{Cloudflare Tunnel}
    F --> G[/query]
    G --> H[Retriever ANN]
    H --> E
    H --> I{Relevance Floor >= 0.65}
    I -->|pass| J[DeepInfra Gemma generateContent]
    I -->|fail| K[Abstain]
    J --> L[Citation Verifier verbatim match]
    L -->|verified| M[Cited answer]
    L -->|repair x1| J
    L -->|still fail| K
    N[n8n editor] -.not exposed.-> F
    O[Postgres port] -.not exposed.-> F
```

Operator drops PDFs into a local directory and runs the ingest CLI. Extraction, chunking, and embedding run locally and write vectors into a Postgres + pgvector container. A Cloudflare tunnel exposes only `/query` and `/health`. Every query carries an HMAC-SHA256 signature. The retriever runs ANN against the HNSW index, the pre-generation floor rejects low-similarity queries, and the generator (Google Gemma via DeepInfra) returns structured JSON. The citation verifier checks every emitted snippet against the retrieved chunk text verbatim. Any failure triggers exactly one repair attempt, then an abstention. Every interaction is auditable.

## Measured bar

Three-metric eval suite on 75 labeled fixtures (19 synthetic PDFs; 42 answerable, 18 unanswerable, 15 adversarial questions). CI gates on every push to `main`.

| Suite | Cases | Metric | Value | Threshold | Gate |
|---|---|---|---|---|---|
| S04 Local | 75 | recall@k | 91.7% | 70.0% | PASS |
| S04 Local | 75 | false_answer_rate | 0.0% | 10.0% | PASS |
| S04 Local | 75 | false_refusal_rate | 8.3% | 25.0% | PASS |
| S04 Local | 75 | citation_integrity | 100.0% | 99.0% | PASS |

Per-category breakdowns and the failure table: [`docs/evidence/eval_report_local.md`](docs/evidence/eval_report_local.md). Production eval slot: [`docs/evidence/eval_report_prod.md`](docs/evidence/eval_report_prod.md).

## Security posture

- **HMAC at the edge:** every `/query` request carries `X-Timestamp` + `X-Signature` headers. Unsigned requests get 401 before retrieval. [`src/auth.ts`](src/auth.ts)
- **Ingest is CLI-only.** No public HTTP path accepts uploads.
- **Tunnel-only ingress.** No open inbound ports. Cloudflare exposes `/query` and `/health`; the n8n editor and Postgres are not on the public network.
- **Secrets in env, never in repo.** `.env.production.example` documents every variable with `__REPLACE_ME__` placeholders. The live `.env.production` lives on the VPS.
- **Rotation tested.** The runbook walks HMAC secret rotation end to end. It has been run once during setup so it is not first learned during an incident.
- **Nightly backups and ANN restore test.** `pg_dump -Fc` runs nightly. `deploy/restore.sh` spins a scratch DB, restores the dump, and asserts an ANN query returns rows.

Secret gate: [`scripts/secret_gate.sh`](scripts/secret_gate.sh). Run it before every commit.

## Run it

```bash
docker compose up -d                       # Postgres + pgvector
cp .env.example .env                       # set EMBEDDING_PROVIDER_API_KEY and GOOGLE_GENAI_API_KEY
npm run migrate:fresh
npm test
npm run eval
npm run serve                              # POST http://localhost:3000/query
```

Production deploy: [`docs/runbook.md`](docs/runbook.md).

## Repo map

```
src/
  chunker.ts              token-aware text splitter
  citation_verifier.ts    verbatim-match grounding gate
  abstention.ts           pre-generation floor + post-generation rules
  generator.ts            DeepInfra Gemma adapter
  generation_config.ts    pinned model validation
  retriever.ts            embed + ANN via pgvector
  query.ts                end-to-end query pipeline
  server.ts               /query (HMAC) + /health (no-auth)
  ingest.ts               file -> vectors orchestrator
  auth.ts                 HMAC-SHA256 verification
  db.ts / vector_store.ts Postgres CRUD + persistence
  embedder.ts             OpenAI embedding with retry
config/
  generation.json         pinned model + temperature
  retrieval.json          top_k + similarity_floor
  chunking.json           target tokens, overlap, boundary prefs
evals/
  run.ts                  eval runner (local and EVAL_ENV=prod)
  metrics/                recall, abstention, citation integrity
deploy/
  docker-compose.yml      pgvector + n8n + sidecar + cloudflared
  .env.production.example every variable, all __REPLACE_ME__
  cron/pg_dump.sh         nightly backup, 7-day rotation
  restore.sh              pg_restore + ANN sanity query
  reingest.sh             re-ingest after restore
docs/
  runbook.md              redeploy, migrate, rotate, restore, DLQ
  cost_model.md           token pricing and projected costs
  evidence/               eval reports, smoke transcripts, restore proofs
  *.html                  committed SRS/TDD controlled document
scripts/
  secret_gate.sh          pre-commit secret scanner
corpus/
  .gitkeep                live PDFs are operator-only, never committed
```

## Docs

- [SRS/TDD controlled document (Rev 1.0, baselined)](docs/document_intelligence_rag_srs_tdd.html)
- [Runbook: redeploy, rotate, restore, re-ingest, DLQ](docs/runbook.md)
- [Cost model: token pricing and abstention savings](docs/cost_model.md)
- [Eval evidence directory](docs/evidence/)

## Portfolio cross-link

Part of a five-piece portfolio. This is Piece II: grounding. Every claim cites a passage that verifiably contains it, or the system abstains.

Piece I `intake-n-outbound.pipeline` · Piece III `shovels_n8n_nodes` · Piece IV `recon_multiagent` · Capstone `fieldops`.

FIELD-005 reuses this piece directly. Its knowledge layer and eval-gate discipline become the capstone's grounding layer and CI gate.

## Author

**Jake Morgan** - [jakemorganlabs](__OPERATOR_PORTFOLIO_URL__)
LinkedIn: [__OPERATOR__](__OPERATOR_LINKEDIN__)
Contact: [__OPERATOR_EMAIL__](mailto:__OPERATOR_EMAIL__)

MICT-RAG-002 v1.0. Grounded RAG with citation verification and an abstention gate. Eval-gated, HMAC-authed, tunnel-only deploy.