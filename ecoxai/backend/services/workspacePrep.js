'use strict';

const path = require('path');

/**
 * Lean workspacePrep — no HPC, no S3, uses volumeManager directly.
 *
 * @param {string} jobId
 * @param {Object} job
 * @param {Object} state
 * @param {Object} volumeManager
 * @returns {{ enhancedPrompt: string }}
 */
async function prepareWorkspace(jobId, job, state, volumeManager) {
  const { prompt, datasetId, selectedSkills } = job;

  // 1. Copy CLAUDE.md to workspace volume
  const claudeMdCopied = await volumeManager.copyCLAUDEmdToWorkspace(jobId);
  if (!claudeMdCopied) {
    console.warn(`[workspacePrep] Failed to copy CLAUDE.md for job ${jobId}`);
  }

  // 2. Copy selected skills to workspace (.claude/skills/{skill-name}/SKILL.md)
  if (selectedSkills && selectedSkills.length > 0) {
    const skillsCopied = await volumeManager.copySkillsToWorkspace(jobId, selectedSkills);
    if (!skillsCopied) {
      console.warn(`[workspacePrep] Failed to copy skills for job ${jobId}`);
    }
  }

  // 3. Write exploration_report.md if provided by a prior explore stage
  const { _explorationReport } = job;
  if (_explorationReport) {
    const written = await volumeManager.writeWorkspaceFile(jobId, 'exploration_report.md', _explorationReport);
    if (!written) {
      console.warn(`[workspacePrep] Failed to write exploration_report.md for job ${jobId}`);
    }
  }

  // 4. Build enhanced prompt with normalization context
  let enhancedPrompt = prompt;
  if (datasetId && state?.datasets?.[datasetId]) {
    const dataset = state.datasets[datasetId];
    const datasetBasePath = `/datasets/${datasetId}`;

    if (dataset.normalization) {
      if (_explorationReport) {
        enhancedPrompt = `IMPORTANT: A cleaned dataset is attached to this task.

**Dataset Location:** ${datasetBasePath}/cleaned/data.feather

**Read this first:** \`/workspace/exploration_report.md\` — contains the full exploration findings, schema, and data quality summary from the previous pipeline stage.

Task: ${prompt}`;
      } else {
        const userDescription = dataset.normalization.semanticMetadata?.user_description;
        const descriptionSection = userDescription
          ? `\n**User Notes:** ${userDescription}\n`
          : '';

        enhancedPrompt = `IMPORTANT: A normalized dataset is attached to this task.

**Dataset Location:** ${datasetBasePath}/normalized/

**CRITICAL: Read these files FIRST before accessing data:**
1. ${datasetBasePath}/normalized/semantic.json - Domain context, entities, units
2. ${datasetBasePath}/normalized/confidence.json - Data quality scores
3. ${datasetBasePath}/normalized/structure.json - Document structure

**Data is pre-validated and normalized:**
- Domain: ${dataset.normalization.semanticMetadata?.domain || 'unknown'}
- Confidence: ${dataset.normalization.confidence?.toFixed(2) || 'N/A'}
- Document Type: ${dataset.normalization.documentType || 'unknown'}
- Artifacts: ${dataset.normalization.artifacts?.length || 0}
${descriptionSection}
See CLAUDE.md in the workspace for complete normalized data contracts.

Task: ${prompt}`;
      }
    } else {
      enhancedPrompt = `IMPORTANT: A dataset is attached. Available at: ${datasetBasePath}/\nRun \`ls -la ${datasetBasePath}/\` to verify. Check DATASET_ID and DATASET_FILENAME env vars.\n\nTask: ${prompt}`;
    }
  }

  // 5. Write task.txt to workspace volume
  await volumeManager.writeTaskFile(jobId, enhancedPrompt);

  return { enhancedPrompt };
}

module.exports = { prepareWorkspace };
