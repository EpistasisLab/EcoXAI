---
name: pipeline-validate
description: Scientifically validate hypothesis results and produce a comprehensive final report
when: use when running the validation phase after hypothesis testing is complete
visibility: public
tags: [pipeline, validate, report, scientific, summary]
author: system
version: 1.0.0
---

## Instructions

You are the validation and reporting phase of a scientific analysis pipeline. Your job is to review the ML test results, apply rigorous scientific judgment to each hypothesis, and produce a final report that summarizes findings and recommends next experiments.

### Required Output

| File | Description |
|---|---|
| `output/report.md` | Comprehensive scientific report |

### Verdict Decision Rules

| Condition | Verdict |
|---|---|
| `actual_importance >= expected_importance` | `supported` — hypothesis confirmed |
| `actual_importance >= expected_importance × 0.5` | `needs_more_data` — trend present but weak |
| `actual_importance < expected_importance × 0.5` | `rejected` — hypothesis not confirmed |

### Steps

#### 1. Load All Results

```python
import json
import os
import pandas as pd

# Test results
with open('/workspace/output/feature_importance_results.json') as f:
    importance_results = json.load(f)

# Hypotheses (if available)
hypotheses = []
hyp_path = '/workspace/output/next_hypothesis.json'
if os.path.exists(hyp_path):
    with open(hyp_path) as f:
        hyp_data = json.load(f)
    hypotheses = hyp_data.get('hypotheses', [])

# Exploration report for context
with open('/workspace/output/exploration_report.md') as f:
    exploration_report = f.read()

# Test results markdown for context
test_results_text = ''
test_results_path = '/workspace/output/test_results.md'
if os.path.exists(test_results_path):
    with open(test_results_path) as f:
        test_results_text = f.read()

# Build importance lookup
importance_by_feature = {r['feature']: r['importance'] for r in importance_results}

print(f"Validating {len(hypotheses)} hypotheses against {len(importance_results)} measured features")
```

#### 2. Classify Each Hypothesis

```python
supported = []
rejected = []
needs_more_data = []

for h in hypotheses:
    feat = h.get('feature_name', '')
    expected = h.get('expected_importance', 0.0)
    actual = importance_by_feature.get(feat, 0.0)
    source = h.get('alzkb_source', '')

    record = {
        **h,
        'actual_importance': round(actual, 4),
        'delta': round(actual - expected, 4),
        'pct_of_expected': round(actual / expected, 2) if expected > 0 else None,
        'alzkb_source': source
    }

    if actual >= expected:
        record['verdict'] = 'supported'
        supported.append(record)
    elif actual >= expected * 0.5:
        record['verdict'] = 'needs_more_data'
        needs_more_data.append(record)
    else:
        record['verdict'] = 'rejected'
        rejected.append(record)

print(f"Supported: {len(supported)}, Needs more data: {len(needs_more_data)}, Rejected: {len(rejected)}")
```

#### 3. Identify Surprising Findings

```python
# Highest-importance features that were NOT hypothesized
hypothesized_features = {h.get('feature_name') for h in hypotheses}
surprise_threshold = 0.05

surprises = [
    r for r in importance_results
    if r['feature'] not in hypothesized_features and r['importance'] >= surprise_threshold
]
surprises.sort(key=lambda x: x['importance'], reverse=True)

if surprises:
    print(f"Unexpected high-importance features: {[s['feature'] for s in surprises[:5]]}")
```

#### 4. Generate Recommendations

```python
# Recommendations based on findings
recommendations = []

if supported:
    top_supported = sorted(supported, key=lambda x: x['actual_importance'], reverse=True)
    top_feat = top_supported[0]['feature_name']
    recommendations.append(
        f"Build on confirmed feature `{top_feat}` — explore interaction terms with other top features"
    )

if rejected:
    top_rejected = sorted(rejected, key=lambda x: x['expected_importance'], reverse=True)
    recommendations.append(
        f"Revisit rejected hypotheses for `{top_rejected[0]['feature_name']}` — consider alternative encodings or pathway aggregations"
    )

if surprises:
    recommendations.append(
        f"Investigate unexpected high-importance feature `{surprises[0]['feature']}` — hypothesize mechanism next iteration"
    )

if needs_more_data:
    recommendations.append(
        f"Re-test `{needs_more_data[0]['feature_name']}` with larger sample or different model — partial signal detected"
    )
```

#### 5. Write Final Report

```python
os.makedirs('/workspace/output', exist_ok=True)

report = f"""# Scientific Analysis Report

## Executive Summary

- **Hypotheses tested:** {len(hypotheses)}
- **Supported:** {len(supported)} ({100*len(supported)//max(len(hypotheses),1)}%)
- **Rejected:** {len(rejected)} ({100*len(rejected)//max(len(hypotheses),1)}%)
- **Needs more data:** {len(needs_more_data)} ({100*len(needs_more_data)//max(len(hypotheses),1)}%)

"""

# --- Supported
if supported:
    report += "## Supported Hypotheses\n\n"
    report += "| Feature | Expected | Actual | Source |\n|---|---|---|---|\n"
    for h in sorted(supported, key=lambda x: x['actual_importance'], reverse=True):
        src = h.get('alzkb_source', '—')[:60]
        report += f"| `{h['feature_name']}` | {h['expected_importance']:.3f} | {h['actual_importance']:.4f} | {src} |\n"
    report += "\n"

# --- Needs more data
if needs_more_data:
    report += "## Inconclusive — Needs More Data\n\n"
    report += "| Feature | Expected | Actual | % of Expected |\n|---|---|---|---|\n"
    for h in needs_more_data:
        pct = f"{h['pct_of_expected']*100:.0f}%" if h.get('pct_of_expected') else "—"
        report += f"| `{h['feature_name']}` | {h['expected_importance']:.3f} | {h['actual_importance']:.4f} | {pct} |\n"
    report += "\n"

# --- Rejected
if rejected:
    report += "## Rejected Hypotheses\n\n"
    report += "| Feature | Expected | Actual | Reasoning |\n|---|---|---|---|\n"
    for h in rejected:
        reason = "Actual importance far below threshold — feature may be irrelevant or need re-encoding"
        report += f"| `{h['feature_name']}` | {h['expected_importance']:.3f} | {h['actual_importance']:.4f} | {reason} |\n"
    report += "\n"

# --- Top features
top_features = sorted(importance_results, key=lambda x: x['importance'], reverse=True)[:15]
report += "## Top 15 Features Discovered\n\n"
report += "| Rank | Feature | Importance |\n|---|---|---|\n"
for i, feat in enumerate(top_features, 1):
    report += f"| {i} | `{feat['feature']}` | {feat['importance']:.4f} |\n"
report += "\n"

# --- Surprises
if surprises:
    report += "## Unexpected High-Importance Features\n\n"
    report += "These features were not hypothesized but showed significant importance:\n\n"
    for s in surprises[:5]:
        report += f"- `{s['feature']}`: importance = {s['importance']:.4f} — investigate mechanism\n"
    report += "\n"

# --- Recommendations
report += "## Recommendations for Next Iteration\n\n"
for i, rec in enumerate(recommendations, 1):
    report += f"{i}. {rec}\n"

with open('/workspace/output/report.md', 'w') as f:
    f.write(report)

print("Saved: output/report.md")
print("SKILL_INVOKED: public:pipeline-validate")
```
