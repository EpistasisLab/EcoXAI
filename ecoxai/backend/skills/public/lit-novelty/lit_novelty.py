"""lit_novelty — literature-novelty scoring for genes, bundled as a self-contained
EcoXAI skill module.

This is the SAME `lit_novelty` measure as in
`docs/papers/Paul_recommendations/scripts/01_dyport_eval.py` (and its supporting
`utils/litsources.py`, `utils/pubmed.py`, `utils/dyport_importance.py`), copied here
VERBATIM in behaviour but with **zero `utils.*` imports** so the file runs standalone
inside the EcoXAI agent container (ships at /workspace/.claude/skills/lit-novelty/).

Definition (unchanged):
    lit_novelty(signal_values) = 1 − percentile_rank(signal_values)
where `signal_values` are multi-source literature co-mention counts of each gene with
the disease (default "Alzheimer"). Genes the literature talks about LESS score higher;
genes with 0 co-mentions land at the top. The score is RELATIVE — computed over the
given gene set (percentile rank), exactly as the original.

Only deps: numpy, scipy, requests (all present in docker/Dockerfile.agent).

Public entry point:
    score_genes(genes, disease="Alzheimer") -> {gene: lit_novelty_score in [0,1]}
"""
from __future__ import annotations
import json
import os
import time
import numpy as np
import requests

# ── endpoints (verbatim from utils/litsources.py + utils/pubmed.py) ──────────
EUROPEPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
OPENALEX = "https://api.openalex.org/works"
S2 = "https://api.semanticscholar.org/graph/v1/paper/search"
ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"

# on-disk cache lives next to this module; all cache I/O is best-effort (never fatal)
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".lit_cache.json")


def _email():
    return os.getenv("NCBI_EMAIL") or "rene650962aca@gmail.com"


def _api_key():
    return os.getenv("NCBI_API_KEY")  # optional


# ── percentile rank (verbatim from utils/dyport_importance.py:pct_rank) ──────
def pct_rank(values):
    """Percentile rank in (0,1] — the eq. 9 component normaliser."""
    import scipy.stats as st
    v = np.asarray(values, dtype=float)
    if len(v) == 0:
        return v
    return st.rankdata(v, method="average") / len(v)


# ── the measure itself (verbatim from 01_dyport_eval.py:lit_novelty) ─────────
def lit_novelty(signal_values):
    """1 − percentile_rank(signal): genes the literature talks about LESS score
    higher. `signal_values` is e.g. co-mention counts (or citations). Genes with
    signal 0 (no literature at all) land at the top.

    This is the ONE novelty measure integrated into EcoXAI.
    """
    return 1.0 - pct_rank(signal_values)


# ── PubMed co-mention count (inlined from utils/pubmed.py) ────────────────────
def _esearch_count(term: str, email: str, api_key, sleep: float) -> int:
    params = {"db": "pubmed", "term": term, "retmax": 0, "retmode": "json",
              "tool": "ecoxai-dyport", "email": email}
    if api_key:
        params["api_key"] = api_key
    try:
        r = requests.get(ESEARCH, params=params, timeout=15)
        r.raise_for_status()
        cnt = int(r.json()["esearchresult"]["count"])
    except Exception:
        cnt = -1                      # signal error (treated as 0 by callers, but logged)
    time.sleep(sleep)
    return cnt


def _term(gene: str, disease: str, ymax=None) -> str:
    t = f'"{gene}"[tiab] AND {disease}[tiab]'
    if ymax is not None:
        t += f' AND ("1800/01/01"[PDAT] : "{ymax}/12/31"[PDAT])'
    return t


def comention_count(gene: str, disease: str = "Alzheimer", *, email=None, api_key=None, sleep=0.34) -> int:
    """Total PubMed records co-mentioning gene & disease."""
    c = _esearch_count(_term(gene, disease), email or _email(), api_key or _api_key(), sleep)
    return max(c, 0)


# ── per-source counters (verbatim from utils/litsources.py) ──────────────────
def _get_json(url, params, timeout=25, retries=2, sleep=0.34):
    """GET with small retry/backoff; returns parsed JSON or None on failure."""
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, params=params, timeout=timeout)
            r.raise_for_status()
            data = r.json()
            time.sleep(sleep)
            return data
        except Exception:
            time.sleep(sleep * (attempt + 2))      # backoff before retry
    return None


def europepmc_count(gene: str, disease: str = "Alzheimer", *, sleep: float = 0.34):
    """Co-mentions in title/abstract + full text + preprints (Europe PMC)."""
    params = {"query": f'"{gene}" AND {disease}', "format": "json",
              "resultType": "idlist", "pageSize": 1}
    d = _get_json(EUROPEPMC, params, sleep=sleep)
    return None if d is None else int(d.get("hitCount", 0))


def openalex_count(gene: str, disease: str = "Alzheimer", *, email=None, sleep: float = 0.34):
    """Co-mentions across OpenAlex works (broad: metadata + indexed full text)."""
    params = {"search": f"{gene} {disease}", "per-page": 1, "mailto": email or _email()}
    d = _get_json(OPENALEX, params, sleep=sleep)
    return None if d is None else int(d.get("meta", {}).get("count", 0))


def biorxiv_count(gene: str, disease: str = "Alzheimer", *, sleep: float = 0.34):
    """Co-mentions in PREPRINTS (bioRxiv/medRxiv etc.) via Europe PMC's preprint
    source filter (SRC:PPR)."""
    params = {"query": f'"{gene}" AND {disease} AND (SRC:PPR)', "format": "json",
              "resultType": "idlist", "pageSize": 1}
    d = _get_json(EUROPEPMC, params, sleep=sleep)
    return None if d is None else int(d.get("hitCount", 0))


def semanticscholar_count(gene: str, disease: str = "Alzheimer", *, sleep: float = 1.0):
    """Co-mentions in Semantic Scholar (optional; aggressive rate-limit → off by default)."""
    params = {"query": f"{gene} {disease}", "limit": 1}
    try:
        r = requests.get(S2, params=params, timeout=20)
        r.raise_for_status()
        n = int(r.json().get("total", 0))
    except Exception:
        n = None
    time.sleep(sleep)
    return n


def pubmed_count(gene: str, disease: str = "Alzheimer", **_):
    try:
        c = comention_count(gene, disease)
        return int(c) if c >= 0 else None
    except Exception:
        return None


_SOURCES = {
    "pubmed": pubmed_count,
    "europepmc": europepmc_count,
    "openalex": openalex_count,
    "biorxiv": biorxiv_count,
    "semanticscholar": semanticscholar_count,
}


# ── batch + cache (verbatim from utils/litsources.py, cache made best-effort) ─
def _load_cache() -> dict:
    try:
        if os.path.exists(_CACHE_FILE):
            with open(_CACHE_FILE) as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def _save_cache(c: dict):
    try:
        with open(_CACHE_FILE, "w") as f:
            json.dump(c, f, indent=0, ensure_ascii=False)
    except Exception:
        pass


def multi_counts(genes, disease: str = "Alzheimer", *, sources=("pubmed", "europepmc", "openalex"),
                 email=None, max_genes=None, verbose: bool = True) -> dict:
    """{gene: {source: count|None}} across the requested sources, cached.

    Cache key = "disease|gene|source". Cached entries are always returned; only up
    to `max_genes` *new* genes are queried online.
    """
    cache = _load_cache()
    out, queried = {}, 0
    for g in genes:
        res, need = {}, False
        for s in sources:
            key = f"{disease}|{g}|{s}"
            if key in cache:
                res[s] = cache[key]
            else:
                need = True
        if need and (max_genes is None or queried < max_genes):
            for s in sources:
                key = f"{disease}|{g}|{s}"
                if key in cache:
                    continue
                fn = _SOURCES.get(s)
                cnt = fn(g, disease, email=email) if s == "openalex" else (fn(g, disease) if fn else None)
                res[s] = cnt
                if cnt is not None:            # only cache successful lookups; retry failures next run
                    cache[key] = cnt
            queried += 1
            if verbose:
                shown = " ".join(f"{s}={res.get(s)}" for s in sources)
                print(f"    [lit] {g:12s} {shown}")
            if queried % 5 == 0:
                _save_cache(cache)
        out[g] = res
    _save_cache(cache)
    return out


# ── merge helpers (verbatim from utils/litsources.py) ────────────────────────
def lit_total(source_counts: dict) -> int:
    """Total co-mentions across sources (sum of successful counts; None ignored)."""
    return int(sum(v for v in source_counts.values() if isinstance(v, int)))


def n_sources_with_hits(source_counts: dict) -> int:
    """How many sources returned >=1 hit (cross-validation strength)."""
    return int(sum(1 for v in source_counts.values() if isinstance(v, int) and v > 0))


# ── public entry point — wraps it exactly as run_novelty does ────────────────
def score_genes(genes, disease: str = "Alzheimer",
                sources=("pubmed", "europepmc", "openalex"),
                include_preprints: bool = True, verbose: bool = True) -> dict:
    """Compute lit_novelty for each gene over the given gene set (the standalone
    skill contract).

    Returns {gene: {"lit_novelty": float in [0,1], "lit_total": int,
                    "n_sources_with_hits": int, "preprint_count": int|None,
                    "source_counts": {...}}}.

    The lit_novelty value reproduces 01_dyport_eval.py exactly:
      multi_counts → lit_total (over main `sources`) → 1 − pct_rank.
    """
    genes = list(dict.fromkeys(genes))          # de-dup, preserve order
    if not genes:
        return {}
    sources = list(sources)
    # bioRxiv/medRxiv preprints tracked separately (NOT summed into lit_total — would
    # double-count Europe PMC), matching the original.
    query_sources = sources + (["biorxiv"] if include_preprints and "biorxiv" not in sources else [])
    if verbose:
        print(f"[lit_novelty] co-mentions from {query_sources} for {len(genes)} genes (cached) ...")

    src_counts = multi_counts(genes, disease=disease, sources=query_sources,
                              email=None, max_genes=None, verbose=verbose)
    per_source = {g: src_counts.get(g, {}) for g in genes}
    main = {g: {s: per_source[g].get(s) for s in sources} for g in genes}
    totals = {g: lit_total(main[g]) for g in genes}
    n_hits = {g: n_sources_with_hits(main[g]) for g in genes}
    preprint = {g: per_source[g].get("biorxiv") for g in genes}

    lit_signal = [totals[g] for g in genes]
    nov = dict(zip(genes, lit_novelty(lit_signal)))

    return {
        g: {
            "lit_novelty": round(float(nov[g]), 3),
            "lit_total": int(totals[g]),
            "n_sources_with_hits": int(n_hits[g]),
            "preprint_count": preprint[g],
            "source_counts": per_source[g],
        }
        for g in genes
    }


if __name__ == "__main__":
    import sys
    gs = sys.argv[1:] or ["APOE", "APP", "PSEN1", "GALNT2"]
    out = score_genes(gs)
    print(f"\n{'gene':<10} {'lit_novelty':>11} {'lit_total':>9} {'#srcHit':>7}")
    for g, r in sorted(out.items(), key=lambda kv: -kv[1]["lit_novelty"]):
        print(f"{g:<10} {r['lit_novelty']:>11} {r['lit_total']:>9} {r['n_sources_with_hits']:>7}")
