# Sample Abstention (from Eval Corpus)

**Question:** *What is the optimal temperature for fibre optic cable installation in Arctic conditions?*

**System Answer (insufficient_evidence):**

> I don't have enough information in the provided documents to answer that.

## Gate Fired

**relevance** — the highest cosine similarity across retrieved chunks was 0.42, below the configured `SIMILARITY_FLOOR` of 0.65. The pre-generation relevance gate fired, preventing the generator from being called at all.

Tokens consumed: **0** (no generation). This is the feature — an expensive abstention.

---
*Synthetic / redacted — this is a canonical example from the S04 eval fixtures showing correct abstention behaviour. The returned answer is empty of citations and zero tokens were burned. Real production transcripts replace this placeholder after the closeout commit.*
