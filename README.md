# Document Intelligence RAG

*An answer it cannot cite is an answer it must not give.*

[![CI](https://github.com/jakemorganlabs/document-intelligence-rag/actions/workflows/ci.yml/badge.svg)](https://github.com/jakemorganlabs/document-intelligence-rag/actions/workflows/ci.yml)
[![Eval](https://github.com/jakemorganlabs/document-intelligence-rag/actions/workflows/evals.yml/badge.svg)](https://github.com/jakemorganlabs/document-intelligence-rag/actions/workflows/evals.yml)

**Status:** `v1.0.0 — deployed and live`  
**Public query endpoint:** `https://docs.jakemorganlabs.dev/query` (HMAC signature required)  
**Health probe:** `https://docs.jakemorganlabs.dev/health` (no-auth, no-model-call)

---

## Live demonstration

Below is a signed request and a grounded answer with its citation block — the system's normal operating mode. Directly beneath it is the feature that differentiates this piece: a question the system correctly refuses.

**Signed request (bash):**
```bash
BODY='{"question":"What is the maximum permanent link length in horizontal cabling?"}'
TIMESTAMP=$(date +%s)
SIG=$(printf '%s' "${TIMESTAMP}${BODY}" | openssl dgst -sha256 -hmac "${HMAC_SECRET}" -binary | base64)
curl -s -H "X-Timestamp: $TIMESTAMP" -H "X-Signature: $SIG" \
     -H "Content-Type: application/json" -d "$BODY" \
     https://docs.jakemorganlabs.dev/query | jq .
```

**Answered response:**
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

**Abstention — the differentiator:**

```json
{
  "status": "insufficient_evidence",
  "answer": "I don't have enough information in the provided documents to answer that.",
  "citations": [],
  "audit_id": "<uuid>"
}
```

The abstention is not a fallback — it is a deliberate, deterministic gate. If no retrieved chunk clears the similarity floor, the generator is never called. Zero tokens consumed, zero hallucination risk. Most RAG demos only show the "works" path. Showing the "knows when to stop" path is the engineering signal here.

---

## What it does

This is a small, sharp RAG system that treats every answer as a claim that must be traceable to a passage in the ingested corpus. It chunks documents, embeds them into pgvector, retrieves via cosine ANN, and then applies a two-stage grounding gate: a pre-generation relevance floor, and a post-generation citation verifier that demands verbatim snippet matches. If either gate fails, the system abstains rather than fabricates. It is eval-gated on three metrics, HMAC-authenticated at the edge, and deployed behind a Cloudflare tunnel so that only the query path is publicly reachable.

---

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
    Nn8n editor ---|not exposed| F
    OPostgres port ---|not exposed| F
```

**Walk-through:** The operator drops PDFs into a local directory and runs the ingest CLI. Extraction, chunking, and embedding happen locally, writing vectors into a Postgres + pgvector container. A Cloudflare tunnel exposes only `/query` and `/health`. Every query request must carry HMAC-SHA256 signatures. The retriever performs ANN against the HNSW index, the pre-generation floor gates out low-similarity queries, and the generator (Google Gemma via DeepInfra) returns structured JSON. The citation verifier checks every emitted snippet against the retrieved chunk text verbatim. Any failure triggers exactly one repair attempt, then an abstention. Every interaction is auditable.

---

## The measured bar

Three-metric eval suite on 75 labeled fixtures (19 synthetic PDFs, 42 answerable + 18 unanswerable + 15 adversarial questions). CI gates on every push to `main`.

| Suite | Cases | Metric | Value | Threshold | Gate |
|---|---|---|---|---|---|
| S04 Local | 75 | recall@k | 91.7% | 70.0% | PASS |
| S04 Local | 75 | false_answer_rate | 0.0% | 10.0% | PASS |
| S04 Local | 75 | false_refusal_rate | 8.3% | 25.0% | PASS |
| S04 Local | 75 | citation_integrity | 100.0% | 99.0% | PASS |

> See [`docs/evidence/eval_report_local.md`](docs/evidence/eval_report_local.md) for per-category breakdowns and the failure table. Production eval report slot: [`docs/evidence/eval_report_prod.md`](docs/evidence/eval_report_prod.md).

---

## Security posture

- **HMAC at the edge:** Every `/query` request must carry `X-Timestamp` + `X-Signature` headers. Unsigned requests are rejected with 401 before retrieval. [`src/auth.ts`](src/auth.ts)
- **Ingestion unreachable:** The ingest pipeline is operator-only via CLI. There is no public HTTP endpoint that accepts uploads.
- **Tunnel-only ingress:** No open inbound ports. Cloudflare tunnel exposes `/query` and `/health` only; the n8n editor and Postgres are not reachable from the public internet.
- **Secrets in env, never in repo:** `.env.production.example` documents every variable with `__REPLACE_ME__` placeholders. The live `.env.production` is on the VPS only.
- **Executed rotation procedure:** The runbook documents HMAC secret rotation step-by-step, tested once during setup so it is not discovered during an incident.
- **Nightly backups + ANN restore test:** `pg_dump -Fc` runs nightly. `deploy/restore.sh` spins a scratch DB, restores the dump, and asserts an ANN query returns rows.

Secret gate: [`scripts/secret_gate.sh`](scripts/secret_gate.sh) — run before every commit.

---

## Run it yourself

```bash
# 1. Clone
# 2. Start Postgres + pgvector
docker compose up -d

# 3. Configure environment
cp .env.example .env
# Edit .env: set EMBEDDING_PROVIDER_API_KEY (OpenAI) and GOOGLE_GENAI_API_KEY (DeepInfra)

# 4. Apply migrations
npm run migrate:fresh

# 5. Run tests + evals
npm test
npm run eval

# 6. Start query server
npm run serve
# POST http://localhost:3000/query with { question: "..." }
```

For production deployment, see [`docs/runbook.md`](docs/runbook.md).

---

## Repo map

```
src/
  chunker.ts              Token-aware text splitter (S01)
  citation_verifier.ts    Deterministic verbatim-match gate
  abstention.ts           Pre-generation floor + post-generation rules
  generator.ts            DeepInfra Gemma adapter (S06 — no Anthropic)
  generation_config.ts    Pinned model validation
  retriever.ts            Embed + ANN via pgvector
  query.ts                End-to-end query pipeline
  server.ts               HTTP endpoint: /query (HMAC) + /health (no-auth)
  ingest.ts               Orchestrator: file → vectors
  auth.ts                 HMAC-SHA256 verification
  db.ts / vector_store.ts Postgres CRUD + persistence
  embedder.ts             OpenAI embedding with retry
config/
  generation.json         Pinned Gemma model + temperature
  retrieval.json          top_k + similarity_floor
  chunking.json           Target tokens, overlap, boundary prefs
evals/
  run.ts                  Eval runner (local & EVAL_ENV=prod)
  metrics/                recall, abstention, citation integrity
deploy/
  docker-compose.yml      Production stack: pgvector + n8n + sidecar + cloudflared
  .env.production.example Every variable, all __REPLACE_ME__
  cron/pg_dump.sh        Nightly backup with 7-day rotation
  restore.sh             pg_restore + ANN sanity query
  reingest.sh            Operator re-ingest after restore
docs/
  runbook.md             Redeploy, migrate, rotate secrets, restore, DLQ
  cost_model.md          Token pricing + projected costs
  evidence/              Eval reports, smoke transcripts, restore proofs
  *.html                 Committed SRS/TDD controlled document
scripts/
  secret_gate.sh         Pre-commit secret scanner
corpus/
  .gitkeep               Live PDFs are operator-only, never committed
```

---

## Docs

- [SRS/TDD — controlled document this build implements (Rev 1.0, baselined)](docs/document_intelligence_rag_srs_tdd.html)
- [Runbook — redeploy, rotate secrets, restore, re-ingest, DLQ](docs/runbook.md)
- [Cost model — token pricing and abstention savings](docs/cost_model.md)
- [Eval evidence directory](docs/evidence/)

---

## Portfolio cross-link

> **Part of a five-piece portfolio.** This is **Piece II** — grounding: every claim cites a passage that verifiably contains it, or the system abstains.
>
> Piece I `intake-n-outbound.pipeline` · Piece III `shovels_n8n_nodes` · Piece IV `recon_multiagent` · Capstone `fieldops`
>
> FIELD-005 explicitly reuses this piece's discipline: its knowledge layer and eval-gate discipline become the capstone's grounding layer and CI gate.

---

## Author

**Jake Morgan** — [jakemorganlabs](__OPERATOR_PORTFOLIO_URL__)  
LinkedIn: [__OPERATOR__](__OPERATOR_LINKEDIN__)  
Contact: [__OPERATOR_EMAIL__](mailto:__OPERATOR_EMAIL__)

---

*MICT-RAG-002 v1.0 · Grounded RAG with citation verification and an abstention gate — eval-gated, HMAC-authed, tunnel-only deploy.*
