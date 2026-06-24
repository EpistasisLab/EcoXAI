---
name: hypothesis-dedup
description: Detect duplicate hypotheses at generation time using exact text match plus cosine similarity against already-stored hypotheses. Use during hypothesis generation to drop duplicates before they are saved. Triggers on "deduplicate hypotheses", "avoid duplicate hypotheses", "is this hypothesis a duplicate".
when: use during hypothesis generation, after drafting candidates and before posting them, to remove duplicates
visibility: public
tags: [hypothesis, dedup, duplicate, similarity, embeddings]
author: system
version: 1.0.0
---

# hypothesis-dedup

Remove duplicate hypotheses **at generation time** — before they are stored — using two layers:

1. **Exact match** (deterministic): normalized text (`lowercase + collapsed whitespace`)
   identical to an existing hypothesis OR to another candidate already kept in this batch.
2. **Cosine similarity** (semantic): the candidate's nearest **already-stored** hypothesis
   (via `GET /api/hypotheses/similar`) has `similarity >= threshold` (default 0.85).

Network failures never block — a candidate is kept if its similarity check can't run.

## Contract
- **Input:** `hypotheses` (list of dicts with `hypothesis_text`), `existing_texts`
  (texts already in the DB), `backend_url` (e.g. `http://host.docker.internal:8081`),
  optional `threshold` (cosine, default 0.85) and `k` (neighbors, default 5).
- **Output:** `{"kept": [...survivors...], "dropped": [{"text","reason","similarity"}, ...]}`
  where `reason ∈ {"exact","cosine"}`.

## How to use (from another skill, e.g. pipeline-hypothesize)
```python
import sys
sys.path.insert(0, "/workspace/.claude/skills/hypothesis-dedup")
from dedup import dedupe

res = dedupe(hypotheses, existing_texts, backend_url, threshold=0.85)
for d in res["dropped"]:
    print(f"  [dup:{d['reason']} {d['similarity']}] {d['text'][:70]}")
hypotheses = res["kept"]
# if fewer than the target remain, generate DIFFERENT ones and re-run dedupe, then POST.
```

## Notes
- Only dependency: `requests` (in the agent image).
- The cosine index covers **stored + embedded** hypotheses only (embedding is async on
  POST), so in-batch duplicates are caught by the exact layer (+ the caller's judgment that
  no two candidates test the same feature+mechanism).
- Tune `threshold`: raise toward 0.90 to be stricter, lower toward 0.80 to catch more.

When finished, emit: `SKILL_INVOKED: public:hypothesis-dedup`
