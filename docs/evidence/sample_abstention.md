# Sample Abstention (from Eval Corpus)

**Question:** *What is the optimal temperature for fibre optic cable installation in Arctic conditions?*

**System Answer (insufficient_evidence):**

> I don't have enough information in the provided documents to answer that.

## Gate Fired

relevance. The highest cosine similarity across retrieved chunks was 0.42, below the configured `SIMILARITY_FLOOR` of 0.65. The pre-generation relevance gate fired and the generator was never called.

Tokens consumed: 0. This is the feature: an abstention with no generation cost.

---

Synthetic, redacted. Canonical example from the S04 eval fixtures showing correct abstention behaviour. The returned answer has no citations and zero tokens were burned. Real production transcripts replace this placeholder after the closeout commit.