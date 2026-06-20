---
name: pipeline-analyze
description: Evaluate scientific hypotheses using appropriate statistical methods and predictive modeling while preserving standardized verdict outputs
when: use after hypotheses have been generated and cleaned data is available
visibility: public
tags: [pipeline, test, validate, statistics, ml, scientific]
author: system
version: 3.0.0
--------------

# Instructions

You are the hypothesis testing and validation phase of a scientific analysis pipeline.

Your responsibility is to evaluate each hypothesis using the most appropriate statistical methodology.

Predictive machine learning models may be used as supplementary evidence, but hypothesis verdicts must primarily be derived from effect sizes, uncertainty estimates, statistical significance, and appropriate domain-specific tests.

The output contract must remain unchanged:

| File                        | Description                |
| --------------------------- | -------------------------- |
| output/verdict_results.json | Per-hypothesis verdicts    |
| output/report.md            | Full scientific report     |

---

# Part 0 — Determine Evaluation Strategy

Before writing code, inspect each hypothesis.

Use the hypothesis_type field to select the primary evaluation method.

| hypothesis_type     | Primary Method                          |
| ------------------- | --------------------------------------- |
| feature_importance  | Permutation importance                  |
| predictive          | Cross-validated model + feature ranking |
| model_performance   | Cross-validated performance metrics     |
| biomarker           | Single-feature predictive evaluation    |
| risk_factor         | Logistic regression odds ratio          |
| protective_factor   | Logistic regression odds ratio          |
| subgroup            | Subgroup comparison                     |
| interaction_effect  | Interaction regression                  |
| pathway             | Gene/pathway aggregation                |
| causal              | Cannot establish causality              |
| feature_engineering | Requires manual feature creation        |

Predictive model feature importance should never be treated as proof of a scientific claim.

---

# Part 1 — Load Data and Hypotheses

```python
import os
import json
import re
import numpy as np
import pandas as pd

from scipy import stats

results = {}
verdicts = []
importance_table = {}
surprises = []

dataset_id = os.environ.get("DATASET_ID", "")
target_col = os.environ.get("TARGET_COLUMN")

if not target_col:
    raise ValueError(
        "TARGET_COLUMN environment variable must be supplied."
    )

df = pd.read_csv(
    f"/datasets/{dataset_id}/cleaned/data.csv"
)

if target_col not in df.columns:
    raise ValueError(
        f"Target column '{target_col}' not found."
    )

backend_url = os.environ.get(
    "BACKEND_URL",
    "http://host.docker.internal:8081"
)

task_content = os.environ.get("TASK", "")

hypotheses = []

try:
    import requests

    resp = requests.get(
        f"{backend_url}/api/hypotheses",
        timeout=10
    )

    all_hypotheses = resp.json().get(
        "hypotheses",
        []
    )

    marker = "**Hypothesis:**"

    if marker in task_content:
        hyp_text = (
            task_content
            .split(marker, 1)[1]
            .strip()
            .split("\n")[0]
            .strip()
        )

        hypotheses = [
            h for h in all_hypotheses
            if h.get(
                "hypothesis_text",
                ""
            ).strip() == hyp_text
        ]

    if not hypotheses:
        hypotheses = all_hypotheses

except Exception as e:
    print(
        f"Unable to load hypotheses: {e}"
    )

print(
    f"Loaded {len(df)} rows and {len(hypotheses)} hypotheses"
)
```

---

# Part 2 — Dataset Profiling

```python
dataset_summary = {
    "rows": len(df),
    "columns": len(df.columns),
    "missing_values":
        int(df.isna().sum().sum()),
    "target_column":
        target_col
}

y = df[target_col]

numeric_cols = (
    df.select_dtypes(
        include=[np.number]
    )
    .columns
    .tolist()
)

feature_cols = [
    c for c in numeric_cols
    if c != target_col
]

X = (
    df[feature_cols]
    .fillna(0)
)

if y.dtype == object:
    from sklearn.preprocessing import LabelEncoder

    le = LabelEncoder()

    y = le.fit_transform(y)

print(dataset_summary)
```

---

# Part 3 — Predictive Model Evidence

Predictive models provide supporting evidence only.

```python
from sklearn.model_selection import (
    RepeatedStratifiedKFold,
    cross_val_score,
    train_test_split
)

from sklearn.metrics import roc_auc_score

from sklearn.inspection import (
    permutation_importance
)

from xgboost import XGBClassifier

X_train, X_test, y_train, y_test = (
    train_test_split(
        X,
        y,
        test_size=0.2,
        stratify=y,
        random_state=42
    )
)

cv = RepeatedStratifiedKFold(
    n_splits=5,
    n_repeats=3,
    random_state=42
)

predictive_evidence = {}

try:

    xgb = XGBClassifier(
        n_estimators=300,
        max_depth=6,
        learning_rate=0.05,
        random_state=42,
        eval_metric="logloss",
        n_jobs=-1
    )

    cv_scores = cross_val_score(
        xgb,
        X,
        y,
        cv=cv,
        scoring="roc_auc"
    )

    xgb.fit(
        X_train,
        y_train
    )

    test_auc = roc_auc_score(
        y_test,
        xgb.predict_proba(X_test)[:,1]
    )

    perm = permutation_importance(
        xgb,
        X_test,
        y_test,
        n_repeats=20,
        random_state=42
    )

    predictive_evidence = {
        "cv_auc_mean":
            float(np.mean(cv_scores)),
        "cv_auc_std":
            float(np.std(cv_scores)),
        "test_auc":
            float(test_auc)
    }

    for feature, score in zip(
        feature_cols,
        perm.importances_mean
    ):
        importance_table[feature] = {
            "mean_importance":
                float(score)
        }

except Exception as e:
    print(
        f"Predictive model failed: {e}"
    )
```

---

# Part 4 — Statistical Testing Engine

Required imports:

```python
from statsmodels.stats.multitest import multipletests
import statsmodels.api as sm

all_p_values = []
pvalue_index = {}
```

For every hypothesis:

---

## Risk Factor / Protective Factor

```python
X_feat = sm.add_constant(
    X[[feature]]
)

model = sm.Logit(
    y,
    X_feat
).fit(disp=0)

coef = model.params[feature]

p = model.pvalues[feature]

ci = model.conf_int().loc[feature]

or_value = np.exp(coef)

ci_lower = np.exp(ci[0])

ci_upper = np.exp(ci[1])
```

Evidence:

```text
OR
95% CI
p-value
```

Verdict:

Supported if:

* risk_factor:
  OR > 1 and p < 0.05

* protective_factor:
  OR < 1 and p < 0.05

---

## Biomarker

Train logistic regression using only the biomarker.

Use:

```python
RepeatedStratifiedKFold
```

Compute:

```python
mean_auc
95% confidence interval
```

Supported when:

```python
lower_ci > threshold
```

---

## Model Performance

Evaluate:

```python
cross validated AUC
```

Compute:

```python
mean_auc
std_auc
95% CI
```

Supported if:

```python
lower_ci > expected_threshold
```

---

## Predictive

Use:

```python
permutation_importance
```

Evaluate:

```python
feature rank
importance distribution
```

Supported when feature remains consistently important across folds.

---

## Feature Importance

Use:

```python
permutation_importance
```

Never use:

```python
xgb.feature_importances_
```

Supported when:

```python
importance > 0
and
confidence interval excludes zero
```

---

## Interaction Effect

Fit:

```python
y ~ A + B + A*B
```

Evaluate:

```python
interaction coefficient
confidence interval
p-value
```

Supported if:

```python
p < 0.05
```

---

## Subgroup

Require:

```json
{
  "subgroup_column":"...",
  "subgroup_value":"..."
}
```

Compare:

```python
overall effect
subgroup effect
```

Supported when subgroup effect differs significantly.

---

## Pathway

If pathway definitions unavailable:

```python
verdict = "needs_more_data"
```

Otherwise:

```python
aggregate pathway importance
or
enrichment statistics
```

---

## Causal

Always:

```python
verdict = "needs_more_data"
```

Reasoning:

```text
Observational predictive modeling cannot establish causality.
```

---

## Feature Engineering

Always:

```python
verdict = "needs_more_data"
```

Reasoning:

```text
Requires new feature construction.
```

---

# Part 5 — Multiple Testing Correction

After collecting all hypothesis p-values:

```python
adjusted = multipletests(
    all_p_values,
    method="fdr_bh"
)[1]
```

Attach:

```python
adjusted_p
```

to each hypothesis.

Final verdicts must use adjusted p-values whenever available.

---

# Part 6 — Discover Surprising Features

```python
surprise_threshold = 0.01

hypothesized = {
    h.get("feature_name")
    for h in hypotheses
    if h.get("feature_name")
}

surprises = []

for feature, vals in importance_table.items():

    score = vals["mean_importance"]

    if (
        feature not in hypothesized
        and score >= surprise_threshold
    ):
        surprises.append(
            {
                "feature": feature,
                "importance": score
            }
        )

surprises.sort(
    key=lambda x: x["importance"],
    reverse=True
)
```

---

# Part 7 — Verdict Construction

Keep schema unchanged.

```python
record = {
    "hypothesis_id":
        h.get("hypothesis_id",""),

    "verdict":
        verdict,

    "actual_importance":
        observed_value,

    "reasoning":
        reasoning
}
```

Allowed verdicts:

```text
supported
rejected
needs_more_data
```

Guidelines:

supported:
statistically significant
effect present

rejected:
statistically significant null result

needs_more_data:
insufficient power
unavailable metadata
causal claim
feature engineering claim
wide confidence interval

---

# Part 8 — Recommendations

Generate recommendations from:

1. strongest supported findings
2. inconclusive findings
3. unexpected features
4. model limitations

Recommendations should cite:

* effect size
* confidence interval
* uncertainty

not just feature importance.

---

# Part 9 — Save Outputs

The output contract remains unchanged.

## verdict_results.json

```json
[
  {
    "hypothesis_id":"123",
    "verdict":"supported",
    "actual_importance":0.14,
    "reasoning":"OR=1.82, 95%CI=[1.32,2.51], adjusted p=0.002"
  }
]
```

## report.md

Include:

* hypothesis summary
* hypothesis verdict
* reasoning
* surprising features
* recommendations

Never claim causality from predictive modeling. Use the knowledge graph to support your findings.