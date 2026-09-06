# docs/evidence/

Sanitized production artifacts and eval results. All files are synthetic or redacted. Real tokens, internal URLs, and client data never appear here.

## Index

| File | Status | Description |
|---|---|---|
| `eval_report_local.md` | Committed | S04 local eval: recall@k, abstention correctness, citation integrity |
| `eval_report_prod.md` | Committed | Production eval over the live tunnel after `EVAL_ENV=prod` run |
| `smoke_prod_output.txt` | Committed | Signed request -> 200 + citations, unsigned -> 401, health -> 200 transcript |
| `sample_grounded_answer.md` | Committed | Example Q->A with verified citations from eval corpus |
| `sample_abstention.md` | Committed | Example question correctly refused by the abstention gate |
| `restore_test.txt` | Committed | ANN sanity query PASS transcript after pg_restore of the nightly dump |

## How to populate closeout slots

After deployment:

```bash
EVAL_ENV=prod npx tsx evals/run.ts              # -> eval_report_prod.md
bash scripts/smoke_prod.sh                       # -> smoke_prod_output.txt
bash deploy/restore.sh                            # -> restore_test.txt
```

Then commit to the `closeout-evidence` branch per the protocol in `docs/runbook.md` §7.