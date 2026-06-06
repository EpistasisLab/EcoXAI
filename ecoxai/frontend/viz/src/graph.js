// Interactive disease-factor network with switchable 2D (D3/SVG) and 3D (WebGL)
// renderers. Accepts either a {meta, nodes, links} graph or a multi-model weight
// file (model_a:{factor:weight}, ...) which is converted on the fly.
//
// `d3` and `ForceGraph3D` come from self-hosted UMD bundles (vendor/*.js) loaded as
// classic scripts before this module — no CDN, no importmap, ONE bundled three.
// Always-on 3D labels are plain HTML positioned via Graph3D.graph2ScreenCoords(),
// so no second three / three-spritetext is needed.
import { buildGraphFromImportance } from "./ecoxai_adapter.js";

const CATEGORY_COLOR = {
  outcome: "#e15759",
  // AD-factor categories (sample_models / extraction graphs)
  genetic: "#4e79a7",
  metabolic: "#f28e2b",
  inflammatory: "#e377c2",
  lifestyle: "#59a14f",
  pathology: "#b07aa1",
  environmental: "#76b7b2",
  vascular: "#ff9da7",
  // gene biotypes (EcoXAI feature-importance graph; mygene.info)
  protein_coding: "#4e79a7",
  lncRNA: "#59a14f",
  miRNA: "#f28e2b",
  snoRNA: "#b07aa1",
  snRNA: "#9c755f",
  misc_RNA: "#76b7b2",
  ncRNA: "#edc948",
  tRNA: "#8cd17d",
  rRNA: "#499894",
  pseudogene: "#bab0ac",
  immune_gene: "#ff9da7",
  unknown: "#5a5a5a",
  other: "#9c9c9c",
};

const RELATION_COLOR = {
  risk: "#e15759",
  promotes: "#f28e2b",
  protective: "#59a14f",
  inhibits: "#4e79a7",
  associated: "#7a869a",
};

// Maps factor keys (multi-model input) to a display category for node color.
const FACTOR_CATEGORY = {
  // genetic
  apoe: "genetic", trem2: "genetic", clu: "genetic", bin1: "genetic", abca7: "genetic", psen1: "genetic",
  // pathology
  amyloid: "pathology", tau: "pathology", nft: "pathology", bbb_dysfunction: "pathology",
  // inflammatory
  neuroinflammation: "inflammatory", microglial_activation: "inflammatory", tnf_alpha: "inflammatory", il6: "inflammatory",
  // metabolic
  diabetes: "metabolic", insulin_resistance: "metabolic", obesity: "metabolic",
  hypertension: "metabolic", hypercholesterolemia: "metabolic", vitamin_d_deficiency: "metabolic",
  // vascular
  cerebral_hypoperfusion: "vascular", atherosclerosis: "vascular", stroke_history: "vascular",
  // environmental
  air_pollution: "environmental", pesticide_exposure: "environmental", heavy_metals: "environmental",
  occupational_solvents: "environmental", aluminum: "environmental",
  // lifestyle
  physical_exercise: "lifestyle", education: "lifestyle", mediterranean_diet: "lifestyle",
  cognitive_engagement: "lifestyle", poor_sleep: "lifestyle", smoking: "lifestyle",
  alcohol: "lifestyle", social_isolation: "lifestyle", depression: "lifestyle",
  // other
  hearing_loss: "other", traumatic_brain_injury: "other", gut_microbiome: "other", herpes_hsv1: "other",
};

// ── multi-model → graph ─────────────────────────────────────────────────────
// Each factor's link strength = MEAN of per-model weights (method A: present
// values only). Mean 0 — or absent from every model — → NO link (dropped).
function modelsToGraph(data) {
  const target = data.meta?.target ?? data.meta?.disease ?? "Outcome";
  const modelNames =
    data.meta?.models ??
    Object.keys(data).filter(
      (k) => k !== "meta" && data[k] && typeof data[k] === "object" && !Array.isArray(data[k])
    );

  const factors = new Set();
  modelNames.forEach((m) => Object.keys(data[m] ?? {}).forEach((f) => factors.add(f)));

  const nodes = [{ id: target, type: "disease", category: "outcome" }];
  const links = [];

  factors.forEach((f) => {
    const perModel = {};
    modelNames.forEach((m) => {
      const v = data[m]?.[f];
      if (typeof v === "number") perModel[m] = v; // ignore non-numeric keys (e.g. _note)
    });
    const present = Object.values(perModel);
    if (!present.length) return; // absent from every model → no link

    const avg = present.reduce((a, b) => a + b, 0) / present.length;
    if (avg === 0) return; // mean is 0 → no link

    nodes.push({
      id: f,
      type: "factor",
      category: FACTOR_CATEGORY[f] ?? "other",
      mentions: present.filter((v) => v > 0).length,
      models: perModel,
    });
    links.push({
      source: f,
      target,
      relation: "associated",
      strength: +avg.toFixed(3),
      models: perModel,
      evidence: `mean of ${present.length} model(s)`,
    });
  });

  return { meta: { ...(data.meta ?? {}), source_documents: [] }, nodes, links };
}

// ── shared state ────────────────────────────────────────────────────────────
const svg = d3.select("#graph");
const tooltip = d3.select("#tooltip");
let simulation, Graph3D;
let rawGraph = { meta: {}, nodes: [], links: [] };
let mode = "2d";
let threshold = 0;
let maxImportance = 1;  // data-driven; node size & 3D val scale against this
let maxStrength = 1;    // data-driven; link width scales against this

// Show small importances (e.g. 0.0206) with enough precision, large ones (0.85) compactly.
function fmtStrength(v) { return v >= 1 ? v.toFixed(2) : v.toPrecision(3); }

// Fit the strength slider + node-size scale to the loaded data (no value rescaling).
function setupScales() {
  const factors = rawGraph.nodes.filter((n) => n.type !== "disease" && n.importance != null);
  maxImportance = factors.length ? Math.max(...factors.map((n) => n.importance)) : 1;
  const strengths = rawGraph.links.map((l) => l.strength ?? 0);
  maxStrength = strengths.length ? Math.max(...strengths) : 1;
  const th = document.getElementById("threshold");
  const tv = document.getElementById("thVal");
  if (!th) return;
  th.max = maxStrength;
  th.step = maxStrength / 200 || 0.01;
  // default: keep the strongest ~150 links so the first view isn't a hairball
  const sorted = strengths.slice().sort((a, b) => b - a);
  threshold = sorted.length > 150 ? sorted[150] : 0;
  th.value = threshold;
  if (tv) tv.textContent = fmtStrength(threshold);
}

function size() {
  const el = document.getElementById("stage");
  return { w: el.clientWidth, h: el.clientHeight };
}
const linkId = (e) => e.source.id ?? e.source;
const tgtId = (e) => e.target.id ?? e.target;

function nodeRadius(d) {
  if (d.type === "disease") return 16;
  if (d.importance != null) return 5 + Math.sqrt(d.importance / maxImportance) * 10;
  return 6 + Math.sqrt(d.mentions ?? 1) * 2.4;
}
function nodeColor(d) {
  return d.type === "disease" ? CATEGORY_COLOR.outcome : CATEGORY_COLOR[d.category] ?? CATEGORY_COLOR.other;
}
function modelsLine(d) {
  return d.models ? Object.entries(d.models).map(([m, v]) => `${m}=${v}`).join(", ") : (d.evidence ?? "");
}

// Apply the strength filter: keep links ≥ threshold, then keep the disease node
// plus any factor that still has a link.
function viewGraph() {
  const links = rawGraph.links.filter((l) => (l.strength ?? 0) >= threshold);
  const keep = new Set();
  links.forEach((l) => { keep.add(linkId(l)); keep.add(tgtId(l)); });
  const nodes = rawGraph.nodes.filter((n) => n.type === "disease" || keep.has(n.id));
  return { meta: rawGraph.meta, nodes, links };
}

// ── load + dispatch ─────────────────────────────────────────────────────────
async function load(url) {
  let data;
  try {
    data = await d3.json(url);
  } catch (e) {
    showErr(`failed to load ${url}`);
    return;
  }
  if (!data) return;
  renderGraphData(data);
}

function renderGraphData(data) {
  if (!data.nodes || !data.links) data = modelsToGraph(data);
  rawGraph = data;
  setupScales();
  renderCurrent();
}

// Drive the viz from an EcoXAI analyze job (embedded mode, ?job=<id>).
async function loadEcoxaiJob(jobId, target) {
  try {
    const [items, biotypeMap] = await Promise.all([
      fetch(`/api/jobs/${jobId}/artifacts/feature_importance_results.json`)
        .then((r) => { if (!r.ok) throw new Error(`importance ${r.status}`); return r.json(); }),
      fetch("data/biotype_map.json")
        .then((r) => { if (!r.ok) throw new Error(`biotype_map ${r.status}`); return r.json(); }),
    ]);
    renderGraphData(buildGraphFromImportance(items, biotypeMap, target || "Outcome"));
  } catch (e) {
    showErr("viz load failed: " + e.message);
  }
}

function renderCurrent() {
  const g = viewGraph();
  const metaEl = document.getElementById("meta");
  if (metaEl) metaEl.textContent =
    `${rawGraph.meta?.disease ?? "?"} · ${g.nodes.length} nodes · ${g.links.length} links · ` +
    `${mode.toUpperCase()} view`;
  buildLegend(g);
  if (mode === "2d") { show2D(); render2D(g); }
  else { show3D(); render3D(g); }
}

function show2D() {
  document.getElementById("graph").style.display = "block";
  document.getElementById("graph3d").style.display = "none";
  document.getElementById("labels3d").style.display = "none";
  if (Graph3D) Graph3D.pauseAnimation();
}
function show3D() {
  document.getElementById("graph").style.display = "none";
  document.getElementById("graph3d").style.display = "block";
  document.getElementById("labels3d").style.display = "block";
  svg.selectAll("*").remove();
  if (simulation) simulation.stop();
}

// ── 2D renderer (D3 / SVG) ──────────────────────────────────────────────────
function render2D(graph) {
  svg.selectAll("*").remove();
  const { w, h } = size();
  const nodes = graph.nodes.map((d) => ({ ...d }));
  const links = graph.links.map((d) => ({ ...d }));

  // Zoom-to-reveal labels: rank factors by importance (or mentions); only the
  // top-ranked are labelled, and more appear as the user zooms in.
  nodes.filter((n) => n.type !== "disease")
    .sort((a, b) => (b.importance ?? b.mentions ?? 0) - (a.importance ?? a.mentions ?? 0))
    .forEach((n, i) => { n._rank = i; });

  const defs = svg.append("defs");
  const glow = defs.append("filter").attr("id", "glow")
    .attr("x", "-60%").attr("y", "-60%").attr("width", "220%").attr("height", "220%");
  glow.append("feGaussianBlur").attr("stdDeviation", "3").attr("result", "b");
  const merge = glow.append("feMerge");
  merge.append("feMergeNode").attr("in", "b");
  merge.append("feMergeNode").attr("in", "SourceGraphic");

  const root = svg.append("g");
  svg.call(d3.zoom().scaleExtent([0.2, 4]).on("zoom", (e) => {
    root.attr("transform", e.transform);
    updateLabels(e.transform.k);
  }));

  // adjacency for hover highlight
  const adj = new Map(nodes.map((n) => [n.id, new Set([n.id])]));
  links.forEach((l) => { adj.get(linkId(l))?.add(tgtId(l)); adj.get(tgtId(l))?.add(linkId(l)); });

  const link = root.append("g").selectAll("path").data(links).join("path")
    .attr("class", "link").attr("fill", "none")
    .attr("stroke", (d) => RELATION_COLOR[d.relation] ?? "#7a869a")
    .attr("stroke-width", (d) => 1 + 5 * ((d.strength ?? 0) / maxStrength))
    .attr("stroke-opacity", 0.5)
    .on("mouseover", (e, d) =>
      showTip(e, `<b>${linkId(d)} → ${tgtId(d)}</b><br>relation: ${d.relation} · strength: ${d.strength}<br><i>${modelsLine(d)}</i>`))
    .on("mouseout", hideTip);

  const node = root.append("g").selectAll("g").data(nodes).join("g").attr("class", "node").call(drag());
  const circle = node.append("circle")
    .attr("r", nodeRadius).attr("fill", nodeColor).attr("filter", "url(#glow)")
    .on("mouseover", (e, d) => { highlight(d.id); showTip(e, nodeTip(d)); })
    .on("mouseout", () => { highlight(null); hideTip(); });
  const label = node.append("text").attr("x", 11).attr("y", 4).text((d) => d.id);

  // ~14 labels at k=1, more as you zoom in; counter-scale to keep a constant
  // on-screen size (fixes "labels too big / overlapping" on dense graphs).
  function updateLabels(k) {
    const n = Math.round(14 * k);
    label
      .style("display", (d) => (d.type === "disease" || (d._rank != null && d._rank < n)) ? null : "none")
      .style("font-size", (11 / k).toFixed(2) + "px");
  }
  updateLabels(1);

  function highlight(id) {
    const on = (n) => id == null || adj.get(id)?.has(n.id);
    circle.style("opacity", (n) => (on(n) ? 1 : 0.12));
    label.style("opacity", (n) => (on(n) ? 1 : 0.12));
    link.style("stroke-opacity", (l) => (id == null ? 0.5 : (linkId(l) === id || tgtId(l) === id ? 0.95 : 0.04)));
  }

  simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance(120))
    .force("charge", d3.forceManyBody().strength(-360))
    .force("center", d3.forceCenter(w / 2, h / 2))
    .force("collide", d3.forceCollide(30))
    .on("tick", () => {
      link.attr("d", (d) => {
        const x1 = d.source.x, y1 = d.source.y, x2 = d.target.x, y2 = d.target.y;
        const dr = Math.hypot(x2 - x1, y2 - y1) * 1.7;
        return `M${x1},${y1}A${dr},${dr} 0 0,1 ${x2},${y2}`;
      });
      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });
}

function nodeTip(d) {
  if (d.importance != null) {
    // EcoXAI gene node. Label is the source model (e.g. "ensemble_mean"); the
    // value is that model's importance (normalised Σ=1, averaged across models).
    const m = rawGraph.meta?.models;
    const label = Array.isArray(m) && m.length ? m.join(", ") : "importance";
    return `<b>${d.id}</b><br>biotype: ${d.category}<br>${label}: ${d.importance}`;
  }
  const ms = d.models ? `<br><i>${modelsLine(d)}</i>` : "";
  return `<b>${d.id}</b><br>type: ${d.type} · category: ${d.category}<br>models: ${d.mentions ?? 0}${ms}`;
}

// ── 3D renderer (3d-force-graph / WebGL) ────────────────────────────────────
function render3D(graph) {
 try {
  const data = { nodes: graph.nodes.map((d) => ({ ...d })), links: graph.links.map((d) => ({ ...d })) };
  if (!Graph3D) {
    const el = document.getElementById("graph3d");
    Graph3D = ForceGraph3D()(el)
      .backgroundColor("#0b0f14")
      .showNavInfo(false)
      .nodeColor(nodeColor)
      .nodeVal((n) => (n.type === "disease" ? 16 : n.importance != null ? 2 + (n.importance / maxImportance) * 14 : 2 + (n.mentions ?? 1) * 2.2))
      .nodeOpacity(0.95)
      .nodeResolution(18)
      .nodeLabel((n) => `<div style="font:12px Inter,sans-serif;color:#e8edf3">
          <b>${n.id}</b><br>${n.category}${n.models ? "<br>" + modelsLine(n) : ""}</div>`)
      .linkColor((l) => RELATION_COLOR[l.relation] ?? "#7a869a")
      .linkWidth((l) => 0.4 + 2.6 * ((l.strength ?? 0) / maxStrength))
      .linkOpacity(0.4)
      .linkLabel((l) => `${linkId(l)} → ${tgtId(l)} · ${l.strength}`)
      .onNodeClick((n) => {
        const d = 120, r = 1 + d / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
        Graph3D.cameraPosition({ x: (n.x || 0) * r, y: (n.y || 0) * r, z: (n.z || 0) * r }, n, 1200);
      });
    // Spread nodes apart: stronger charge repulsion + longer links (a star of
    // ~1790 genes around one disease node clumps together with the defaults).
    Graph3D.d3Force("charge").strength(-120);
    Graph3D.d3Force("link").distance(45);
    const fit = () => Graph3D.width(el.clientWidth).height(el.clientHeight);
    fit();
    window.addEventListener("resize", fit);
  }
  Graph3D.resumeAnimation();
  Graph3D.graphData(data);
  buildLabels3D(data.nodes); // always-on HTML labels track these node objects
  startLabelLoop();
 } catch (err) {
  showErr("3D render failed: " + (err?.message || err));
  throw err;
 }
}

// Always-on 3D labels as HTML, positioned each frame from world→screen projection.
// No three access needed: graph2ScreenCoords() projects, and front/back culling uses
// plain vector math on camera.position and controls.target.
let labelEls = [];
let labelRAF = null;

function buildLabels3D(nodes) {
  const box = document.getElementById("labels3d");
  box.innerHTML = "";
  labelEls = nodes.map((n) => {
    const el = document.createElement("div");
    el.className = "lbl";
    el.textContent = n.id.replace(/_/g, " ");
    el.style.color = nodeColor(n);
    el.style.fontSize = (n.type === "disease" ? 15 : n.importance != null ? 9.5 + (n.importance / maxImportance) * 5 : 9.5 + (n.mentions ?? 1) * 0.8) + "px";
    box.appendChild(el);
    return { n, el };
  });
}

function updateLabels3D() {
  if (!Graph3D || !labelEls.length) return;
  const cam = Graph3D.camera();
  const ctr = Graph3D.controls && Graph3D.controls();
  const cp = cam.position;
  const tg = ctr && ctr.target ? ctr.target : { x: 0, y: 0, z: 0 };
  const dx = tg.x - cp.x, dy = tg.y - cp.y, dz = tg.z - cp.z; // view direction
  for (const { n, el } of labelEls) {
    if (!Number.isFinite(n.x)) { el.style.display = "none"; continue; }
    const vx = n.x - cp.x, vy = n.y - cp.y, vz = n.z - cp.z;
    if (vx * dx + vy * dy + vz * dz <= 0) { el.style.display = "none"; continue; } // behind camera
    const s = Graph3D.graph2ScreenCoords(n.x, n.y, n.z);
    if (!s || !Number.isFinite(s.x)) { el.style.display = "none"; continue; }
    const dist = Math.hypot(vx, vy, vz);
    el.style.display = "block";
    el.style.opacity = Math.max(0.18, Math.min(1, 650 / dist)); // fade distant labels
    el.style.transform = `translate(-50%,-150%) translate(${s.x}px, ${s.y}px)`;
  }
}

function startLabelLoop() {
  if (labelRAF) cancelAnimationFrame(labelRAF);
  const tick = () => {
    if (mode !== "3d") { labelRAF = null; return; } // stop when leaving 3D
    updateLabels3D();
    labelRAF = requestAnimationFrame(tick);
  };
  labelRAF = requestAnimationFrame(tick);
}

// ── legend, tooltip, controls ───────────────────────────────────────────────
function buildLegend(graph) {
  const cats = [...new Set(graph.nodes.map((n) => n.category))];
  const rels = [...new Set(graph.links.map((l) => l.relation))];
  const legend = d3.select("#legend");
  legend.html("<b>category</b>");
  cats.forEach((c) => legend.append("div")
    .html(`<span class="dot" style="background:${CATEGORY_COLOR[c] ?? CATEGORY_COLOR.other};color:${CATEGORY_COLOR[c] ?? CATEGORY_COLOR.other}"></span>${c}`));
  legend.append("div").style("margin-top", "8px").html("<b>relation</b>");
  rels.forEach((r) => legend.append("div")
    .html(`<span class="dot" style="background:${RELATION_COLOR[r] ?? "#7a869a"};color:${RELATION_COLOR[r] ?? "#7a869a"}"></span>${r}`));
}

function drag() {
  return d3.drag()
    .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; });
}
function showTip(event, html) {
  tooltip.html(html).style("opacity", 1)
    .style("left", event.pageX + 12 + "px").style("top", event.pageY + 12 + "px");
}
function hideTip() { tooltip.style("opacity", 0); }

function showErr(msg) {
  const e = document.getElementById("err");
  if (!e) return;
  e.style.display = "block";
  e.textContent = String(msg);
}
window.addEventListener("error", (e) => showErr("JS error: " + (e.message || e.error)));
window.addEventListener("unhandledrejection", (e) => showErr("Promise rejected: " + (e.reason?.message || e.reason)));

const selector = document.getElementById("dataSource");

const thInput = document.getElementById("threshold");
thInput.addEventListener("input", () => {
  threshold = +thInput.value;
  document.getElementById("thVal").textContent = fmtStrength(threshold);
  renderCurrent();
});

document.querySelectorAll("#viewToggle button").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("#viewToggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
    renderCurrent();
  })
);

// This copy is embedded in EcoXAI and is always driven by `?job=<id>`.
// reload re-loads the same job; without ?job we just show a hint (the
// standalone data files like ecoxai_graph.json don't exist here).
const _params = new URLSearchParams(location.search);
const _job = _params.get("job");
const _reload = document.getElementById("reload");
if (_job) {
  const _target = _params.get("target") || "Outcome";
  document.querySelector("#dataSource")?.closest(".ctrl")?.style.setProperty("display", "none");
  if (_reload) _reload.addEventListener("click", () => loadEcoxaiJob(_job, _target));
  loadEcoxaiJob(_job, _target);
} else {
  showErr("Open the Network tab in EcoXAI and pick a dataset / run.");
}
