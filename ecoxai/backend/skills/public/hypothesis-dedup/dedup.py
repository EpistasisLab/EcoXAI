"""hypothesis-dedup — detect duplicate hypotheses at generation time.

Two layers:
  1) EXACT match (deterministic, no network): normalized text identical to an existing
     hypothesis or to another candidate already kept in this batch.
  2) COSINE similarity (semantic): query the backend's vector index
     (GET /api/hypotheses/similar) and drop a candidate whose nearest STORED hypothesis
     has cosine `similarity >= threshold`.

Used by pipeline-hypothesize: it imports `dedupe(...)` and posts only the survivors.
Only dependency: `requests` (present in the agent image). Network failures never block —
a candidate is kept if its similarity check can't run.
"""
from __future__ import annotations
import requests


def normalize(text: str) -> str:
    """Lowercase + collapse all whitespace — the key for exact-match comparison."""
    return " ".join((text or "").lower().split())


def _top_similarity(text: str, backend_url: str, k: int) -> float:
    """Cosine similarity of `text` to its nearest already-stored hypothesis (0 if none/failed)."""
    try:
        r = requests.get(f"{backend_url}/api/hypotheses/similar",
                         params={"q": text, "k": k}, timeout=10)
        top = r.json().get("hypotheses") or []
        return float(top[0]["similarity"]) if top else 0.0
    except Exception:
        return 0.0          # check failed → treat as not-duplicate (never block)


def dedupe(hypotheses, existing_texts, backend_url, *, threshold: float = 0.85, k: int = 5) -> dict:
    """Filter `hypotheses` (list of dicts with 'hypothesis_text') against duplicates.

    Compares against BOTH already-stored hypotheses (`existing_texts` + the cosine index)
    and the other candidates in this batch.

    Returns {"kept": [hypothesis, ...], "dropped": [{"text","reason","similarity"}, ...]}.
      reason ∈ {"exact", "cosine"}.
    """
    existing_norm = {normalize(t) for t in (existing_texts or [])}
    kept, dropped, seen_norm = [], [], set()

    for h in hypotheses:
        text = h.get("hypothesis_text", "")
        n = normalize(text)

        # ── Layer 1: exact (vs existing + vs already-kept candidates) ──
        if n in existing_norm or n in seen_norm:
            dropped.append({"text": text, "reason": "exact", "similarity": 1.0})
            continue

        # ── Layer 2: cosine (vs stored hypotheses) ──
        sim = _top_similarity(text, backend_url, k)
        if sim >= threshold:
            dropped.append({"text": text, "reason": "cosine", "similarity": round(sim, 4)})
            continue

        seen_norm.add(n)
        kept.append(h)

    return {"kept": kept, "dropped": dropped}


if __name__ == "__main__":
    # tiny self-demo (exact layer only; cosine needs a running backend)
    cands = [{"hypothesis_text": "APOE is a risk factor"},
             {"hypothesis_text": "apoe IS  a risk factor"},   # exact dup (normalized)
             {"hypothesis_text": "TREM2 is a biomarker"}]
    out = dedupe(cands, existing_texts=[], backend_url="http://localhost:8081", threshold=2.0)  # threshold>1 disables cosine
    print("kept:", [h["hypothesis_text"] for h in out["kept"]])
    print("dropped:", out["dropped"])
