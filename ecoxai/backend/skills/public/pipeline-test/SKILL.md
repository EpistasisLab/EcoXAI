---
name: pipeline-test
description: Train ML models, compute feature importances, and test each hypothesis against measured results
when: use when running the hypothesis testing phase after hypotheses have been generated
visibility: public
tags: [pipeline, test, ml, feature-importance, sklearn, xgboost]
author: system
version: 1.0.0
---

## Instructions

You are the testing phase of a scientific analysis pipeline. Your job is to train ML models, measure actual feature importances, and compare each hypothesis's predicted importance against measured values.

### Required Outputs

| File | Description |
|---|---|
| `output/feature_importance_results.json` | Per-feature importance scores from each model |
| `output/test_results.md` | Per-hypothesis verdict with evidence |

### Steps

#### 1. Load Data and Hypotheses

```python
import pandas as pd
import numpy as np
import json
import os

# Load cleaned data from explore phase
df = pd.read_csv('/workspace/output/cleaned_data.csv')

# Load hypotheses if available from previous phase
hypotheses = []
hyp_path = '/workspace/output/next_hypothesis.json'
if os.path.exists(hyp_path):
    with open(hyp_path) as f:
        hyp_data = json.load(f)
    hypotheses = hyp_data.get('hypotheses', [])

print(f"Testing {len(hypotheses)} hypotheses on {df.shape[0]} rows × {df.shape[1]} columns")
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

# Encode target if categorical
from sklearn.preprocessing import LabelEncoder
if y.dtype == 'object':
    le = LabelEncoder()
    y = le.fit_transform(y)

print(f"Target: {target_col} ({len(np.unique(y))} classes)")
print(f"Features: {len(feature_cols)}")
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
# Average importance across models
all_models = list(results.keys())
importance_table = {}

for feat in feature_cols:
    scores = [results[m]['importances'].get(feat, 0.0) for m in all_models]
    importance_table[feat] = {
        'mean_importance': float(np.mean(scores)),
        'max_importance': float(np.max(scores)),
        'by_model': {m: results[m]['importances'].get(feat, 0.0) for m in all_models}
    }

# Sort by mean importance
sorted_features = sorted(importance_table.items(), key=lambda x: x[1]['mean_importance'], reverse=True)
top_features = sorted_features[:20]

print("\nTop 10 features:")
for feat, scores in top_features[:10]:
    print(f"  {feat}: {scores['mean_importance']:.4f}")
```

#### 5. Test Each Hypothesis

```python
verdicts = []

for h in hypotheses:
    feat = h.get('feature_name', '')
    expected = h.get('expected_importance', 0.0)
    actual = importance_table.get(feat, {}).get('mean_importance', 0.0)

    if actual >= expected:
        verdict = 'supported'
    elif actual >= expected * 0.5:
        verdict = 'needs_more_data'
    else:
        verdict = 'rejected'

    verdicts.append({
        'hypothesis_text': h.get('hypothesis_text', ''),
        'feature_name': feat,
        'expected_importance': expected,
        'actual_importance': round(actual, 4),
        'verdict': verdict,
        'delta': round(actual - expected, 4)
    })

    print(f"  [{verdict.upper()}] {feat}: expected {expected:.3f}, actual {actual:.4f}")
```

#### 6. Save Outputs

```python
os.makedirs('/workspace/output', exist_ok=True)

# feature_importance_results.json
importance_output = [
    {'feature': feat, 'importance': scores['mean_importance'], 'model': 'ensemble_mean'}
    for feat, scores in sorted_features
]
with open('/workspace/output/feature_importance_results.json', 'w') as f:
    json.dump(importance_output, f, indent=2)

# test_results.md
report = f"""# Hypothesis Test Results

## Model Performance

| Model | AUC (mean ± std) |
|---|---|
"""
for model_name, model_data in results.items():
    report += f"| {model_name} | {model_data['auc_mean']:.3f} ± {model_data['auc_std']:.3f} |\n"

report += f"""
## Hypothesis Verdicts

| Feature | Expected | Actual | Verdict |
|---|---|---|---|
"""
for v in verdicts:
    report += f"| `{v['feature_name']}` | {v['expected_importance']:.3f} | {v['actual_importance']:.4f} | **{v['verdict']}** |\n"

report += f"""
## Top 20 Features by Importance

| Rank | Feature | Mean Importance |
|---|---|---|
"""
for i, (feat, scores) in enumerate(top_features[:20], 1):
    report += f"| {i} | `{feat}` | {scores['mean_importance']:.4f} |\n"

with open('/workspace/output/test_results.md', 'w') as f:
    f.write(report)

print("Saved: output/feature_importance_results.json, output/test_results.md")
print("SKILL_INVOKED: public:pipeline-test")
```
