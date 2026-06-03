const Anthropic = require('@anthropic-ai/sdk');
const dbManager = require('./databaseManager');

/**
 * HypothesisAgent - Orchestrator for scientific hypothesis lifecycle
 *
 * This agent manages the epistemic uncertainty state machine:
 * - Extracts falsifiable hypotheses from execution traces
 * - Designs experiments to test hypotheses (delegates to execution agents)
 * - Evaluates evidence to support or reject hypotheses
 * - Revises hypotheses based on partial evidence
 *
 * CRITICAL: This is an ORCHESTRATOR, not an execution agent.
 * It does NOT call Read, Write, Bash, or any tools directly.
 * It delegates evidence collection to execution agents (Claude Code containers).
 */
class HypothesisAgent {
  constructor() {
    // Check which mode to use: Foundry or Direct API (same as orchestrator)
    const useFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY === '1';

    if (useFoundry) {
      // Azure Foundry Configuration
      const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY;
      const resource = process.env.ANTHROPIC_FOUNDRY_RESOURCE || 'cbm-staff-gpt4';
      const model = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-5';

      if (!apiKey) {
        console.warn('⚠️  Warning: ANTHROPIC_FOUNDRY_API_KEY not found. HypothesisAgent will use degraded mode.');
        this.anthropic = null;
        this.model = null;
        return;
      }

      try {
        const AnthropicFoundry = require('@anthropic-ai/foundry-sdk').default;

        this.anthropic = new AnthropicFoundry({
          apiKey: apiKey,
          resource: resource
        });

        this.model = model;
        console.log(`✅ HypothesisAgent initialized with Azure Foundry (resource: ${resource}, model: ${model})`);
      } catch (error) {
        console.error('❌ Failed to initialize HypothesisAgent Foundry client:', error.message);
        this.anthropic = null;
        this.model = null;
      }
    } else {
      // Direct Anthropic API Configuration
      const apiKey = process.env.ANTHROPIC_API_KEY;

      if (!apiKey) {
        console.warn('⚠️  Warning: No Anthropic API key found. HypothesisAgent will use degraded mode.');
        this.anthropic = null;
        this.model = null;
        return;
      }

      try {
        const clientOpts = { apiKey };
        if (process.env.ANTHROPIC_BASE_URL) clientOpts.baseURL = process.env.ANTHROPIC_BASE_URL;
        this.anthropic = new Anthropic(clientOpts);

        this.model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20241022';
        console.log(`✅ HypothesisAgent initialized with Direct API (model: ${this.model})`);
      } catch (error) {
        console.error('❌ Failed to initialize HypothesisAgent client:', error.message);
        this.anthropic = null;
        this.model = null;
      }
    }
  }

  /**
   * Check if AI mode is available
   * @returns {boolean}
   */
  hasAIMode() {
    return !!this.anthropic;
  }

  /**
   * Extract falsifiable hypotheses from thinking blocks AND artifact outputs
   * @param {string} runId - Execution run ID
   * @param {Object} options - Optional extraction options
   * @param {string} options.datasetDomain - Dataset domain (e.g., 'genomics', 'clinical_trial')
   * @param {Object} options.hypothesisConfig - Hypothesis generation config {featureImportance, featureEngineering}
   * @returns {Promise<Array<Object>>} - Proposed hypotheses with IDs
   */
  async extractHypotheses(runId, options = {}) {
    const { datasetDomain, hypothesisConfig } = options;
    if (!this.anthropic) {
      console.log('HypothesisAgent: No AI client available, skipping extraction');
      return [];
    }

    try {
      // Fetch run details
      const run = await dbManager.getRun(runId);
      if (!run) {
        throw new Error(`Run ${runId} not found`);
      }

      // Fetch thinking blocks (step_type='thinking')
      const thinkingBlocks = await dbManager.getStepsForRun(runId, 'thinking');

      // Fetch tool calls for context
      const toolCalls = await dbManager.getToolCallsForRun(runId);
      const toolSummary = toolCalls.map(t => `${t.tool_name} (turn ${t.turn_number})`).join(', ');

      // NEW: Fetch and read artifact contents
      const artifactContents = await this._readArtifacts(run.job_id, run.artifacts_json);

      // Check if we have ANY content to extract from
      if (thinkingBlocks.length === 0 && artifactContents.length === 0) {
        console.log(`No thinking blocks or artifacts found for run ${runId}`);
        return [];
      }

      console.log(`Extracting hypotheses from:
  - Thinking blocks: ${thinkingBlocks.length}
  - Artifact files: ${artifactContents.length} (${artifactContents.map(a => a.name).join(', ') || 'none'})`);

      // Build extraction prompt
      const isGenomicDataset = datasetDomain === 'genomics';

      const systemPrompt = `You are a machine learning feature engineering specialist analyzing an AI agent's analysis.

Your task is to extract FEATURE IMPORTANCE HYPOTHESES and MODEL BUILDING INSIGHTS from the agent's outputs (reports, analysis files) and reasoning trace.

${isGenomicDataset ? `**GENOMIC DATASET MODE - CRITICAL INSTRUCTIONS:**
1. **Primary Source**: Use the alzkb-graph-query skill to query the knowledge graph for disease-associated genes, pathways, and known biomarkers
2. **Feature Hypotheses**: Frame discoveries as "Feature X will have importance > Y in predicting outcome Z"
3. **Multi-hop Reasoning**: Build on previous findings (e.g., "Gene A → Pathway B → Disease C")
4. **Model Performance**: Extract feature importance scores, model metrics, predictive features
5. **Creative Extensions**: Suggest interaction terms, pathway aggregations, or composite features based on knowledge graph findings

Example hypotheses:
- "APOE gene variants will have feature importance > 0.15 in Alzheimer's risk prediction (knowledge graph: APOE ε4 allele strongest genetic risk factor)"
- "Amyloid-beta pathway genes (APP, PSEN1, PSEN2) aggregated will improve model AUC by > 0.05 (knowledge graph: amyloid cascade hypothesis)"
- "Interaction term APOE*MAPT will have importance > 0.10 due to converging tau pathology (knowledge graph multihop: APOE → inflammation → tau phosphorylation)"
` : `**MODEL BUILDING MODE:**
1. **Primary Source**: Extract feature importance scores, model performance metrics from outputs
2. **Feature Hypotheses**: Frame discoveries as "Feature X will have importance > Y in predicting outcome Z"
3. **Model Performance**: Extract actual importance scores, AUC, accuracy, F1 metrics
4. **Creative Extensions**: Suggest interaction terms, transformations, or composite features

`}
Requirements:
1. **PRIMARY SOURCE**: Extract from generated outputs (reports, analysis files) - these contain the main findings
2. **SECONDARY SOURCE**: If outputs don't contain hypotheses, use thinking blocks (internal reasoning)
3. Extract 2-4 feature-focused hypotheses
4. Hypotheses must be TESTABLE with concrete metrics (importance score, AUC improvement, etc.)
5. Identify ALTERNATIVE_TO relationships (competing feature sets)
6. Identify DERIVED_FROM relationships (feature engineering chains)
7. Each hypothesis must have a confidence score (0.0-1.0) and expected importance threshold

Return ONLY a JSON object with this structure:
{
  "hypotheses": [
    {
      "hypothesis_text": "Feature-focused claim with expected importance/performance metric",
      "hypothesis_type": "feature_importance" | "model_performance" | "feature_engineering" | "predictive",
      "confidence_score": 0.0-1.0,
      "expected_importance": 0.0-1.0 or null,
      "expected_metric": "AUC > 0.8" or "importance > 0.15" or null,
      "graph_source": "Gene-disease association from knowledge graph" or null,
      "turn_number": <integer>
    }
  ],
  "relationships": [
    {
      "from_index": 0,
      "to_index": 1,
      "edge_type": "ALTERNATIVE_TO" | "DERIVED_FROM" | "DEPENDS_ON",
      "reasoning": "why this relationship exists"
    }
  ]
}

Edge types:
- ALTERNATIVE_TO: Competing feature sets or model approaches
- DERIVED_FROM: Hypothesis B is an engineered feature from hypothesis A
- DEPENDS_ON: Hypothesis B requires hypothesis A's features

If no valid hypotheses can be extracted, return: {"hypotheses": [], "relationships": []}`;

      const thinkingContent = thinkingBlocks.map((block, idx) =>
        `[Turn ${block.step_number}]\n${block.output || block.input || ''}`
      ).join('\n\n');

      // Format artifact contents
      const artifactContent = artifactContents.length > 0
        ? artifactContents.map(a => `[File: ${a.name}]\n${a.content}`).join('\n\n')
        : 'None';

      const userPrompt = `Original task: "${run.prompt}"

${thinkingBlocks.length > 0 ? `Thinking blocks (agent reasoning):
${thinkingContent}

` : ''}${artifactContents.length > 0 ? `Generated outputs (reports, analysis files):
${artifactContent}

` : ''}Tools used: ${toolSummary || 'None'}

Extract falsifiable hypotheses from ${artifactContents.length > 0 ? 'the generated outputs and reasoning' : 'this reasoning trace'}.`;

      const message = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: userPrompt
        }],
        system: systemPrompt
      });

      const responseText = message.content[0].text.trim();
      console.log('HypothesisAgent extraction response:', responseText.substring(0, 200) + '...');

      // Parse JSON response with robust extraction
      let jsonText = this._extractJSON(responseText);

      if (!jsonText) {
        console.error('Failed to extract JSON from response:', responseText);
        throw new Error('Could not find valid JSON in AI response');
      }

      const extractionResult = JSON.parse(jsonText);

      // Handle both array format and next_hypothesis.json format
      let hypotheses = [];
      let relationships = [];

      if (Array.isArray(extractionResult)) {
        // Old format: array of hypotheses
        hypotheses = extractionResult;
      } else if (extractionResult.hypotheses && Array.isArray(extractionResult.hypotheses)) {
        // New format: {hypotheses: [...], relationships: [...]}
        hypotheses = extractionResult.hypotheses;
        relationships = extractionResult.relationships || [];
      } else {
        console.warn('HypothesisAgent returned unexpected format, defaulting to empty array');
        return [];
      }

      // Filter hypotheses based on config (if provided)
      if (hypothesisConfig) {
        const originalCount = hypotheses.length;
        hypotheses = this._filterHypothesesByConfig(hypotheses, hypothesisConfig);
        if (hypotheses.length < originalCount) {
          console.log(`Filtered hypotheses: ${originalCount} → ${hypotheses.length} (config: ${hypothesisConfig.featureImportance}% FI, ${hypothesisConfig.featureEngineering}% FE)`);
        }
      }

      // Insert hypotheses into database
      const hypothesisIds = [];
      for (const hyp of hypotheses) {
        // Calculate priority from confidence score
        // Higher confidence = lower priority number = higher priority
        // Range: confidence 1.0 → priority 100, confidence 0.0 → priority 1000
        const priority = this._calculatePriorityFromConfidence(hyp.confidence_score);

        const hypothesisId = await dbManager.createHypothesis({
          run_id: runId,
          turn_number: hyp.turn_number || 1,
          hypothesis_text: hyp.hypothesis_text,
          hypothesis_type: hyp.hypothesis_type,
          confidence_score: hyp.confidence_score,
          status: 'proposed',
          expected_importance: hyp.expected_importance || null,
          expected_metric: hyp.expected_metric || null,
          graph_source: hyp.graph_source || null,
          feature_name: extractFeatureName(hyp.hypothesis_text),
          priority: priority
        });

        hypothesisIds.push({
          hypothesis_id: hypothesisId,
          ...hyp
        });
      }

      console.log(`Extracted ${hypothesisIds.length} hypotheses from run ${runId}`);
      return hypothesisIds;

    } catch (error) {
      console.error('Failed to extract hypotheses:', error);
      throw error;
    }
  }

  /**
   * Request evidence for a hypothesis
   * @param {number} hypothesisId - Hypothesis ID
   * @param {Object} options - Optional evidence request options
   * @param {string} options.datasetDomain - Dataset domain (e.g., 'genomics', 'clinical_trial')
   * @returns {Promise<Object>} - Evidence request specification
   */
  async requestEvidence(hypothesisId, options = {}) {
    const { datasetDomain } = options;

    if (!this.anthropic) {
      // Degraded mode: return simple template
      const hypothesis = await dbManager.getHypothesis(hypothesisId);
      return {
        evidence_type: 'observation',
        task_prompt: `Gather evidence to test hypothesis: "${hypothesis.hypothesis_text}"`,
        expected_outcome_if_supported: 'Evidence confirms the hypothesis',
        expected_outcome_if_rejected: 'Evidence contradicts the hypothesis',
        suggested_tools: ['Read', 'Bash']
      };
    }

    try {
      // Fetch hypothesis and existing evidence
      const hypothesisData = await dbManager.getHypothesisWithEvidence(hypothesisId);
      if (!hypothesisData) {
        throw new Error(`Hypothesis ${hypothesisId} not found`);
      }

      const existingEvidenceSummary = hypothesisData.evidence.length > 0
        ? hypothesisData.evidence.map(e => `- ${e.evidence_type}: ${e.evidence_text} (${e.supports ? 'supports' : 'contradicts'})`).join('\n')
        : 'No evidence collected yet';

      const isGenomicDataset = datasetDomain === 'genomics';

      const systemPrompt = `You are a scientific experiment designer.

Your task is to design a concrete experiment or data analysis to test a hypothesis.

The experiment must be:
1. SPECIFIC - clear steps an execution agent can perform
2. FEASIBLE - can be done with available tools (Read, Bash, Write)
3. OBJECTIVE - produces measurable results
4. DECISIVE - helps determine if hypothesis is true or false${isGenomicDataset ? '\n5. **For genomic hypotheses**: Use the alzkb-graph-query skill to query the knowledge graph for gene-disease associations, pathway information, and molecular mechanisms' : ''}

Return ONLY a JSON object with this structure:
{
  "evidence_type": "observation" | "experiment" | "statistical_test",
  "task_prompt": "Detailed task for Claude Code execution agent to perform",
  "expected_outcome_if_supported": "what results would confirm hypothesis",
  "expected_outcome_if_rejected": "what results would contradict hypothesis",
  "suggested_tools": ["Read", "Bash", "Write"]
}`;

      const userPrompt = `Hypothesis: "${hypothesisData.hypothesis_text}"
Type: ${hypothesisData.hypothesis_type}
Current confidence: ${hypothesisData.confidence_score || 'unknown'}

Existing evidence:
${existingEvidenceSummary}

Design an experiment or analysis to test this hypothesis.`;

      const message = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: userPrompt
        }],
        system: systemPrompt
      });

      const responseText = message.content[0].text.trim();

      // Parse JSON response with robust extraction
      let jsonText = this._extractJSON(responseText);
      if (!jsonText) {
        throw new Error('Could not extract valid JSON from AI response');
      }

      const evidenceRequest = JSON.parse(jsonText);

      // Update hypothesis status to 'test_requested'
      await dbManager.updateHypothesis(hypothesisId, {
        status: 'test_requested',
        requested_evidence_type: evidenceRequest.evidence_type,
        requested_agent_action: evidenceRequest.task_prompt
      });

      console.log(`Generated evidence request for hypothesis ${hypothesisId}`);
      return evidenceRequest;

    } catch (error) {
      console.error('Failed to request evidence:', error);
      throw error;
    }
  }

  /**
   * Evaluate hypothesis against collected evidence
   * @param {number} hypothesisId - Hypothesis ID
   * @returns {Promise<Object>} - Evaluation result
   */
  async evaluateHypothesis(hypothesisId) {
    if (!this.anthropic) {
      throw new Error('HypothesisAgent AI mode required for evaluation');
    }

    try {
      // Fetch hypothesis with all evidence
      const hypothesisData = await dbManager.getHypothesisWithEvidence(hypothesisId);
      if (!hypothesisData) {
        throw new Error(`Hypothesis ${hypothesisId} not found`);
      }

      if (hypothesisData.evidence.length === 0) {
        throw new Error(`No evidence found for hypothesis ${hypothesisId}`);
      }

      const evidenceList = hypothesisData.evidence.map((e, idx) =>
        `${idx + 1}. [${e.evidence_type}] ${e.evidence_text || '(no description)'}\n   ${e.supports ? 'SUPPORTS' : 'CONTRADICTS'} (confidence: ${e.confidence_score || 'unknown'})\n   Tool: ${e.tool_name || 'manual'}`
      ).join('\n\n');

      const systemPrompt = `You are a scientific evaluator.

Your task is to objectively assess whether evidence supports, contradicts, or is inconclusive about a hypothesis.

Evaluation criteria:
1. STRENGTH - How strong is the evidence?
2. CONSISTENCY - Does all evidence point the same direction?
3. SIGNIFICANCE - Are results statistically/practically significant?
4. COMPLETENESS - Is there enough evidence to decide?

Return ONLY a JSON object with this structure:
{
  "status": "supported" | "rejected" | "needs_more_data",
  "updated_confidence": 0.0-1.0,
  "reasoning": "detailed explanation of evaluation (2-3 sentences)",
  "suggested_next_action": "accept" | "reject" | "request_more_evidence" | "revise_hypothesis"
}`;

      const userPrompt = `Hypothesis: "${hypothesisData.hypothesis_text}"
Type: ${hypothesisData.hypothesis_type}
Initial confidence: ${hypothesisData.confidence_score || 'unknown'}

Evidence collected:
${evidenceList}

Evaluate this hypothesis based on the evidence.`;

      const message = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: userPrompt
        }],
        system: systemPrompt
      });

      const responseText = message.content[0].text.trim();

      // Parse JSON response with robust extraction
      let jsonText = this._extractJSON(responseText);
      if (!jsonText) {
        throw new Error('Could not extract valid JSON from AI response');
      }

      const evaluation = JSON.parse(jsonText);

      // Update hypothesis with evaluation results
      await dbManager.updateHypothesis(hypothesisId, {
        status: evaluation.status,
        confidence_score: evaluation.updated_confidence,
        evaluation_reasoning: evaluation.reasoning
      });

      console.log(`Evaluated hypothesis ${hypothesisId}: ${evaluation.status}`);
      return evaluation;

    } catch (error) {
      console.error('Failed to evaluate hypothesis:', error);
      throw error;
    }
  }

  /**
   * Revise hypothesis based on partial evidence
   * @param {number} hypothesisId - Original hypothesis ID
   * @param {string} revisionReason - Why revision is needed
   * @returns {Promise<number>} - New hypothesis ID
   */
  async reviseHypothesis(hypothesisId, revisionReason) {
    if (!this.anthropic) {
      throw new Error('HypothesisAgent AI mode required for revision');
    }

    try {
      // Fetch original hypothesis and evidence
      const originalData = await dbManager.getHypothesisWithEvidence(hypothesisId);
      if (!originalData) {
        throw new Error(`Hypothesis ${hypothesisId} not found`);
      }

      const evidenceList = originalData.evidence.map((e, idx) =>
        `${idx + 1}. ${e.evidence_text} (${e.supports ? 'supports' : 'contradicts'})`
      ).join('\n');

      const systemPrompt = `You are a scientific hypothesis refiner.

Your task is to revise a hypothesis based on partial or contradictory evidence.

The revised hypothesis should:
1. Address weaknesses in the original
2. Incorporate insights from evidence
3. Remain falsifiable and testable
4. Be more specific or nuanced

Return ONLY a JSON object with this structure:
{
  "revised_hypothesis_text": "new specific falsifiable claim",
  "hypothesis_type": "causal" | "correlational" | "structural" | "predictive",
  "confidence_score": 0.0-1.0,
  "revision_reasoning": "explanation of how this improves on original"
}`;

      const userPrompt = `Original hypothesis: "${originalData.hypothesis_text}"
Type: ${originalData.hypothesis_type}
Confidence: ${originalData.confidence_score || 'unknown'}

Evidence so far:
${evidenceList || 'None'}

Reason for revision: ${revisionReason}

Propose a revised hypothesis that addresses these issues.`;

      const message = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: userPrompt
        }],
        system: systemPrompt
      });

      const responseText = message.content[0].text.trim();

      // Parse JSON response with robust extraction
      let jsonText = this._extractJSON(responseText);
      if (!jsonText) {
        throw new Error('Could not extract valid JSON from AI response');
      }

      const revision = JSON.parse(jsonText);

      // Calculate priority from confidence score
      const priority = this._calculatePriorityFromConfidence(revision.confidence_score);

      // Create new hypothesis with parent link
      const newHypothesisId = await dbManager.createHypothesis({
        run_id: originalData.run_id,
        turn_number: originalData.turn_number,
        hypothesis_text: revision.revised_hypothesis_text,
        hypothesis_type: revision.hypothesis_type,
        confidence_score: revision.confidence_score,
        status: 'proposed',
        parent_hypothesis_id: hypothesisId,
        priority: priority
      });

      // Mark original as 'revised'
      await dbManager.updateHypothesis(hypothesisId, {
        status: 'revised'
      });

      console.log(`Revised hypothesis ${hypothesisId} → ${newHypothesisId}`);
      return newHypothesisId;

    } catch (error) {
      console.error('Failed to revise hypothesis:', error);
      throw error;
    }
  }

  /**
   * Propose next action in hypothesis lifecycle (state machine logic)
   * @param {number} hypothesisId - Hypothesis ID
   * @returns {Promise<Object>} - { action, reasoning }
   */
  async proposeNextAction(hypothesisId) {
    const hypothesis = await dbManager.getHypothesisWithEvidence(hypothesisId);
    if (!hypothesis) {
      throw new Error(`Hypothesis ${hypothesisId} not found`);
    }

    const evidenceCount = hypothesis.evidence.length;

    // State machine logic
    switch (hypothesis.status) {
      case 'proposed':
        return {
          action: 'request_evidence',
          reasoning: 'Hypothesis needs initial evidence collection'
        };

      case 'test_requested':
        return {
          action: 'wait_for_evidence',
          reasoning: 'Waiting for execution agent to gather evidence'
        };

      case 'evidence_collected':
        return {
          action: 'evaluate',
          reasoning: `Evidence has been collected (${evidenceCount} pieces), ready for evaluation`
        };

      case 'supported':
        return {
          action: 'accept',
          reasoning: 'Hypothesis is supported by evidence, consider accepting'
        };

      case 'rejected':
        return {
          action: 'reject',
          reasoning: 'Hypothesis is contradicted by evidence, consider rejecting'
        };

      case 'needs_more_data':
        return {
          action: 'request_evidence',
          reasoning: 'Previous evidence was inconclusive, need more data'
        };

      case 'revised':
        return {
          action: 'follow_revision',
          reasoning: 'This hypothesis has been revised, follow the new version'
        };

      default:
        return {
          action: 'unknown',
          reasoning: `Unknown status: ${hypothesis.status}`
        };
    }
  }

  /**
   * Link a completed job's tool calls as evidence for a hypothesis
   * @param {string} runId - Execution run ID
   * @param {number} hypothesisId - Hypothesis ID
   */
  async linkJobAsEvidence(runId, hypothesisId) {
    try {
      const toolCalls = await dbManager.getToolCallsForRun(runId);

      if (toolCalls.length === 0) {
        console.log(`No tool calls found for run ${runId}, skipping evidence linking`);
        return;
      }

      // Link each successful tool call as evidence (assuming supports by default)
      const evidenceList = toolCalls
        .filter(tc => tc.success)
        .map(tc => ({
          hypothesis_id: hypothesisId,
          tool_call_id: tc.tool_call_id,
          evidence_type: 'observation',
          evidence_text: `Tool: ${tc.tool_name}`,
          supports: true, // Default to supporting, can be manually adjusted
          confidence_score: 0.7
        }));

      if (evidenceList.length > 0) {
        await dbManager.createEvidenceBatch(evidenceList);

        // Update hypothesis status to 'evidence_collected'
        await dbManager.updateHypothesis(hypothesisId, {
          status: 'evidence_collected'
        });

        console.log(`Linked ${evidenceList.length} tool calls as evidence for hypothesis ${hypothesisId}`);
      }

    } catch (error) {
      console.error('Failed to link job as evidence:', error);
      throw error;
    }
  }

  /**
   * Generate next hypothesis based on normalized dataset context and hypothesis history
   *
   * Uses:
   * 1. Normalized dataset context (semantic.json, confidence.json)
   * 2. Previous hypotheses for the dataset (workflow history)
   * 3. Current hypothesis states (proposed, supported, rejected, needs_more_data)
   * 4. Hypothesis generation config (feature importance vs feature engineering mix)
   *
   * @param {string} datasetId - Dataset ID
   * @param {Object} state - Application state (for dataset metadata)
   * @param {Object} hypothesisConfig - Hypothesis generation config {featureImportance, featureEngineering}
   * @returns {Promise<Object>} - Next hypothesis suggestion
   */
  async generateNextHypothesis(datasetId, state, hypothesisConfig = null) {
    if (!this.anthropic) {
      console.log('HypothesisAgent: No AI client available, cannot generate next hypothesis');
      return {
        success: false,
        error: 'AI mode not available'
      };
    }

    try {
      // 1. Load and validate hypothesis config
      const config = hypothesisConfig || {
        featureImportance: 100,
        featureEngineering: 0
      };

      // Validate percentages sum to 100
      const total = config.featureImportance + config.featureEngineering;
      if (total !== 100) {
        throw new Error(`Hypothesis config percentages must sum to 100 (got ${total})`);
      }

      // 2. Load normalized dataset context
      const dataset = state.datasets[datasetId];
      if (!dataset) {
        throw new Error(`Dataset ${datasetId} not found`);
      }

      // Build dataset context — use normalization pipeline output if available,
      // otherwise fall back to raw metadata so un-normalized datasets work too.
      const normalization = dataset.normalization;
      const datasetContext = normalization
        ? {
            domain:       normalization.semanticMetadata?.domain       || 'general',
            entities:     normalization.semanticMetadata?.entities     || [],
            confidence:   normalization.confidence                     || 'N/A',
            documentType: normalization.documentType                   || 'unknown'
          }
        : {
            domain:       'general',
            entities:     dataset.files || (dataset.filename ? [dataset.filename] : []),
            confidence:   'N/A',
            documentType: 'table_dump'
          };

      // 2. Query all hypotheses for this dataset
      const hypotheses = await dbManager.getHypothesesForDataset(datasetId);

      // 3. Group hypotheses by status
      const hypothesisByStatus = {
        proposed: hypotheses.filter(h => h.status === 'proposed'),
        test_requested: hypotheses.filter(h => h.status === 'test_requested'),
        evidence_collected: hypotheses.filter(h => h.status === 'evidence_collected'),
        supported: hypotheses.filter(h => h.status === 'supported'),
        rejected: hypotheses.filter(h => h.status === 'rejected'),
        needs_more_data: hypotheses.filter(h => h.status === 'needs_more_data'),
        revised: hypotheses.filter(h => h.status === 'revised')
      };

      // 3. Build context-aware prompt with config-based weighting
      const isGenomicDataset = datasetContext.domain === 'genomics';

      // Build weighted focus instructions
      let focusInstructions = '';
      if (config.featureImportance === 100) {
        focusInstructions = 'Your focus should be 100% on feature importance testing (testing individual features from the knowledge graph or dataset).';
      } else if (config.featureEngineering === 100) {
        focusInstructions = 'Your focus should be 100% on creative feature engineering (interaction terms, aggregations, transformations).';
      } else {
        focusInstructions = `Your focus should be ${config.featureImportance}% on feature importance testing and ${config.featureEngineering}% on creative feature engineering.`;
      }

      const systemPrompt = `You are a machine learning feature engineering strategist specializing in predictive modeling.

Your task is to suggest the NEXT FEATURE to investigate for model building based on:
1. Dataset domain and semantic context
2. Previous feature importance discoveries (what worked, what didn't)
3. Multi-hop reasoning to identify novel feature combinations

**HYPOTHESIS GENERATION STRATEGY:** ${focusInstructions}

${isGenomicDataset ? `**GENOMIC DATASET - KNOWLEDGE GRAPH WORKFLOW:**

${config.featureImportance > 0 ? `**FEATURE IMPORTANCE FOCUS (${config.featureImportance}%):**
1. **First Pass (if no features tested yet)**: Use the alzkb-graph-query skill to get ALL genes associated with the target disease
   - Example: invoke alzkb-graph-query to get all genes associated with Alzheimer's disease
   - Expected: List of 20-50 genes (APOE, APP, PSEN1, PSEN2, MAPT, TREM2, etc.)
   - Hypothesis: "Feature set of knowledge graph Alzheimer's genes will achieve AUC > 0.75"

2. **Multi-hop Reasoning (after first pass)**: Use the alzkb-graph-query skill to explore related pathways
   - Example: invoke alzkb-graph-query to get genes in the amyloid-beta processing pathway
   - Example: invoke alzkb-graph-query to get genes that interact with APOE
   - Test individual genes from pathways

` : ''}${config.featureEngineering > 0 ? `**FEATURE ENGINEERING FOCUS (${config.featureEngineering}%):**
1. **Interaction Terms**: Gene-gene interactions based on knowledge graph findings
   - APOE*MAPT (converging pathology pathways)
   - APP*PSEN1 (amyloid processing cascade)

2. **Pathway Aggregations**: Combine genes in functional pathways
   - sum(amyloid_genes * weights)
   - avg(tau_pathway_genes)

3. **Expression Ratios**: Regulatory relationships
   - APP/BACE1 (substrate/enzyme ratio)
   - MAPT/GSK3B (tau/kinase ratio)

` : ''}**Expected Format:**
{
  "hypothesis_text": "Feature '[GENE_NAME or COMPOSITE]' from knowledge graph [disease] association will have importance > [threshold]",
  "hypothesis_type": "feature_importance" | "feature_engineering" | "model_performance",
  "confidence_score": 0.0-1.0,
  "expected_importance": 0.0-1.0,
  "expected_metric": "importance > 0.15" or "AUC > 0.75",
  "graph_source": "knowledge graph: GENE → DISEASE association" or "knowledge graph: PATHWAY analysis",
  "reasoning": "why this feature matters (knowledge graph evidence + ML rationale)",
  "builds_on": "hypothesis_id or null",
  "explores": "specific gene/pathway/interaction"
}` : `**MODEL BUILDING MODE:**

${config.featureImportance > 0 ? `**FEATURE IMPORTANCE FOCUS (${config.featureImportance}%):**
- Test individual features from the dataset
- Extract importance scores from trained models
- Identify top predictive features

` : ''}${config.featureEngineering > 0 ? `**FEATURE ENGINEERING FOCUS (${config.featureEngineering}%):**
- Create interaction terms between important features
- Build polynomial features (feature^2, feature^3)
- Aggregate related features (sums, averages, weighted combinations)
- Domain-specific transformations

` : ''}Guidelines:
- Build on SUPPORTED features (extend with interactions, transformations)
- Avoid REJECTED features (don't repeat failures)
- Address NEEDS_MORE_DATA features (collect more evidence)
- **CRITICAL: Do NOT suggest features that are already PENDING/PROPOSED** (avoid duplicates)
- Frame as: "Feature X will have importance > Y in predicting outcome Z"

**Expected Format:**
{
  "hypothesis_text": "Feature '[FEATURE_NAME]' will have importance > [threshold]",
  "hypothesis_type": "feature_importance" | "feature_engineering" | "model_performance",
  "confidence_score": 0.0-1.0,
  "expected_importance": 0.0-1.0,
  "expected_metric": "importance > 0.15" or "AUC > 0.75",
  "reasoning": "why this feature matters (domain knowledge + ML rationale)",
  "builds_on": "hypothesis_id or null",
  "explores": "specific feature/interaction"
}`}

Return a JSON object with the structure above.`;

      const pendingHypotheses = [
        ...hypothesisByStatus.proposed,
        ...hypothesisByStatus.test_requested,
        ...hypothesisByStatus.evidence_collected
      ];

      const totalHypotheses = hypotheses.length;
      const supportedFeatures = hypothesisByStatus.supported.map(h =>
        `${h.feature_name || 'Unknown'}: ${h.hypothesis_text} (importance: ${h.actual_importance || 'pending'})`
      ).join('\n  ');

      const rejectedFeatures = hypothesisByStatus.rejected.map(h =>
        `${h.feature_name || 'Unknown'}: ${h.hypothesis_text}`
      ).join('\n  ');

      const userPrompt = `Dataset Context:
- Domain: ${datasetContext.domain}${isGenomicDataset ? ' **→ USE KNOWLEDGE GRAPH SKILL FOR FEATURE DISCOVERY**' : ''}
- Available Entities/Columns: ${datasetContext.entities.join(', ') || 'Unknown'}
- Data Quality Confidence: ${datasetContext.confidence}
- Document Type: ${datasetContext.documentType}

${isGenomicDataset && totalHypotheses === 0 ? `
**FIRST PASS REQUIRED:**
This is the FIRST hypothesis for this genomic dataset. You MUST:
1. Use the alzkb-graph-query skill to get ALL genes associated with the target disease (infer from entities: ${datasetContext.entities.join(', ')})
2. Suggest testing ALL returned genes as a feature set
3. Expected format: "knowledge graph query: [disease] associated genes → Feature set of [N] genes will achieve AUC > [threshold]"

Do NOT suggest individual genes yet. Start with the comprehensive knowledge graph gene list.
` : ''}

Feature Discovery History:
- **Supported Features (${hypothesisByStatus.supported.length})**:
  ${supportedFeatures || 'None yet'}

- **Rejected Features (${hypothesisByStatus.rejected.length})**:
  ${rejectedFeatures || 'None yet'}

- **Needs More Evidence (${hypothesisByStatus.needs_more_data.length})**:
  ${hypothesisByStatus.needs_more_data.map(h => h.hypothesis_text).join('\n  ') || 'None'}

**PENDING/PROPOSED FEATURES (DO NOT DUPLICATE - ${pendingHypotheses.length})**:
${pendingHypotheses.length > 0 ? pendingHypotheses.map((h, i) =>
  `${i + 1}. ${h.feature_name || 'Unknown'}: ${h.hypothesis_text}${h.graph_source ? ` (${h.graph_source})` : ''}`
).join('\n') : 'None'}

${isGenomicDataset ? `
**KNOWLEDGE GRAPH STRATEGY:**
- If FIRST hypothesis: Use alzkb-graph-query skill for comprehensive disease gene list
- If genes tested: Use alzkb-graph-query skill for pathway information, gene interactions
- If pathways explored: Suggest creative composite features based on knowledge graph findings
` : ''}

Based on this context, suggest the NEXT FEATURE to test that is NOT already pending.`;

      const message = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: userPrompt
        }],
        system: systemPrompt
      });

      const responseText = message.content[0].text.trim();
      console.log('HypothesisAgent next hypothesis response:', responseText.substring(0, 200) + '...');

      // Parse JSON response with robust extraction
      let jsonText = this._extractJSON(responseText);
      if (!jsonText) {
        throw new Error('Could not extract valid JSON from AI response');
      }

      const nextHypothesis = JSON.parse(jsonText);

      // 5. Deduplication check: Verify suggested hypothesis doesn't already exist
      const normalizedSuggestion = nextHypothesis.hypothesis_text.toLowerCase().trim();
      const duplicateHypothesis = hypotheses.find(h =>
        h.hypothesis_text.toLowerCase().trim() === normalizedSuggestion
      );

      if (duplicateHypothesis) {
        console.warn(`HypothesisAgent: Suggested hypothesis already exists (ID: ${duplicateHypothesis.hypothesis_id}, status: ${duplicateHypothesis.status})`);
        return {
          success: false,
          error: 'Duplicate hypothesis detected',
          duplicate: {
            hypothesis_id: duplicateHypothesis.hypothesis_id,
            hypothesis_text: duplicateHypothesis.hypothesis_text,
            status: duplicateHypothesis.status
          },
          suggestion: nextHypothesis
        };
      }

      // 6. Select recommended skills based on config
      const recommendedSkills = this._selectSkillsByConfig(config, isGenomicDataset, nextHypothesis.hypothesis_type);

      return {
        success: true,
        hypothesis: nextHypothesis,
        recommendedSkills,  // NEW: skills to inject
        config: config,  // NEW: config used
        context: {
          datasetId,
          domain: datasetContext.domain,
          totalHypotheses: hypotheses.length,
          supportedCount: hypothesisByStatus.supported.length,
          rejectedCount: hypothesisByStatus.rejected.length,
          pendingCount: hypothesisByStatus.proposed.length + hypothesisByStatus.test_requested.length + hypothesisByStatus.evidence_collected.length
        }
      };

    } catch (error) {
      console.error('Failed to generate next hypothesis:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Calculate priority from confidence score
   * Higher confidence → lower priority number → higher priority in queue
   * @param {number} confidence - Confidence score (0.0-1.0)
   * @returns {number} - Priority value (100-1000)
   */
  _calculatePriorityFromConfidence(confidence) {
    // Default to 1000 if confidence is not provided or invalid
    if (confidence === null || confidence === undefined || typeof confidence !== 'number') {
      return 1000;
    }

    // Clamp confidence to 0.0-1.0 range
    const clampedConfidence = Math.max(0, Math.min(1, confidence));

    // Calculate priority: confidence 1.0 → 100, confidence 0.0 → 1000
    // Formula: 1000 - (confidence * 900)
    const priority = Math.floor(1000 - (clampedConfidence * 900));

    return priority;
  }

  /**
   * Extract JSON from AI response (handles thinking blocks, markdown, conversational text)
   * @param {string} responseText - Raw AI response text
   * @returns {string|null} - Extracted JSON string or null if not found
   */
  _extractJSON(responseText) {
    // Remove thinking blocks first
    let cleaned = responseText.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');

    // Helper function to fix common JSON issues
    const fixCommonJSONIssues = (jsonStr) => {
      return jsonStr
        // Fix trailing commas before closing braces/brackets
        .replace(/,(\s*[}\]])/g, '$1')
        // Fix malformed numbers like "0." → "0.0"
        .replace(/:\s*0\./g, ': 0.0')
        .replace(/:\s*(\d+)\./g, ': $1.0')
        // Fix incomplete numbers at end of line
        .replace(/:\s*0\.\s*[,\n}]/g, ': 0.0$1');
    };

    // Helper function to try completing incomplete JSON
    const tryCompleteJSON = (jsonStr) => {
      let completed = jsonStr.trim();

      // Strategy: Find the last complete object (ending with }) and truncate after it
      // This removes partial/incomplete objects at the end

      // Find all object endings (})
      const objectEndings = [];
      for (let i = 0; i < completed.length; i++) {
        if (completed[i] === '}') {
          objectEndings.push(i);
        }
      }

      // Try parsing progressively from the last complete object backwards
      for (let i = objectEndings.length - 1; i >= 0; i--) {
        const truncatePoint = objectEndings[i] + 1;
        let candidate = completed.substring(0, truncatePoint);

        // Count structures to see if we need to close anything
        const openBraces = (candidate.match(/\{/g) || []).length;
        const closeBraces = (candidate.match(/\}/g) || []).length;
        const openBrackets = (candidate.match(/\[/g) || []).length;
        const closeBrackets = (candidate.match(/\]/g) || []).length;

        // Close missing brackets (arrays)
        for (let j = 0; j < openBrackets - closeBrackets; j++) {
          candidate += ']';
        }
        // Close missing braces (objects)
        for (let j = 0; j < openBraces - closeBraces; j++) {
          candidate += '}';
        }

        // Try parsing this candidate
        try {
          JSON.parse(candidate);
          // Success! Return this valid JSON
          if (truncatePoint < completed.length) {
            console.log('[JSON Extraction] Truncated incomplete data and completed JSON');
          } else {
            console.log('[JSON Extraction] Completed JSON structures');
          }
          return candidate;
        } catch (e) {
          // This candidate didn't work, try the next one
          continue;
        }
      }

      // Fallback: Just try closing all open structures (old behavior)
      const openBraces = (completed.match(/\{/g) || []).length;
      const closeBraces = (completed.match(/\}/g) || []).length;
      const openBrackets = (completed.match(/\[/g) || []).length;
      const closeBrackets = (completed.match(/\]/g) || []).length;

      for (let i = 0; i < openBrackets - closeBrackets; i++) {
        completed += ']';
      }
      for (let i = 0; i < openBraces - closeBraces; i++) {
        completed += '}';
      }

      return completed;
    };

    // Try 1: Extract from markdown code blocks
    if (cleaned.includes('```')) {
      const match = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (match && match[1]) {
        let extracted = match[1].trim();
        extracted = fixCommonJSONIssues(extracted);

        // Try parsing as-is
        try {
          JSON.parse(extracted);
          return extracted;
        } catch (e) {
          // Try completing if incomplete
          const completed = tryCompleteJSON(extracted);
          try {
            JSON.parse(completed);
            console.log('[JSON Extraction] Completed incomplete JSON from code block');
            return completed;
          } catch (e2) {
            // Still invalid
          }
        }
      }
    }

    // Try 2: Find JSON object pattern (starts with { and ends with })
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let extracted = jsonMatch[0];
      extracted = fixCommonJSONIssues(extracted);

      try {
        JSON.parse(extracted);
        return extracted;
      } catch (e) {
        // Try completing if incomplete
        const completed = tryCompleteJSON(extracted);
        try {
          JSON.parse(completed);
          console.log('[JSON Extraction] Completed incomplete JSON object');
          return completed;
        } catch (e2) {
          // Still invalid, continue to next strategy
        }
      }
    }

    // Try 3: Look for JSON array pattern (starts with [ and ends with ])
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      let extracted = arrayMatch[0];
      extracted = fixCommonJSONIssues(extracted);

      try {
        JSON.parse(extracted);
        return extracted;
      } catch (e) {
        const completed = tryCompleteJSON(extracted);
        try {
          JSON.parse(completed);
          console.log('[JSON Extraction] Completed incomplete JSON array');
          return completed;
        } catch (e2) {
          // Still invalid
        }
      }
    }

    // Try 4: Last resort - try parsing the whole cleaned text
    let fullText = cleaned.trim();
    fullText = fixCommonJSONIssues(fullText);

    try {
      JSON.parse(fullText);
      return fullText;
    } catch (e) {
      // Try completing
      const completed = tryCompleteJSON(fullText);
      try {
        JSON.parse(completed);
        console.log('[JSON Extraction] Completed incomplete JSON from full text');
        return completed;
      } catch (e2) {
        // Failed
      }
    }

    return null;
  }

  /**
   * Filter extracted hypotheses based on hypothesis generation config
   * @param {Array<Object>} hypotheses - Extracted hypotheses
   * @param {Object} config - Hypothesis generation config {featureImportance, featureEngineering}
   * @returns {Array<Object>} - Filtered hypotheses
   */
  _filterHypothesesByConfig(hypotheses, config) {
    // Determine which hypothesis types are allowed based on config
    const allowedTypes = [];

    if (config.featureImportance > 0) {
      allowedTypes.push('feature_importance');
      allowedTypes.push('model_performance'); // Related to feature importance
      allowedTypes.push('predictive'); // Related to feature importance
    }

    if (config.featureEngineering > 0) {
      allowedTypes.push('feature_engineering');
    }

    // If config is 100% feature importance, exclude pure feature engineering
    if (config.featureImportance === 100 && config.featureEngineering === 0) {
      return hypotheses.filter(h => h.hypothesis_type !== 'feature_engineering');
    }

    // If config is 100% feature engineering, exclude pure feature importance
    if (config.featureEngineering === 100 && config.featureImportance === 0) {
      return hypotheses.filter(h => h.hypothesis_type === 'feature_engineering');
    }

    // For mixed configs, allow all types (the config affects generation, not extraction)
    return hypotheses;
  }

  /**
   * Select recommended skills based on hypothesis generation config
   * @param {Object} config - Hypothesis generation config
   * @param {boolean} isGenomicDataset - Whether dataset is genomic
   * @param {string} hypothesisType - Type of hypothesis (feature_importance, feature_engineering, etc.)
   * @returns {Array<string>} - Array of skill names
   */
  _selectSkillsByConfig(config, isGenomicDataset, hypothesisType) {
    const skills = [];

    // Always include dataset context and history skills
    skills.push('hypothesis:dataset-context');
    skills.push('hypothesis:hypothesis-history');

    // Select skills based on config weights
    if (config.featureImportance > 0) {
      skills.push('hypothesis:model-feature-importance');
      if (isGenomicDataset) {
        skills.push('sources:alzkb-graph-query');
      }
    }

    if (config.featureEngineering > 0) {
      skills.push('hypothesis:feature-engineering');
    }

    // If hypothesis type explicitly specifies feature_engineering, ensure that skill is included
    if (hypothesisType === 'feature_engineering' && !skills.includes('hypothesis:feature-engineering')) {
      skills.push('hypothesis:feature-engineering');
    }

    return skills;
  }

  /**
   * Read content from text-based artifacts (PRIVATE helper)
   * @param {string} jobId - Job ID
   * @param {string} artifactsJson - JSON string of artifacts array
   * @returns {Promise<Array<{name, content}>>} - Array of artifact contents
   */
  async _readArtifacts(jobId, artifactsJson) {
    if (!jobId || !artifactsJson) {
      return [];
    }

    try {
      // Postgres JSONB columns return already-parsed objects; plain strings need parsing
      const artifacts = typeof artifactsJson === 'string' ? JSON.parse(artifactsJson) : artifactsJson;
      if (!Array.isArray(artifacts) || artifacts.length === 0) {
        return [];
      }

      // Filter for text-based files we can extract hypotheses from
      const textExtensions = ['.md', '.txt', '.json', '.csv', '.log'];
      const textArtifacts = artifacts.filter(a =>
        textExtensions.some(ext => a.name.toLowerCase().endsWith(ext))
      );

      if (textArtifacts.length === 0) {
        console.log(`No text-based artifacts found for job ${jobId}`);
        return [];
      }

      console.log(`Reading ${textArtifacts.length} text artifact(s) for hypothesis extraction`);

      const Docker = require('dockerode');
      const docker = new Docker();
      const artifactContents = [];

      for (const artifact of textArtifacts) {
        try {
          // Read file from Docker volume
          const container = await docker.createContainer({
            Image: 'alpine',
            Cmd: ['cat', artifact.actualPath || artifact.path],
            HostConfig: {
              Binds: [`ecoxai-workspace-${jobId}:/workspace:ro`],
              AutoRemove: false
            }
          });

          await container.start();
          await container.wait();

          const logs = await container.logs({
            stdout: true,
            stderr: false
          });

          const content = logs.toString('utf8');

          // Cleanup
          await container.remove().catch(() => {});

          // Only include if content is reasonable size (< 50KB to avoid token limits)
          if (content.length > 0 && content.length < 50000) {
            artifactContents.push({
              name: artifact.name,
              content: content.trim()
            });
            console.log(`  ✓ Read ${artifact.name} (${content.length} chars)`);
          } else if (content.length >= 50000) {
            // Include truncated version for large files
            artifactContents.push({
              name: artifact.name,
              content: content.substring(0, 50000) + '\n\n[... truncated ...]'
            });
            console.log(`  ⚠ Truncated ${artifact.name} (too large: ${content.length} chars)`);
          }
        } catch (fileError) {
          console.warn(`  ✗ Failed to read ${artifact.name}:`, fileError.message);
          // Continue with other files
        }
      }

      return artifactContents;
    } catch (error) {
      console.error('Error reading artifacts:', error);
      return [];
    }
  }
}

/**
 * Extract feature name from hypothesis text
 * @param {string} hypothesisText - The hypothesis text
 * @returns {string|null} - Extracted feature name or null
 */
function extractFeatureName(hypothesisText) {
  // Try to extract feature names from common patterns
  const patterns = [
    /(?:feature|gene|variable|column)\s+['"]?([A-Za-z0-9_]+)['"]?/i,
    /['"]([A-Z][A-Z0-9_]+)['"].*(?:importance|feature)/i,
    /\b([A-Z][A-Z0-9]{2,})\b/,  // All caps words (gene symbols like APOE, APP)
  ];

  for (const pattern of patterns) {
    const match = hypothesisText.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

// Singleton instance
module.exports = new HypothesisAgent();
