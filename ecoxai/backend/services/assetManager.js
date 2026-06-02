'use strict';

const fs = require('fs').promises;
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

function sanitizeTitle(title) {
  return (title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'untitled';
}

function getAssetDir(jobId, title) {
  return path.join(ASSETS_DIR, `${jobId}-${sanitizeTitle(title)}`);
}

async function saveJobAssets({ job, artifacts, sessionLog }) {
  const assetDir = getAssetDir(job.id, job.title);
  await fs.mkdir(assetDir, { recursive: true });

  const filesWritten = [];

  // Write session log
  if (sessionLog) {
    await fs.writeFile(path.join(assetDir, 'session.log'), sessionLog, 'utf-8');
    filesWritten.push('session.log');
  }

  // Write each artifact that has content
  for (const artifact of artifacts || []) {
    if (!artifact.content) continue;
    const filename = path.basename(artifact.name || artifact.path || 'artifact');
    const dest = path.join(assetDir, filename);
    await fs.writeFile(dest, artifact.content, 'utf-8');
    filesWritten.push(filename);
  }

  // Write meta.json
  const meta = {
    jobId: job.id,
    title: job.title,
    exitCode: job.exitCode,
    totalCostUsd: job.totalCostUsd ?? null,
    numTurns: job.numTurns ?? null,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    artifactCount: (artifacts || []).length,
    filesWritten,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(assetDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  console.log(`[Assets] Saved ${filesWritten.length} file(s) to ${assetDir}`);
  return { assetDir, filesWritten };
}

module.exports = { saveJobAssets, getAssetDir };
