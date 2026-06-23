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

Pipeline of the public entry point `score_genes`:
    genes ──multi_counts──> per-source co-mention counts
          ──lit_total──────> one summed count per gene (the "signal")
          ──lit_novelty────> 1 − percentile_rank(signal)  →  score in [0,1]

Only deps: numpy, scipy, requests (all present in docker/Dockerfile.agent).

Public entry point:
    score_genes(genes, disease="Alzheimer") -> {gene: {lit_novelty, lit_total, ...}}
"""
from __future__ import annotations
import json
import os
import time
import numpy as np
import requests

# ── REST endpoints (verbatim from utils/litsources.py + utils/pubmed.py) ──────
# Each literature source is queried over HTTP; we only read the total hit COUNT,
# never the documents themselves, so requests stay tiny (pageSize/per-page = 1).
EUROPEPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"   # title/abstract + full text + preprints
OPENALEX = "https://api.openalex.org/works"                            # ~250M works, broad metadata/full text
S2 = "https://api.semanticscholar.org/graph/v1/paper/search"           # Semantic Scholar (optional, rate-limited)
ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" # PubMed (NCBI E-utilities)

# On-disk cache lives next to THIS module so a query's result survives re-runs.
# All cache reads/writes are wrapped in try/except (see below) so a read-only or
# missing file never breaks scoring — the cache is an optimisation, not a dependency.
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".lit_cache.json")


def _email():
    # NCBI/OpenAlex ask for a contact email (politeness + higher rate limits).
    # Use the env var if set, otherwise a default address.
    return os.getenv("NCBI_EMAIL") or "rene650962aca@gmail.com"


def _api_key():
    # Optional NCBI API key — if present it raises the PubMed rate limit. None = unused.
    return os.getenv("NCBI_API_KEY")


# ── percentile rank (verbatim from utils/dyport_importance.py:pct_rank) ──────
def pct_rank(values):
    """Percentile rank in (0,1] — turns raw numbers into their relative standing.

    rankdata(method="average") assigns rank 1..N (ties share the averaged rank);
    dividing by N maps to (0,1]. So the LARGEST value → 1.0, the smallest → ~1/N.
    This is what makes lit_novelty a RELATIVE measure (ranks within the input set).
    """
    import scipy.stats as st
    v = np.asarray(values, dtype=float)
    if len(v) == 0:                      # empty input → return the empty array unchanged
        return v
    return st.rankdata(v, method="average") / len(v)


# ── the measure itself (verbatim from 01_dyport_eval.py:lit_novelty) ─────────
def lit_novelty(signal_values):
    """1 − percentile_rank(signal): genes the literature talks about LESS score higher.

    `signal_values` is e.g. co-mention counts (one per gene). Because pct_rank gives
    the MOST-mentioned gene ~1.0, "1 −" flips it so the LEAST-mentioned gene scores
    highest. Genes with signal 0 (no literature at all) land at the top.

    This is the ONE novelty measure integrated into EcoXAI.
    """
    return 1.0 - pct_rank(signal_values)


# ── PubMed co-mention count (inlined from utils/pubmed.py) ────────────────────
def _esearch_count(term: str, email: str, api_key, sleep: float) -> int:
    """Run a PubMed E-utilities esearch and return ONLY the hit count for `term`.

    retmax=0 means "don't return any record IDs, just the count" → minimal payload.
    On any network/parse error we return -1 (a sentinel the caller treats as 'failed',
    distinct from a genuine 0 hits). `sleep` throttles to respect NCBI rate limits.
    """
    params = {"db": "pubmed", "term": term, "retmax": 0, "retmode": "json",
              "tool": "ecoxai-dyport", "email": email}
    if api_key:
        params["api_key"] = api_key      # only added when an API key is configured
    try:
        r = requests.get(ESEARCH, params=params, timeout=15)
        r.raise_for_status()             # turn HTTP 4xx/5xx into an exception
        cnt = int(r.json()["esearchresult"]["count"])
    except Exception:
        cnt = -1                         # signal error (treated as 0 by callers, but logged)
    time.sleep(sleep)                    # always pause, success or failure, to stay polite
    return cnt


def _term(gene: str, disease: str, ymax=None) -> str:
    """Build the PubMed query string for "gene co-mentioned with disease".

    `[tiab]` restricts each term to Title/Abstract fields (precise co-mention).
    The optional `ymax` adds a publication-date upper bound (unused here, but kept
    verbatim from the original which used it for time-sliced counts).
    """
    t = f'"{gene}"[tiab] AND {disease}[tiab]'
    if ymax is not None:
        t += f' AND ("1800/01/01"[PDAT] : "{ymax}/12/31"[PDAT])'
    return t


def comention_count(gene: str, disease: str = "Alzheimer", *, email=None, api_key=None, sleep=0.34) -> int:
    """Total PubMed records co-mentioning gene & disease (>=0; failures clamped to 0)."""
    c = _esearch_count(_term(gene, disease), email or _email(), api_key or _api_key(), sleep)
    return max(c, 0)                     # never return the -1 error sentinel to callers


# ── per-source counters (verbatim from utils/litsources.py) ──────────────────
def _get_json(url, params, timeout=25, retries=2, sleep=0.34):
    """HTTP GET returning parsed JSON, with a few retries and exponential-ish backoff.

    Returns None if every attempt fails (so callers can distinguish 'lookup failed'
    from a real 0). On success it sleeps `sleep`s (rate-limit politeness) then returns.
    """
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, params=params, timeout=timeout)
            r.raise_for_status()
            data = r.json()
            time.sleep(sleep)
            return data
        except Exception:
            time.sleep(sleep * (attempt + 2))      # wait longer after each failed attempt
    return None                                    # all retries exhausted → failure


def europepmc_count(gene: str, disease: str = "Alzheimer", *, sleep: float = 0.34):
    """Co-mention count from Europe PMC (title/abstract + FULL TEXT + preprints).

    Broader than PubMed because it indexes body text, so it catches mentions PubMed
    misses. Returns int hit count, or None if the request failed.
    """
    params = {"query": f'"{gene}" AND {disease}', "format": "json",
              "resultType": "idlist", "pageSize": 1}      # pageSize=1: we only need hitCount
    d = _get_json(EUROPEPMC, params, sleep=sleep)
    return None if d is None else int(d.get("hitCount", 0))


def openalex_count(gene: str, disease: str = "Alzheimer", *, email=None, sleep: float = 0.34):
    """Co-mention count from OpenAlex (very broad: metadata + indexed full text)."""
    params = {"search": f"{gene} {disease}", "per-page": 1, "mailto": email or _email()}
    d = _get_json(OPENALEX, params, sleep=sleep)
    # OpenAlex returns the total under meta.count
    return None if d is None else int(d.get("meta", {}).get("count", 0))


def biorxiv_count(gene: str, disease: str = "Alzheimer", *, sleep: float = 0.34):
    """Co-mention count restricted to PREPRINTS (bioRxiv/medRxiv) via Europe PMC.

    `SRC:PPR` filters Europe PMC to its preprint source. Tracked SEPARATELY as an
    "emerging" signal — NOT summed into lit_total (that would double-count Europe PMC).
    """
    params = {"query": f'"{gene}" AND {disease} AND (SRC:PPR)', "format": "json",
              "resultType": "idlist", "pageSize": 1}
    d = _get_json(EUROPEPMC, params, sleep=sleep)
    return None if d is None else int(d.get("hitCount", 0))


def semanticscholar_count(gene: str, disease: str = "Alzheimer", *, sleep: float = 1.0):
    """Co-mention count from Semantic Scholar (optional; aggressive rate-limit → off by default).

    Not in the default source list; only used if 'semanticscholar' is requested explicitly.
    Longer default sleep (1.0s) because S2 throttles hard.
    """
    params = {"query": f"{gene} {disease}", "limit": 1}
    try:
        r = requests.get(S2, params=params, timeout=20)
        r.raise_for_status()
        n = int(r.json().get("total", 0))
    except Exception:
        n = None                         # failure → None (distinct from a real 0)
    time.sleep(sleep)
    return n


def pubmed_count(gene: str, disease: str = "Alzheimer", **_):
    """Adapter so PubMed fits the same `(gene, disease) -> int|None` interface as the
    other sources. Wraps `comention_count`; returns None on error so failures aren't
    cached as a real 0. (**_ swallows the unused `email`/`sleep` kwargs uniformly.)"""
    try:
        c = comention_count(gene, disease)
        return int(c) if c >= 0 else None
    except Exception:
        return None


# Registry mapping a source NAME → its counter function. `multi_counts` looks sources
# up here, so adding a source = add a counter above and an entry here.
_SOURCES = {
    "pubmed": pubmed_count,
    "europepmc": europepmc_count,
    "openalex": openalex_count,
    "biorxiv": biorxiv_count,
    "semanticscholar": semanticscholar_count,
}


# ── batch + cache (verbatim from utils/litsources.py, cache made best-effort) ─
def _load_cache() -> dict:
    """Read the on-disk cache dict, or {} if missing/unreadable (never raises)."""
    try:
        if os.path.exists(_CACHE_FILE):
            with open(_CACHE_FILE) as f:
                return json.load(f)
    except Exception:
        pass                             # corrupt/locked cache → just start empty
    return {}


def _save_cache(c: dict):
    """Write the cache dict to disk; silently no-op if the location isn't writable."""
    try:
        with open(_CACHE_FILE, "w") as f:
            json.dump(c, f, indent=0, ensure_ascii=False)
    except Exception:
        pass                             # read-only FS etc. — caching is optional


def multi_counts(genes, disease: str = "Alzheimer", *, sources=("pubmed", "europepmc", "openalex"),
                 email=None, max_genes=None, verbose: bool = True) -> dict:
    """Fetch {gene: {source: count|None}} across `sources`, using the on-disk cache.

    Cache key is "disease|gene|source" so each (gene, source) pair is fetched at most
    once ever. Already-cached values are always returned; only up to `max_genes` genes
    that still NEED a network lookup are queried this call (None = no cap = look up all).
    """
    cache = _load_cache()
    out, queried = {}, 0                 # `queried` counts genes we actually hit the net for
    for g in genes:
        res, need = {}, False
        # First pass: fill from cache and detect whether anything is still missing.
        for s in sources:
            key = f"{disease}|{g}|{s}"
            if key in cache:
                res[s] = cache[key]      # cached value (could be a real 0)
            else:
                need = True              # at least one source not yet known for this gene
        # Second pass: only query online if needed AND we're under the per-call budget.
        if need and (max_genes is None or queried < max_genes):
            for s in sources:
                key = f"{disease}|{g}|{s}"
                if key in cache:
                    continue             # don't re-query an already-cached source
                fn = _SOURCES.get(s)
                # openalex's counter takes an `email` kwarg; the others don't.
                cnt = fn(g, disease, email=email) if s == "openalex" else (fn(g, disease) if fn else None)
                res[s] = cnt
                if cnt is not None:      # only cache SUCCESSFUL lookups; retry failures next run
                    cache[key] = cnt
            queried += 1
            if verbose:                  # one progress line per freshly-queried gene
                shown = " ".join(f"{s}={res.get(s)}" for s in sources)
                print(f"    [lit] {g:12s} {shown}")
            if queried % 5 == 0:         # checkpoint the cache every 5 genes (crash safety)
                _save_cache(cache)
        out[g] = res
    _save_cache(cache)                   # final flush
    return out


# ── merge helpers (verbatim from utils/litsources.py) ────────────────────────
def lit_total(source_counts: dict) -> int:
    """Sum the per-source counts for one gene, ignoring failed lookups (None).

    isinstance(..., int) skips None entries; bool is an int subclass but counts are
    never bool here, so this cleanly sums only the successful integer hit counts.
    """
    return int(sum(v for v in source_counts.values() if isinstance(v, int)))


def n_sources_with_hits(source_counts: dict) -> int:
    """How many sources returned >=1 hit — a cross-validation strength signal.

    A gene that is 0 across MANY sources is a more trustworthy 'novel' than one that
    is just 0 in a single source (which could be an indexing miss).
    """
    return int(sum(1 for v in source_counts.values() if isinstance(v, int) and v > 0))


# ── public entry point — wraps it exactly as run_novelty does ────────────────
def score_genes(genes, disease: str = "Alzheimer",
                sources=("pubmed", "europepmc", "openalex"),
                include_preprints: bool = True, verbose: bool = True) -> dict:
    """Compute lit_novelty for EACH gene over the given gene set (the standalone contract).

    Steps (reproducing 01_dyport_eval.py exactly):
      1. multi_counts  → per-source co-mention counts for every gene
      2. lit_total     → one summed count per gene (over the MAIN sources only)
      3. lit_novelty   → 1 − percentile_rank(those summed counts)

    Returns {gene: {"lit_novelty": float in [0,1], "lit_total": int,
                    "n_sources_with_hits": int, "preprint_count": int|None,
                    "source_counts": {source: count|None}}}.
    NOTE: lit_novelty is RELATIVE — ranked across exactly the `genes` you pass in.
    """
    genes = list(dict.fromkeys(genes))          # de-duplicate while preserving order
    if not genes:
        return {}                               # nothing to score
    sources = list(sources)
    # bioRxiv preprints are queried as an EXTRA source for the per-gene breakdown, but
    # are excluded from `lit_total` below (they're a Europe PMC subset → would double-count).
    query_sources = sources + (["biorxiv"] if include_preprints and "biorxiv" not in sources else [])
    if verbose:
        print(f"[lit_novelty] co-mentions from {query_sources} for {len(genes)} genes (cached) ...")

    # 1) Fetch all counts (cached). max_genes=None → look up every candidate, no cap.
    src_counts = multi_counts(genes, disease=disease, sources=query_sources,
                              email=None, max_genes=None, verbose=verbose)
    per_source = {g: src_counts.get(g, {}) for g in genes}                       # full breakdown incl. biorxiv
    main = {g: {s: per_source[g].get(s) for s in sources} for g in genes}        # MAIN sources only (no biorxiv)
    totals = {g: lit_total(main[g]) for g in genes}                             # 2) summed signal per gene
    n_hits = {g: n_sources_with_hits(main[g]) for g in genes}                   # cross-source agreement
    preprint = {g: per_source[g].get("biorxiv") for g in genes}                 # tracked separately

    # 3) Turn the per-gene summed counts into relative novelty scores in one shot.
    lit_signal = [totals[g] for g in genes]
    nov = dict(zip(genes, lit_novelty(lit_signal)))

    # Assemble the per-gene result record (score rounded for stable display/storage).
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
    # Quick manual check: `python lit_novelty.py APOE APP GALNT2`
    # Prints a table sorted by novelty (most-novel gene first).
    import sys
    gs = sys.argv[1:] or ["APOE", "APP", "PSEN1", "GALNT2"]   # default demo gene set
    out = score_genes(gs)
    print(f"\n{'gene':<10} {'lit_novelty':>11} {'lit_total':>9} {'#srcHit':>7}")
    for g, r in sorted(out.items(), key=lambda kv: -kv[1]["lit_novelty"]):
        print(f"{g:<10} {r['lit_novelty']:>11} {r['lit_total']:>9} {r['n_sources_with_hits']:>7}")
