'use strict';

let _pipe = null;

async function getPipeline() {
  if (!_pipe) {
    const { pipeline } = await import('@xenova/transformers');
    _pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2',
      { pooling: 'mean', normalize: true });
  }
  return _pipe;
}

async function embed(text) {
  const pipe = await getPipeline();
  const out = await pipe(String(text), { pooling: 'mean', normalize: true });
  return new Float32Array(out.data); // 384-dim unit vector
}

// Call on server startup so the first real request doesn't pay download cost.
function warmup() {
  getPipeline().catch((e) => console.warn('[embedding] warmup failed:', e.message));
}

module.exports = { embed, warmup };
