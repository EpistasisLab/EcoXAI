// Build a viz graph from an EcoXAI analyze job's feature_importance_results.json.
//
// Browser-side port of adapters/ecoxai_to_models.py (graph format):
//   - one node per gene, coloured by its biotype (from data/biotype_map.json)
//   - linked to the target (disease) node, strength = the gene's importance
//   - importance values are used VERBATIM (no normalisation)
//
// EcoXAI already stores one ensemble value per gene, so this is a pass-through;
// if a gene is ever listed under several models we average them (never rescale).

export function buildGraphFromImportance(items, biotypeMap, target) {
  if (!Array.isArray(items)) {
    items = items.features || items.feature_importances || [];
  }
  const tgt = target || "Outcome";

  const perGene = {};
  const models = new Set();
  for (const it of items) {
    const f = it.feature;
    if (!f) continue;
    models.add(it.model || "ensemble");
    const v = typeof it.importance === "number" ? it.importance : null;
    if (v == null) continue;
    (perGene[f] = perGene[f] || []).push(v);
  }

  const nodes = [{ id: tgt, type: "disease", category: "outcome" }];
  const links = [];
  for (const f of Object.keys(perGene)) {
    const arr = perGene[f];
    const imp = Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(6));
    if (imp <= 0) continue;
    nodes.push({
      id: f,
      type: "factor",
      category: biotypeMap[f] || "unknown",
      importance: imp,
    });
    links.push({ source: f, target: tgt, relation: "associated", strength: imp });
  }

  return {
    meta: {
      disease: tgt,
      target: tgt,
      schema_version: 1,
      models: [...models],
      biotype_source: "HGNC complete set (locus_type)",
    },
    nodes,
    links,
  };
}
