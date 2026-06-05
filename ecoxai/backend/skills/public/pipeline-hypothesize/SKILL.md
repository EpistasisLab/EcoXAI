---
name: pipeline-hypothesize
description: Generate 3-5 falsifiable feature importance hypotheses from cleaned data and domain knowledge
when: use when running the hypothesis generation phase after dataset exploration
visibility: public
tags: [pipeline, hypothesize, hypothesis, alzkb, genomics, feature-importance]
author: system
version: 1.0.0
---

## Instructions

You are the hypothesis generation phase of a scientific analysis pipeline. Your goal is to produce testable, quantitative predictions about which features will matter most for predicting the target variable. Hypotheses must be falsifiable — they specify a feature name and a minimum expected importance threshold.

### Required Output

| File | Description |
|---|---|
| `output/next_hypothesis.json` | Structured hypotheses in the exact format the hypothesis system expects |

### Steps

#### 1. Read Context

```python
import json
import os
import pandas as pd

dataset_id = os.environ.get('DATASET_ID', '')
domain = os.environ.get('DATASET_DOMAIN', 'unknown')
print(f"Domain: {domain}")

# Read exploration report for context
with open('/workspace/exploration_report.md') as f:
    exploration_report = f.read()

# Load cleaned data from explore phase (promoted to shared datasets volume)
df = pd.read_csv(f'/datasets/{dataset_id}/cleaned/data.csv')
print(f"Columns: {df.columns.tolist()}")
```

#### 2. For Genomics Datasets — Query alzkb.ai

If `domain == 'genomics'` or entities contain gene symbols, use alzkb.ai for prior knowledge:

```python
if domain == 'genomics' or any(e.upper() in df.columns.str.upper().tolist() for e in ['APOE', 'APP', 'PSEN1', 'MAPT']):
    from neo4j import GraphDatabase

    driver = GraphDatabase.driver("bolt://alzkb.ai:7687", auth=("neo4j", ""))

    # Phase 1: All disease-associated genes
    with driver.session() as session:
        result = session.run("""
            MATCH (g:Gene)-[:GENEASSOCIATESWITHDISEASE]->(d:Disease)
            WHERE d.commonName =~ '(?i).*Alzheimer.*'
            RETURN g.geneSymbol AS gene
            LIMIT 50
        """)
        alzkb_genes = [r['gene'] for r in result]

    # Phase 2: Pathway genes
    with driver.session() as session:
        result = session.run("""
            MATCH (g:Gene)-[:GENEINPATHWAY]->(p:Pathway)
            WHERE p.commonName =~ '(?i).*amyloid.*'
            RETURN g.geneSymbol AS gene, p.commonName AS pathway
        """)
        amyloid_genes = [r['gene'] for r in result]

    driver.close()

    # Filter to genes that actually exist as columns in our dataset
    dataset_genes = [g for g in alzkb_genes if g in df.columns]
    print(f"alzkb.ai genes present in dataset: {dataset_genes}")
```

#### 3. Generate Hypotheses

Rules for good hypotheses:
- Specific feature name (must be a column in the dataset)
- Quantitative expected_importance (0.05–0.40 range is realistic)
- Clear reasoning tied to domain evidence
- 3-5 hypotheses total — quality over quantity

```python
hypotheses = []

# Example: top-importance hypothesis for a known key feature
if 'APOE' in df.columns:
    hypotheses.append({
        "hypothesis_text": "Feature 'APOE' will have importance > 0.15 in Alzheimer's prediction",
        "hypothesis_type": "feature_importance",
        "confidence_score": 0.90,
        "expected_importance": 0.15,
        "expected_metric": "importance > 0.15",
        "alzkb_source": "alzkb.ai: APOE ε4 allele is the strongest genetic risk factor for late-onset Alzheimer's disease",
        "feature_name": "APOE"
    })

# Derive hypotheses from the exploration report and column names
# Look for columns that semantically match domain entities, clinical biomarkers, etc.
# Each hypothesis should come with a reasoning chain.
```

#### 4. Add Relationship Edges (Optional)

If hypotheses are logically related, add edges:

```python
relationships = []

# Example: pathway hypothesis depends on individual gene hypotheses
# relationships.append({
#     "from_index": 2,      # index into hypotheses array
#     "to_index": 0,
#     "edge_type": "DEPENDS_ON",
#     "reasoning": "Pathway aggregation depends on individual gene importance being non-zero",
#     "confidence": 0.8
# })
```

#### 5. Write Output

```python
import os

output = {
    "hypotheses": hypotheses,
    "relationships": relationships
}

os.makedirs('/workspace/output', exist_ok=True)
with open('/workspace/output/next_hypothesis.json', 'w') as f:
    json.dump(output, f, indent=2)

print(f"Generated {len(hypotheses)} hypotheses")
for i, h in enumerate(hypotheses):
    print(f"  [{i}] {h['feature_name']}: expected importance > {h['expected_importance']}")

print("SKILL_INVOKED: public:pipeline-hypothesize")
```

### next_hypothesis.json Schema

```json
{
  "hypotheses": [
    {
      "hypothesis_text": "Feature 'X' will have importance > 0.15 in Y prediction",
      "hypothesis_type": "feature_importance",
      "confidence_score": 0.85,
      "expected_importance": 0.15,
      "expected_metric": "importance > 0.15",
      "alzkb_source": "optional citation string",
      "feature_name": "X"
    }
  ],
  "relationships": [
    {
      "from_index": 0,
      "to_index": 1,
      "edge_type": "DEPENDS_ON",
      "reasoning": "...",
      "confidence": 0.8
    }
  ]
}
```

**Valid edge types:** `REVISES`, `ALTERNATIVE_TO`, `DERIVED_FROM`, `DEPENDS_ON`, `CONTRADICTS`

**Required fields per hypothesis:** `hypothesis_text`, `feature_name`

**Hypothesis types:** `feature_importance`, `feature_engineering`, `model_performance`
