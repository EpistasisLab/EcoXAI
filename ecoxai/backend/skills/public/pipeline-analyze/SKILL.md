---
name: pipeline-analyze
description: Train ML models, test hypotheses against feature importances, discover surprises, and produce the final scientific report — all in one pass
when: use when running the combined test-and-validate phase after hypotheses have been generated
visibility: public
tags: [pipeline, test, validate, report, ml, feature-importance, sklearn, scientific]
author: system
version: 1.0.0
---

## Instructions

You are the combined testing and validation phase of a scientific analysis pipeline. Train ML models, measure actual feature importances, score each hypothesis, discover unexpected findings, and produce a final scientific report — in a single pass with full context.

### Required Outputs

| File | Description |
|---|---|
| `output/feature_importance_results.json` | Per-feature importance scores (used by the hypothesis tracking system) |
| `output/test_results.md` | Per-hypothesis verdict table with evidence |
| `output/report.md` | Comprehensive scientific report with recommendations |

---

### Part 1 — Train Models & Compute Feature Importances

#### 1. Load Data and Hypotheses

```python
import pandas as pd
import numpy as np
import json
import os

# Load cleaned data from explore phase
df = pd.read_csv('/workspace/output/cleaned_data.csv')

# Load hypothesis — match task hypothesis text against next_hypothesis.json
hypotheses = []
task_content = os.environ.get('TASK', '')
hyp_path = '/workspace/output/next_hypothesis.json'
if os.path.exists(hyp_path):
    with open(hyp_path) as f:
        all_hyps = json.load(f).get('hypotheses', [])
    try:
        marker = '**Hypothesis:**'
        if marker in task_content:
            hyp_text = task_content.split(marker, 1)[1].strip().split('\n')[0].strip()
            hypotheses = [h for h in all_hyps if h.get('hypothesis_text', '').strip() == hyp_text]
    except Exception:
        pass
    if not hypotheses:
        hypotheses = all_hyps

print(f"Loaded {df.shape[0]} rows × {df.shape[1]} columns, {len(hypotheses)} hypotheses")
```

#### 2. Identify Features and Target

```python
# Infer target column
target_candidates = [c for c in df.columns
                     if any(kw in c.lower() for kw in ['target', 'label', 'outcome', 'diagnosis', 'class', 'y'])]
target_col = target_candidates[0] if target_candidates else df.columns[-1]

# Feature columns: all numeric except target
feature_cols = [c for c in df.select_dtypes(include=[np.number]).columns if c != target_col]

X = df[feature_cols].fillna(0)
y = df[target_col]

from sklearn.preprocessing import LabelEncoder
if y.dtype == 'object':
    le = LabelEncoder()
    y = le.fit_transform(y)

print(f"Target: {target_col} ({len(np.unique(y))} classes), Features: {len(feature_cols)}")
```

#### 3. Train Models

```python
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.model_selection import cross_val_score, StratifiedKFold

cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
results = {}

# Random Forest
rf = RandomForestClassifier(n_estimators=200, max_depth=10, random_state=42, n_jobs=-1)
rf_scores = cross_val_score(rf, X, y, cv=cv, scoring='roc_auc')
rf.fit(X, y)
results['RandomForest'] = {
    'importances': dict(zip(feature_cols, rf.feature_importances_.tolist())),
    'auc_mean': float(rf_scores.mean()),
    'auc_std': float(rf_scores.std())
}
print(f"RandomForest AUC: {rf_scores.mean():.3f} ± {rf_scores.std():.3f}")

# Gradient Boosting
try:
    gb = GradientBoostingClassifier(n_estimators=100, max_depth=4, random_state=42)
    gb_scores = cross_val_score(gb, X, y, cv=cv, scoring='roc_auc')
    gb.fit(X, y)
    results['GradientBoosting'] = {
        'importances': dict(zip(feature_cols, gb.feature_importances_.tolist())),
        'auc_mean': float(gb_scores.mean()),
        'auc_std': float(gb_scores.std())
    }
    print(f"GradientBoosting AUC: {gb_scores.mean():.3f} ± {gb_scores.std():.3f}")
except Exception as e:
    print(f"GradientBoosting failed: {e}")
```

#### 4. Aggregate Feature Importances

```python
all_models = list(results.keys())
importance_table = {}

for feat in feature_cols:
    scores = [results[m]['importances'].get(feat, 0.0) for m in all_models]
    importance_table[feat] = {
        'mean_importance': float(np.mean(scores)),
        'max_importance': float(np.max(scores)),
        'by_model': {m: results[m]['importances'].get(feat, 0.0) for m in all_models}
    }

sorted_features = sorted(importance_table.items(), key=lambda x: x[1]['mean_importance'], reverse=True)
top_features = sorted_features[:20]

print("\nTop 10 features:")
for feat, scores in top_features[:10]:
    print(f"  {feat}: {scores['mean_importance']:.4f}")
```

---

### Part 2 — Score Hypotheses, Discover Surprises, Write Report

#### 5. Score Each Hypothesis

```python
verdicts = []
supported = []
rejected = []
needs_more_data = []

for h in hypotheses:
    feat = h.get('feature_name', '')
    expected = h.get('expected_importance', 0.0)
    actual = importance_table.get(feat, {}).get('mean_importance', 0.0)
    source = h.get('alzkb_source', '')

    if actual >= expected:
        verdict = 'supported'
    elif actual >= expected * 0.5:
        verdict = 'needs_more_data'
    else:
        verdict = 'rejected'

    record = {
        **h,
        'actual_importance': round(actual, 4),
        'delta': round(actual - expected, 4),
        'pct_of_expected': round(actual / expected, 2) if expected > 0 else None,
        'verdict': verdict,
    }
    verdicts.append(record)
    if verdict == 'supported':
        supported.append(record)
    elif verdict == 'needs_more_data':
        needs_more_data.append(record)
    else:
        rejected.append(record)

    print(f"  [{verdict.upper()}] {feat}: expected {expected:.3f}, actual {actual:.4f}")

print(f"\nSupported: {len(supported)}, Needs more data: {len(needs_more_data)}, Rejected: {len(rejected)}")
```

#### 6. Discover Surprising Features

```python
hypothesized_features = {h.get('feature_name') for h in hypotheses}
surprise_threshold = 0.05

surprises = [
    {'feature': feat, 'importance': scores['mean_importance']}
    for feat, scores in sorted_features
    if feat not in hypothesized_features and scores['mean_importance'] >= surprise_threshold
]
surprises.sort(key=lambda x: x['importance'], reverse=True)

if surprises:
    print(f"Unexpected high-importance features: {[s['feature'] for s in surprises[:5]]}")
```

#### 7. Generate Recommendations

```python
recommendations = []

if supported:
    top_feat = sorted(supported, key=lambda x: x['actual_importance'], reverse=True)[0]['feature_name']
    recommendations.append(
        f"Build on confirmed feature `{top_feat}` — explore interaction terms with other top features"
    )

if rejected:
    top_rej = sorted(rejected, key=lambda x: x['expected_importance'], reverse=True)[0]['feature_name']
    recommendations.append(
        f"Revisit rejected hypothesis for `{top_rej}` — consider alternative encodings or pathway aggregations"
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

#### 8. Save All Outputs

```python
os.makedirs('/workspace/output', exist_ok=True)

# feature_importance_results.json (consumed by hypothesis tracking system — do not rename)
importance_output = [
    {'feature': feat, 'importance': scores['mean_importance'], 'model': 'ensemble_mean'}
    for feat, scores in sorted_features
]
with open('/workspace/output/feature_importance_results.json', 'w') as f:
    json.dump(importance_output, f, indent=2)

# test_results.md
test_report = f"""# Hypothesis Test Results

## Model Performance

| Model | AUC (mean ± std) |
|---|---|
"""
for model_name, model_data in results.items():
    test_report += f"| {model_name} | {model_data['auc_mean']:.3f} ± {model_data['auc_std']:.3f} |\n"

test_report += f"""
## Hypothesis Verdicts

| Feature | Expected | Actual | Verdict |
|---|---|---|---|
"""
for v in verdicts:
    test_report += f"| `{v['feature_name']}` | {v['expected_importance']:.3f} | {v['actual_importance']:.4f} | **{v['verdict']}** |\n"

test_report += f"""
## Top 20 Features by Importance

| Rank | Feature | Mean Importance |
|---|---|---|
"""
for i, (feat, scores) in enumerate(top_features[:20], 1):
    test_report += f"| {i} | `{feat}` | {scores['mean_importance']:.4f} |\n"

with open('/workspace/output/test_results.md', 'w') as f:
    f.write(test_report)

# report.md — full scientific report
report = f"""# Scientific Analysis Report

## Executive Summary

- **Hypotheses tested:** {len(hypotheses)}
- **Supported:** {len(supported)} ({100*len(supported)//max(len(hypotheses),1)}%)
- **Rejected:** {len(rejected)} ({100*len(rejected)//max(len(hypotheses),1)}%)
- **Needs more data:** {len(needs_more_data)} ({100*len(needs_more_data)//max(len(hypotheses),1)}%)

## Model Performance

| Model | AUC (mean ± std) |
|---|---|
"""
for model_name, model_data in results.items():
    report += f"| {model_name} | {model_data['auc_mean']:.3f} ± {model_data['auc_std']:.3f} |\n"

if supported:
    report += "\n## Supported Hypotheses\n\n"
    report += "| Feature | Expected | Actual | Source |\n|---|---|---|---|\n"
    for h in sorted(supported, key=lambda x: x['actual_importance'], reverse=True):
        src = h.get('alzkb_source', '—')[:60]
        report += f"| `{h['feature_name']}` | {h['expected_importance']:.3f} | {h['actual_importance']:.4f} | {src} |\n"

if needs_more_data:
    report += "\n## Inconclusive — Needs More Data\n\n"
    report += "| Feature | Expected | Actual | % of Expected |\n|---|---|---|---|\n"
    for h in needs_more_data:
        pct = f"{h['pct_of_expected']*100:.0f}%" if h.get('pct_of_expected') else "—"
        report += f"| `{h['feature_name']}` | {h['expected_importance']:.3f} | {h['actual_importance']:.4f} | {pct} |\n"

if rejected:
    report += "\n## Rejected Hypotheses\n\n"
    report += "| Feature | Expected | Actual | Reasoning |\n|---|---|---|---|\n"
    for h in rejected:
        report += f"| `{h['feature_name']}` | {h['expected_importance']:.3f} | {h['actual_importance']:.4f} | Actual importance far below threshold |\n"

top15 = sorted(importance_output, key=lambda x: x['importance'], reverse=True)[:15]
report += "\n## Top 15 Features Discovered\n\n"
report += "| Rank | Feature | Importance |\n|---|---|---|\n"
for i, feat in enumerate(top15, 1):
    report += f"| {i} | `{feat['feature']}` | {feat['importance']:.4f} |\n"

if surprises:
    report += "\n## Unexpected High-Importance Features\n\n"
    report += "These features were not hypothesized but showed significant importance:\n\n"
    for s in surprises[:5]:
        report += f"- `{s['feature']}`: importance = {s['importance']:.4f} — investigate mechanism\n"

report += "\n## Recommendations for Next Iteration\n\n"
for i, rec in enumerate(recommendations, 1):
    report += f"{i}. {rec}\n"

with open('/workspace/output/report.md', 'w') as f:
    f.write(report)

print("Saved: feature_importance_results.json, test_results.md, report.md")
print("SKILL_INVOKED: public:pipeline-analyze")
```
