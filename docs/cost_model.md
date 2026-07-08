# Cost Model — MICT-RAG-002 (S05 → S06)

This document explains the bounded per-query cost of the Document Intelligence RAG system, the current provider pricing, and projected costs at three traffic levels.

## Architecture

The system runs on **Google Gemma** (`google/gemma-4-26B-A4B-it`) via **DeepInfra** for generation and OpenAI `text-embedding-3-small` for embeddings. No Anthropic, Claude, or Haiku models are used anywhere in this system.

**Gemma does not expose a token-level prompt-caching API.** Prefix stability is maintained by prompt engineering discipline (identical system instructions on every call). Any internal caching by the model runtime is opaque and not billed separately.

## Provider Pricing (effective 2026-07-07)

| Provider | Model | Endpoint | Input ($/M tok) | Output ($/M tok) |
|---|---|---|---|---|
| DeepInfra | google/gemma-4-26B-A4B-it | /v1/chat/completions | $0.25 | $0.50 |
| OpenAI | text-embedding-3-small | /v1/embeddings | $0.02 | N/A |

> **Warning:** Prices change. The authoritative source is `config/pricing.json`, which carries an `effective_date`. If the file is older than 90 days, a runtime warning is emitted.

## Per-Query Cost Formula

```
gen_input_cost  = input_tokens  * 0.25 / 1_000_000
gen_output_cost = output_tokens * 0.50 / 1_000_000
total_query_cost = gen_input_cost + gen_output_cost
```

Embedding cost is **ingest-time**, not query-time. It is amortized across all queries that hit the corpus and is not included in the per-query average below.

## Observed Token Counts (from CI eval runs)

| Call Type | Typical Input Tokens | Typical Output Tokens |
|---|---|---|
| Warm query (answered) | 1,800 – 2,400 | 180 – 350 |
| Abstention (no generation) | 0 | 0 |
| Repair call (rare) | 2,200 – 3,000 | 200 – 400 |

Using the midpoint for a warm answered query:

- Input: 2,100 tok → $0.000525
- Output: 265 tok → $0.000133
- **Per-query average: ~$0.00066**

## Projected Costs at Three Traffic Levels

| Queries / Month | Generation Cost | Embedding Cost (amortized)* | Total / Month | Total / Year |
|---|---|---|---|---|
| 100 | $0.07 | ~$0.01 | **$0.08** | $0.96 |
| 1,000 | $0.66 | ~$0.05 | **$0.71** | $8.52 |
| 10,000 | $6.60 | ~$0.20 | **$6.80** | $81.60 |

*Embedding cost assumes a small static corpus re-ingested monthly. Actual cost scales with corpus size and churn, not query volume.

## Production cache hit rate (placeholder)

Observed production cache hit rate: **__TBD after first prod eval run__**

## Notes

- **No prompt-caching savings:** Gemma does not bill cached prefixes at a reduced rate. The "stable prefix + variable suffix" segmentation (§11.6) is still valuable for determinism and prompt hygiene, but it does not produce a direct cost reduction.
- **Abstention saves money:** The pre-generation relevance gate (§10.6) skips the generation call entirely when no chunk clears the floor. At high abstention rates, per-query cost drops.
- **Repair is bounded:** At most one corrective re-call per query (FR-AN-4), so worst-case cost is bounded at 2x the normal generation cost.
- **Budget-friendly:** Even at 10,000 queries/month, the system costs less than a typical SaaS subscription.
