---
name: lit-novelty
description: Score genes by literature novelty (how little a gene is co-mentioned with a disease across PubMed, Europe PMC, and OpenAlex). Use to rank genes by how under-explored they are in the literature — genes the literature talks about LESS score higher. Triggers on "literature novelty", "how novel is this gene", "rank genes by novelty", "which genes are under-studied for Alzheimer".
when: use when you need a per-gene literature-novelty score for a set of genes (e.g. to flag under-explored / potentially novel candidates) relative to a disease
visibility: public
tags: [novelty, literature, genes, pubmed, europepmc, openalex, alzheimer]
author: system
version: 1.0.0
---

# lit-novelty

Compute **`lit_novelty`** for a set of genes: how little each gene is co-mentioned with a
disease in the literature. This is the measure from the Dyport novelty analysis
(`01_dyport_eval.py`), bundled here verbatim and self-contained.

```
lit_novelty(gene) = 1 − percentile_rank( multi-source co-mention count of gene ↔ disease )
```

- Genes the literature talks about **less** score **higher** (more novel).
- Genes with **0 co-mentions** land at the top.
- The score is **relative** — a percentile rank computed **over the gene set you pass in**.
  (Pass all the genes you want ranked together.)

This skill is **standalone**: it does not require other skills, the hypothesis database,
or the rest of the pipeline.

## Contract

- **Input:** a list of gene symbols (+ optional `disease`, default `"Alzheimer"`).
- **Output:** per-gene dict with `lit_novelty` (0–1), `lit_total` (summed co-mentions over
  PubMed/Europe PMC/OpenAlex), `n_sources_with_hits`, `preprint_count` (bioRxiv/medRxiv,
  tracked separately — not summed), and raw `source_counts`.

## How to use

The bundled module `lit_novelty.py` sits next to this file (it ships into the workspace at
`/workspace/.claude/skills/lit-novelty/`). Import it and call `score_genes`:

```python
import sys
sys.path.insert(0, "/workspace/.claude/skills/lit-novelty")
from lit_novelty import score_genes

genes = ["APOE", "APP", "PSEN1", "GALNT2"]      # the genes you want ranked
scores = score_genes(genes, disease="Alzheimer")

for g, r in sorted(scores.items(), key=lambda kv: -kv[1]["lit_novelty"]):
    print(g, r["lit_novelty"], "(lit_total=", r["lit_total"], ")")
```

Or run it directly for a quick check:

```bash
python3 /workspace/.claude/skills/lit-novelty/lit_novelty.py APOE APP GALNT2
```

## Notes

- Dependencies: `numpy`, `scipy`, `requests` (already in the agent image).
- Network: queries PubMed (NCBI E-utilities), Europe PMC, and OpenAlex; results are cached
  next to the module (`.lit_cache.json`) so re-runs are fast. Cache I/O is best-effort and
  never fatal.
- "0 across multiple sources" is a more trustworthy novelty signal than "0 in PubMed alone"
  (Europe PMC/OpenAlex also index body text), so cross-source agreement matters.
- `lit_novelty` is the single novelty measure intended for EcoXAI integration; everything
  here reproduces `01_dyport_eval.py` exactly.

When finished, emit: `SKILL_INVOKED: public:lit-novelty`
