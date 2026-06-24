"""Offline tests for hypothesis-dedup (cosine layer mocked — no network)."""
import dedup


def test_normalize():
    assert dedup.normalize("  APOE   is\tA  Risk Factor ") == "apoe is a risk factor"


def test_exact_layer_vs_existing_and_in_batch(monkeypatch):
    # disable the cosine layer so we test only exact matching
    monkeypatch.setattr(dedup, "_top_similarity", lambda *a, **k: 0.0)
    cands = [
        {"hypothesis_text": "APOE is a risk factor"},
        {"hypothesis_text": "apoe IS  a risk factor"},   # in-batch exact dup (normalized)
        {"hypothesis_text": "TREM2 is a biomarker"},      # dup of an existing one
        {"hypothesis_text": "BIN1 predicts the outcome"},
    ]
    res = dedupe = dedup.dedupe(cands, existing_texts=["TREM2 is a biomarker"],
                                backend_url="http://x")
    kept = [h["hypothesis_text"] for h in res["kept"]]
    assert kept == ["APOE is a risk factor", "BIN1 predicts the outcome"]
    reasons = sorted(d["reason"] for d in res["dropped"])
    assert reasons == ["exact", "exact"]


def test_cosine_layer_drops_near_duplicate(monkeypatch):
    # candidate "B" looks near-identical to a stored hypothesis (sim 0.92); "A" is distinct (0.10)
    sims = {"A": 0.10, "B": 0.92}
    monkeypatch.setattr(dedup, "_top_similarity",
                        lambda text, *a, **k: 0.92 if "B-claim" in text else 0.10)
    cands = [{"hypothesis_text": "A-claim distinct"}, {"hypothesis_text": "B-claim near dup"}]
    res = dedup.dedupe(cands, existing_texts=[], backend_url="http://x", threshold=0.85)
    assert [h["hypothesis_text"] for h in res["kept"]] == ["A-claim distinct"]
    assert res["dropped"][0]["reason"] == "cosine"
    assert res["dropped"][0]["similarity"] == 0.92


def test_network_failure_keeps(monkeypatch):
    # _top_similarity returns 0.0 on failure → nothing dropped by cosine
    monkeypatch.setattr(dedup, "_top_similarity", lambda *a, **k: 0.0)
    cands = [{"hypothesis_text": "X"}, {"hypothesis_text": "Y"}]
    res = dedup.dedupe(cands, existing_texts=[], backend_url="http://x")
    assert len(res["kept"]) == 2 and res["dropped"] == []
