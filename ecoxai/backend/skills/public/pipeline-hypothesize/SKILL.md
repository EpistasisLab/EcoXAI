---
name: pipeline-hypothesize
description: Generate diverse, novel, falsifiable hypotheses across statistical, ML, biological, and data-quality dimensions — querying existing hypotheses first to maximize coverage
when: use when running the hypothesis generation phase after dataset exploration
visibility: public
tags: [pipeline, hypothesize, hypothesis, alzkb, diversity, novelty]
author: system
version: 2.0.0
---

## Instructions

You are the hypothesis generation phase of a scientific analysis pipeline. Your goal is to generate **diverse, novel, falsifiable** scientific hypotheses about the dataset, but your job is to not directly test them as that would be handled by other agents. Hypotheses are stored directly in the hypothesis database via the backend API — no files are written.

Before generating anything, you must:
1. If there is a research question in the task.txt that the user wants, that is the direction of all hypotheses. Diversity of hypotheses is important, but it should be ALWAYS towards the direction to solve the research question.
2. View the EDA report (in /workspace/exploration_report.md) for dataset context.
3. Load the dataset for full context
4. **Query existing hypotheses** from the API — do not regenerate what already exists
5. Reason explicitly about which hypothesis types and features are under-explored
6. Generate 6–10 hypotheses that maximize scientific coverage
7. POST them to the API

---

### Supported Hypothesis Types

Choose the type that most precisely describes each hypothesis:

**ML/model layer**
- `feature_importance` — a feature ranks highly in a trained model (specify threshold)
- `model_performance` — model achieves a target metric (AUC, F1, accuracy, etc.)
- `feature_engineering` — a derived/transformed feature improves model performance
- `predictive` — feature X predicts outcome Y above a baseline

**Biological/domain layer**
- `biomarker` — a feature is a reliable indicator of a clinical condition
- `risk_factor` — a feature is associated with increased risk of the outcome
- `protective_factor` — a feature is associated with reduced risk of the outcome
- `pathway` — a biological pathway is implicated in the outcome
- `subgroup` — a population subgroup exhibits a meaningfully different pattern
- `causal` — directional claim: X influences Y (stronger than correlation)

**Interaction/mechanistic layer**
- `interaction_effect` — two features jointly predict the outcome better than either alone (testable by engineering the interaction term and checking its model importance)

---

### Steps

#### 1. Load Context

```python
import json
import os
import pandas as pd
import numpy as np

dataset_id = os.environ.get('DATASET_ID', '')
domain = os.environ.get('DATASET_DOMAIN', 'unknown')
backend_url = os.environ.get('BACKEND_URL', 'http://host.docker.internal:8081')
job_id = os.environ.get('JOB_ID', '')

print(f"Domain: {domain}, Job: {job_id}")

# Load cleaned data
df = pd.read_csv(f'/datasets/{dataset_id}/cleaned/data.feather')
feature_cols = df.columns.tolist()

# Infer target column
target_candidates = [c for c in feature_cols
                     if any(kw in c.lower() for kw in ['target', 'label', 'outcome', 'diagnosis', 'class', 'y'])]
target_col = target_candidates[0] if target_candidates else feature_cols[-1]
non_target_features = [c for c in feature_cols if c != target_col]

print(f"Dataset: {df.shape[0]} rows × {df.shape[1]} columns")
print(f"Target: {target_col}")
print(f"Features ({len(non_target_features)}): {non_target_features[:20]}")
```

#### 2. Query Existing Hypotheses

```python
import requests
from collections import Counter

try:
    resp = requests.get(f'{backend_url}/api/hypotheses', timeout=10)
    existing = resp.json().get('hypotheses', [])
except Exception as e:
    print(f"Warning: could not fetch existing hypotheses: {e}")
    existing = []

existing_texts = [h['hypothesis_text'] for h in existing]
existing_features = set(h.get('feature_name') for h in existing if h.get('feature_name'))
existing_types = Counter(h.get('hypothesis_type') for h in existing if h.get('hypothesis_type'))

print(f"\nExisting hypotheses: {len(existing)}")
print(f"Features already covered: {sorted(existing_features)}")
print(f"Type coverage: {dict(existing_types)}")

# Identify under-explored features and types
uncovered_features = [f for f in non_target_features if f not in existing_features]
all_types = [
    'feature_importance', 'model_performance', 'feature_engineering', 'predictive',
    'biomarker', 'risk_factor', 'protective_factor', 'pathway', 'subgroup', 'causal',
    'interaction_effect',
]
uncovered_types = [t for t in all_types if existing_types.get(t, 0) == 0]

print(f"Uncovered features: {uncovered_features[:20]}")
print(f"Unused hypothesis types: {uncovered_types}")
```

#### 3. For Genomics Datasets — Query alzkb.ai

If `domain == 'genomics'` or the dataset contains known gene symbols:

```python
if domain == 'genomics' or any(e.upper() in [c.upper() for c in df.columns] for e in ['APOE', 'APP', 'PSEN1', 'MAPT']):
    from neo4j import GraphDatabase

    driver = GraphDatabase.driver("bolt://alzkb.ai:7687", auth=("neo4j", ""))

    with driver.session() as session:
        result = session.run("""
            MATCH (g:Gene)-[:GENEASSOCIATESWITHDISEASE]->(d:Disease)
            WHERE d.commonName =~ '(?i).*Alzheimer.*'
            RETURN g.geneSymbol AS gene
            LIMIT 50
        """)
        alzkb_genes = [r['gene'] for r in result]

    with driver.session() as session:
        result = session.run("""
            MATCH (g:Gene)-[:GENEINPATHWAY]->(p:Pathway)
            WHERE p.commonName =~ '(?i).*amyloid.*'
            RETURN g.geneSymbol AS gene, p.commonName AS pathway
        """)
        amyloid_genes = [r['gene'] for r in result]

    driver.close()
    dataset_genes = [g for g in alzkb_genes if g in df.columns]
    print(f"alzkb.ai genes present in dataset: {dataset_genes}")
```

#### 4. Generate Diverse Hypotheses

Reason explicitly about diversity before generating. Your analysis must include:

```
DIVERSITY ANALYSIS
==================
Features already hypothesized: {list(existing_features)}
Type coverage so far: {dict(existing_types)}
Total existing hypotheses: {len(existing)}

Uncovered features (prioritize these): {uncovered_features[:15]}
Unused hypothesis types (target these): {uncovered_types}

GENERATION RULES
================
1. Type breadth: include types from AT LEAST 3 different layers (ML/model, biological/domain,
   interaction/mechanistic). Strongly prefer unused types.
2. Feature breadth: prioritize features NOT in existing_features. Do not repeat a feature
   unless the new hypothesis tests it in a fundamentally different way.
3. Layer diversity: do not generate more than 3 hypotheses from the ML/model layer or the
   biological/domain layer in a single batch.
4. Semantic novelty: each hypothesis must test a DIFFERENT mechanism or pattern.
   "Feature A importance > 0.1" and "Feature A importance > 0.2" are NOT distinct.
5. Information gain: prefer hypotheses whose confirmation or rejection would most
   change our scientific understanding of the dataset.
6. Falsifiability: every hypothesis must specify an expected_metric — a concrete,
   testable prediction (e.g. "Spearman r > 0.35", "AUC > 0.78", "missing rate differs
   by > 10 percentage points across target classes").
7. No duplicates: do not generate any hypothesis semantically equivalent to:
   {existing_texts}

Generate 6–10 hypotheses. Quality over quantity.
```

```python
hypotheses = [
    # Each hypothesis must be a dict with these fields:
    {
        "hypothesis_text": "Precise, falsifiable one-sentence claim about the data",
        "hypothesis_type": "<one of the 17 types above>",
        "confidence_score": 0.75,  # honest 0–1 estimate
        "expected_metric": "Free-text description of what a passing test looks like, e.g. 'Spearman r > 0.4'",
        "feature_name": "column_name_or_null",  # null if not feature-specific
        "novelty_rationale": "One sentence: how this differs from existing hypotheses"
    },
    # ... more hypotheses
]
```

#### 5. POST Hypotheses to Backend API

```python
payload = {
    "job_id": job_id,
    "hypotheses": [
        {
            "hypothesis_text": h["hypothesis_text"],
            "hypothesis_type": h["hypothesis_type"],
            "confidence_score": h.get("confidence_score"),
            "expected_metric": h.get("expected_metric"),
            "feature_name": h.get("feature_name"),
            "novelty_rationale": h.get("novelty_rationale")
        }
        for h in hypotheses
    ]
}

try:
    result = requests.post(f'{backend_url}/api/hypotheses', json=payload, timeout=15)
    result.raise_for_status()
    created = result.json().get('created', [])
    print(f"Stored {len(created)} hypotheses via API")
    for h in created:
        print(f"  [{h['hypothesis_type']}] {h['hypothesis_text'][:80]}")
except Exception as e:
    print(f"ERROR: Failed to store hypotheses: {e}")
    raise
```

#### 6. Write Interesting Hypotheses to report.md

A hypothesis is **interesting to pursue** if it meets any of the following:
- `confidence_score >= 0.70`
- `hypothesis_type` is biological/domain or mechanistic (`biomarker`, `causal`, `pathway`, `interaction_effect`, `risk_factor`, `protective_factor`, `subgroup`)
- `novelty_rationale` indicates it covers an unexplored feature or type

Select the top hypotheses (up to 5) that are most worth acting on next. Sort by confidence descending within the interesting set.

```python
import os

INTERESTING_TYPES = {
    'biomarker', 'causal', 'pathway', 'interaction_effect',
    'risk_factor', 'protective_factor', 'subgroup'
}
CONFIDENCE_THRESHOLD = 0.70

def is_interesting(h):
    score = h.get('confidence_score') or 0
    htype = h.get('hypothesis_type', '')
    return score >= CONFIDENCE_THRESHOLD or htype in INTERESTING_TYPES

interesting = sorted(
    [h for h in hypotheses if is_interesting(h)],
    key=lambda h: h.get('confidence_score') or 0,
    reverse=True
)[:5]

report_path = '/workspace/output/report.md'

# Build the section
lines = [
    '',
    '---',
    '',
    '## Hypotheses Worth Pursuing',
    '',
    f'*{len(hypotheses)} hypotheses generated; {len(interesting)} flagged as high-priority.*',
    '',
]

if interesting:
    for i, h in enumerate(interesting, 1):
        score = h.get('confidence_score')
        score_str = f'{score:.2f}' if score is not None else 'n/a'
        feature = h.get('feature_name') or '—'
        metric = h.get('expected_metric') or '—'
        rationale = h.get('novelty_rationale') or '—'
        lines += [
            f'### {i}. {h["hypothesis_text"]}',
            '',
            f'- **Type:** `{h.get("hypothesis_type", "unknown")}`',
            f'- **Confidence:** {score_str}',
            f'- **Feature:** {feature}',
            f'- **Expected metric:** {metric}',
            f'- **Why interesting:** {rationale}',
            '',
        ]
else:
    lines.append('*No hypotheses exceeded the interest threshold this run.*')
    lines.append('')

section = '\n'.join(lines)

# Append to existing report.md, or create it if missing
os.makedirs('/workspace/output', exist_ok=True)
if os.path.exists(report_path):
    with open(report_path, 'a') as f:
        f.write(section)
else:
    with open(report_path, 'w') as f:
        f.write(f'# Hypothesis Generation Report\n{section}')

print(f"Appended {len(interesting)} high-priority hypotheses to report.md")
print("SKILL_INVOKED: public:pipeline-hypothesize")
```
