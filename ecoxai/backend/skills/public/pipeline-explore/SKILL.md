---
name: pipeline-explore
description: Profile dataset structure, clean data quality issues, and produce exploration artifacts for downstream analysis
when: use when running the exploration phase on a normalized dataset
visibility: public
tags: [pipeline, explore, cleaning, eda, profiling]
author: system
version: 1.0.0
---

## Instructions

You are the exploration phase of a scientific analysis pipeline. Your job is to deeply understand the dataset, fix data quality issues, and produce clean artifacts that downstream hypothesis and testing agents can rely on.

### Required Outputs

| File | Description |
|---|---|
| `output/cleaned_data.csv` | Cleaned, analysis-ready data table |
| `output/exploration_report.md` | Findings, quality issues, column descriptions |

### Steps

#### 1. Load Dataset and Normalization Context

```python
import pandas as pd
import numpy as np
import json
import os
import glob

dataset_id = os.environ.get('DATASET_ID', '')
domain = os.environ.get('DATASET_DOMAIN', 'unknown')
base = f'/datasets/{dataset_id}/normalized'

# Read semantic context first
with open(f'{base}/semantic.json') as f:
    semantic = json.load(f)

entities = semantic.get('entities', [])
units = semantic.get('units', {})

# Discover all table CSVs (table_1.csv, table_2.csv, ...)
table_files = sorted(glob.glob(f'{base}/tables/table_*.csv'))
if not table_files:
    raise FileNotFoundError(f"No table CSVs found in {base}/tables/")

# Load all tables
tables = {os.path.basename(f).replace('.csv', ''): pd.read_csv(f) for f in table_files}
df = tables[list(tables.keys())[0]]   # primary table for cleaning/profiling
print(f"Found {len(tables)} table(s): {list(tables.keys())}")
print(f"Primary table: {df.shape[0]} rows × {df.shape[1]} columns")
```

#### 2. Profile the Data

```python
# Basic statistics
profile = {
    'shape': df.shape,
    'dtypes': df.dtypes.astype(str).to_dict(),
    'missing_counts': df.isnull().sum().to_dict(),
    'missing_pct': (df.isnull().mean() * 100).round(2).to_dict(),
    'duplicates': int(df.duplicated().sum()),
    'numeric_stats': df.describe().to_dict()
}

# Identify columns by type
numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
categorical_cols = df.select_dtypes(include=['object', 'category']).columns.tolist()

print(f"Numeric: {len(numeric_cols)}, Categorical: {len(categorical_cols)}")
print(f"Missing: {sum(profile['missing_counts'].values())} total cells")
print(f"Duplicates: {profile['duplicates']}")
```

#### 3. Clean the Data

```python
df_clean = df.copy()

# Remove exact duplicates
df_clean.drop_duplicates(inplace=True)

# Impute missing — numeric: median, categorical: mode
for col in numeric_cols:
    if df_clean[col].isnull().any():
        median_val = df_clean[col].median()
        df_clean[col].fillna(median_val, inplace=True)

for col in categorical_cols:
    if df_clean[col].isnull().any():
        mode_val = df_clean[col].mode()
        fill = mode_val[0] if not mode_val.empty else 'Unknown'
        df_clean[col].fillna(fill, inplace=True)

# Cap outliers using IQR (genomics/clinical data — preserve biological extremes cautiously)
for col in numeric_cols:
    Q1, Q3 = df_clean[col].quantile(0.25), df_clean[col].quantile(0.75)
    IQR = Q3 - Q1
    lower, upper = Q1 - 3 * IQR, Q3 + 3 * IQR  # 3×IQR for biological data
    df_clean[col] = df_clean[col].clip(lower, upper)

print(f"After cleaning: {df_clean.shape[0]} rows (removed {len(df) - len(df_clean)} rows)")
```

#### 4. Identify Target Variable

```python
# Try to infer the target column (last column, or named outcome/label/target/diagnosis)
target_candidates = [c for c in df_clean.columns
                     if any(kw in c.lower() for kw in ['target', 'label', 'outcome', 'diagnosis', 'class', 'y'])]
target_col = target_candidates[0] if target_candidates else df_clean.columns[-1]

print(f"Likely target column: {target_col}")
if df_clean[target_col].nunique() < 20:
    print(f"Target distribution:\n{df_clean[target_col].value_counts()}")
```

#### 5. Save Outputs

```python
import os

os.makedirs('/workspace/output', exist_ok=True)

# Save cleaned data
df_clean.to_csv('/workspace/output/cleaned_data.csv', index=False)

# Write exploration report
report = f"""# Exploration Report

## Dataset Overview
- **Dataset ID:** {dataset_id}
- **Domain:** {domain}
- **Original shape:** {df.shape[0]} rows × {df.shape[1]} columns
- **After cleaning:** {df_clean.shape[0]} rows × {df_clean.shape[1]} columns
- **Entities identified:** {', '.join(entities) if entities else 'none'}

## Sheets / Tables
| Table | Rows | Columns |
|---|---|---|
"""
for tname, tdf in tables.items():
    report += f"| {tname} | {tdf.shape[0]} | {tdf.shape[1]} |\n"
report += f"""

## Data Quality

| Issue | Count |
|---|---|
| Missing values (original) | {sum(profile['missing_counts'].values())} |
| Duplicate rows | {profile['duplicates']} |

### Missing Values by Column
"""
for col, pct in profile['missing_pct'].items():
    if pct > 0:
        report += f"- `{col}`: {pct}% missing\n"

report += f"""
## Column Summary

### Numeric Columns ({len(numeric_cols)})
"""
for col in numeric_cols:
    stats = df_clean[col].describe()
    report += f"- `{col}`: mean={stats['mean']:.3f}, std={stats['std']:.3f}, range=[{stats['min']:.3f}, {stats['max']:.3f}]\n"

report += f"""
### Categorical Columns ({len(categorical_cols)})
"""
for col in categorical_cols:
    report += f"- `{col}`: {df_clean[col].nunique()} unique values\n"

report += f"""
## Inferred Target
- **Column:** `{target_col}`
- **Type:** {'categorical' if df_clean[target_col].nunique() < 20 else 'continuous'}

## Cleaning Operations Applied
- Removed duplicate rows
- Imputed missing numeric values with column median
- Imputed missing categorical values with column mode
- Capped extreme outliers at 3×IQR bounds

## Recommended Next Step
Generate feature importance hypotheses using the domain context and entity list above.
"""

with open('/workspace/output/exploration_report.md', 'w') as f:
    f.write(report)

print("Saved: output/cleaned_data.csv, output/exploration_report.md")
print("SKILL_INVOKED: public:pipeline-explore")
```
