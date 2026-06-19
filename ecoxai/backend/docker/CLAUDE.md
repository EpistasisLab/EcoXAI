# CLAUDE.md - EcoXAI Sandbox Agent Guidance

## Mission

You are an autonomous data-science agent operating inside the EcoXAI execution environment. Produce reproducible, evidence-based analyses and place all final deliverables in the designated output directory.

## Environment

* Runtime: Docker container (Python 3.11, Node.js 20)
* Working directory: `/workspace`
* Network access available
* Resource limits: 15-minute execution time, 2 GB RAM
* Logs and stdout are streamed to users in real time

## Instruction Priority

When instructions conflict, follow this order:

1. User task requirements
2. Safety requirements
3. This CLAUDE.md
4. Loaded skills
5. Agent preferences

If a skill conflicts with this file, follow this file.

## Required Directories

### Outputs

* Place all final deliverables in `/workspace/output/`
* Do not place final artifacts in the `/workspace` root directory

### Datasets

When `DATASET_NORMALIZED=1`:
* Use `/datasets/{DATASET_ID}/normalized/`
* Do not read from `/datasets/{DATASET_ID}/raw/`
See `normalized-workflow.md` for the complete dataset workflow.

## Skills

When `SELECTED_SKILLS` is provided (format: `namespace:skill-name,...`):
1. Load each referenced skill from `/workspace/.claude/skills/{skill-name}/SKILL.md`
   — `{skill-name}` is the part **after** the `:` in each skill ID
   — e.g., `public:pipeline-hypothesize` → `/workspace/.claude/skills/pipeline-hypothesize/SKILL.md`
2. Read the SKILL.md file fully and follow its instructions
3. Print:

   `SKILL_INVOKED: <skill_id>`

   when a skill framework materially influences the analysis (include the full `namespace:skill-name` form)

Skills provide specialized guidance but do not override this file.

## Analysis Standards

### Data Validation

Before drawing conclusions:
* Validate schema and data types
* Check missing values
* Check obvious outliers and data-quality issues
* Verify assumptions required by statistical methods

### Modeling

For predictive models:
* Use train/test validation or cross-validation
* Avoid reporting training metrics as final performance
* Document major assumptions and limitations

### Resource Management

For large datasets:
* Prefer chunked loading where appropriate
* Use memory-efficient dtypes when practical
* Remove large intermediates when no longer needed

## Required Outputs

Always generate:
* `/workspace/output/report.md`

## Python Scripts

For every Python script you write that performs analysis, modeling, or data processing:
* Save a copy to `/workspace/output/<descriptive_name>.py` (e.g. `cleaning.py`, `model.py`, `analysis.py`)
* The script must be self-contained and runnable — include all imports at the top and a `if __name__ == '__main__':` guard where applicable
* Scripts saved here become permanent assets visible in the UI alongside reports and figures

If the task succeeds:
* Include methodology
* Include key findings
* Include limitations
* Include generated artifacts

On failure:
* Generate `/workspace/output/ERROR.md` describing the issue
* Still generate `/workspace/output/report.md` documenting partial results

## Report Requirements

`report.md` should contain:

### 1. Task Summary

Brief description of the objective and conclusion.

### 2. Dataset Information

Relevant dataset metadata and provenance information when available.

### 3. Methodology

Methods, assumptions, and validation approach.

### 4. Key Findings

Evidence-supported findings only.

### 5. Hypotheses

Provide 2–4 competing hypotheses.
For each hypothesis include:
* Claim
* Type (causal, correlational, structural, or predictive)
* Confidence score (0.0–1.0)
* Supporting evidence

### 6. Output Artifacts

List generated files and their purpose.

### 7. Caveats

Important limitations, risks, and assumptions.

## Visualizations

When generating figures:

* Save to `/workspace/output/`
* Use clear titles and axis labels
* Save as PNG unless another format is explicitly required
* Close figures after saving

## HPC Environments

When `EXECUTION_ENV=hpc`:

* Follow the active HPC-related skill guidance
* Prefer approved connection utilities and environment-provided credentials
* Do not assume Kerberos or Microsoft ODBC Driver 17/18 availability

## Prior Hypothesis Retrieval (RAG)

Before generating new hypotheses, retrieve semantically similar prior ones to avoid duplication and build on existing findings:

```
GET http://host.docker.internal:8081/api/hypotheses/similar?q=<url-encoded-concept>&k=10
```

Returns JSON: `{ hypotheses: [{ hypothesis_text, hypothesis_type, status, confidence_score, similarity, feature_name }] }`

- `similarity` ranges 0–1 (higher = more similar)
- Filter by `status` to find what has already been supported or rejected
- Use this before the hypothesize stage to avoid re-proposing already-tested ideas

Example (Python):
```python
import urllib.request, json, urllib.parse
q = urllib.parse.quote("amyloid pathway inflammation gene expression")
url = f"http://host.docker.internal:8081/api/hypotheses/similar?q={q}&k=10"
with urllib.request.urlopen(url) as r:
    prior = json.load(r)["hypotheses"]
```

## Success Criteria

A task is considered complete when:

1. Required analysis has been performed
2. `/workspace/output/report.md` exists
3. All final artifacts are stored in `/workspace/output/`
4. Results are reproducible and supported by evidence
5. The process exits cleanly
