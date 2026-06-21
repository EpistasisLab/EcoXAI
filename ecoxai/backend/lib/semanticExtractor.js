/**
 * Semantic Extractor (Stage 3)
 *
 * Extracts domain metadata:
 * - Entities (drugs, biomarkers, patients, etc.)
 * - Time ranges (start, end, confidence)
 * - Units (mg/dL, %, kg, etc.)
 * - Domain classification (clinical_trial, finance, etc.)
 * - Assumptions (in_vivo, controlled_conditions, etc.)
 *
 * Uses LLM for extraction when ANTHROPIC_API_KEY is available,
 * falls back to rule-based extraction otherwise.
 */

const fs = require('fs').promises;

// Import Anthropic SDK(s) if available
let Anthropic;
let AnthropicFoundry;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch (err) {
  // Standard SDK not available
}
try {
  AnthropicFoundry = require('@anthropic-ai/foundry-sdk').default;
} catch (err) {
  // Foundry SDK not available
}
if (!Anthropic && !AnthropicFoundry) {
  console.warn('[SemanticExtractor] No Anthropic SDK available, using rule-based extraction only');
}

/**
 * Extract semantic metadata from content
 *
 * @param {Object} structure - Structure analysis from Stage 1
 * @param {Object} contentResult - Content normalization from Stage 2
 * @returns {Promise<Object>} Semantic metadata
 */
async function extract(structure, contentResult) {
  // Try LLM-based extraction first
  if (shouldUseLLM()) {
    try {
      return await extractWithLLM(structure, contentResult);
    } catch (err) {
      console.warn('[SemanticExtractor] LLM extraction failed, falling back to rules:', err.message);
    }
  }

  // Fall back to rule-based extraction
  return extractWithRules(structure, contentResult);
}

/**
 * Check if LLM extraction is available
 */
function shouldUseLLM() {
  const useFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY === '1';
  const hasDirectKey = !!process.env.ANTHROPIC_API_KEY;
  const hasFoundryKey = !!process.env.ANTHROPIC_FOUNDRY_API_KEY;

  if (useFoundry && hasFoundryKey && AnthropicFoundry) return true;
  if (hasDirectKey && Anthropic) return true;
  return false;
}

/**
 * Extract semantic metadata using LLM (Claude)
 */
async function extractWithLLM(structure, contentResult) {
  console.log('[SemanticExtractor] Using LLM-based extraction');

  // Initialize Anthropic client
  const useFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY === '1';
  let anthropic;

  if (useFoundry && process.env.ANTHROPIC_FOUNDRY_API_KEY && AnthropicFoundry) {
    const resource = process.env.ANTHROPIC_FOUNDRY_RESOURCE || 'cbm-staff-gpt4';
    anthropic = new AnthropicFoundry({
      apiKey: process.env.ANTHROPIC_FOUNDRY_API_KEY,
      resource: resource
    });
  } else {
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL
    });
  }

  // Prepare sample data for LLM
  const sampleData = await prepareSampleData(structure, contentResult);

  // Construct prompt
  const prompt = buildSemanticExtractionPrompt(structure, sampleData);

  // Call Claude
  const model = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-5';

  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('No text content block in LLM response');
  }
  const responseText = textBlock.text;

  // Parse JSON response
  const jsonMatch = responseText.match(/```json\n([\s\S]+?)\n```/);
  if (jsonMatch) {
    const semanticData = JSON.parse(jsonMatch[1]);
    console.log('[SemanticExtractor] LLM extraction successful');
    return semanticData;
  }

  // Try parsing entire response as JSON
  try {
    const semanticData = JSON.parse(responseText);
    console.log('[SemanticExtractor] LLM extraction successful');
    return semanticData;
  } catch (err) {
    console.warn('[SemanticExtractor] Failed to parse LLM response, falling back to rules');
    return extractWithRules(structure, contentResult);
  }
}

/**
 * Prepare sample data for LLM analysis
 */
async function prepareSampleData(structure, contentResult) {
  const samples = [];

  // Get sample from each table artifact
  // Cap at ~4000 chars per artifact to avoid exceeding LLM token limits
  // (wide genomics datasets can have hundreds of columns per row)
  const MAX_TABLE_SAMPLE_CHARS = 4000;
  for (const artifact of contentResult.artifacts.filter(a => a.type === 'table')) {
    try {
      // Feather files are binary — build sample from column metadata instead
      if (artifact.format === 'feather') {
        const meta = JSON.parse(require('fs').readFileSync(artifact.metadata_path, 'utf8'));
        const colList = meta.columns.slice(0, 50).map(c => `${c.name} (${c.type})`).join(', ');
        samples.push({
          artifact_id: artifact.id,
          type: 'table',
          sample: `Feather table: ${meta.row_count} rows × ${meta.column_count} columns\nColumns: ${colList}${meta.column_count > 50 ? ` ... (+${meta.column_count - 50} more)` : ''}`
        });
        continue;
      }

      const content = await fs.readFile(artifact.path, 'utf8');
      const lines = content.split('\n').slice(0, 6); // Header + 5 rows
      let sample = lines.join('\n');

      if (sample.length > MAX_TABLE_SAMPLE_CHARS) {
        // For wide tables, truncate each line to keep first N columns
        const header = lines[0].split(',');
        const maxCols = Math.min(header.length, 30); // At most 30 columns
        sample = lines.map(line => {
          const cols = line.split(',');
          return cols.slice(0, maxCols).join(',') + (cols.length > maxCols ? ',... (+' + (cols.length - maxCols) + ' more columns)' : '');
        }).join('\n');
      }

      samples.push({
        artifact_id: artifact.id,
        type: 'table',
        sample
      });
    } catch (err) {
      console.warn(`[SemanticExtractor] Failed to read artifact ${artifact.id}:`, err.message);
    }
  }

  // Get sample from narrative artifacts
  for (const artifact of contentResult.artifacts.filter(a => a.type === 'narrative')) {
    try {
      const content = await fs.readFile(artifact.path, 'utf8');
      const preview = content.substring(0, 1000); // First 1000 chars

      samples.push({
        artifact_id: artifact.id,
        type: 'narrative',
        sample: preview
      });
    } catch (err) {
      console.warn(`[SemanticExtractor] Failed to read artifact ${artifact.id}:`, err.message);
    }
  }

  return samples;
}

/**
 * Build semantic extraction prompt for LLM
 */
function buildSemanticExtractionPrompt(structure, sampleData) {
  return `You are a data semantics expert. Analyze the following dataset samples and extract structured metadata.

**Document Type:** ${structure.document_type}
**Layout Complexity:** ${structure.layout_complexity}

**Sample Data:**

${sampleData.map(s => `### ${s.artifact_id} (${s.type})

\`\`\`
${s.sample}
\`\`\`
`).join('\n')}

Extract the following metadata and return as JSON:

{
  "entities": ["list", "of", "key", "entities"],
  "time_range": {
    "start": "YYYY-MM-DD or null",
    "end": "YYYY-MM-DD or null",
    "inferred": true/false,
    "confidence": 0.0-1.0
  },
  "units": {
    "column_name": "unit",
    ...
  },
  "domain": "clinical_trial | finance | retail | manufacturing | research | genomics | general",
  "assumptions": ["assumption1", "assumption2"]
}

**Guidelines:**
- entities: Extract nouns that are domain-specific (drugs, biomarkers, products, etc.)
- time_range: Detect date columns or temporal references
- units: Map column names to measurement units (mg/dL, %, kg, USD, etc.)
- domain: Classify the dataset's subject area
- assumptions: Infer experimental conditions or data collection context

Return ONLY the JSON object, no explanation.`;
}

/**
 * Extract semantic metadata using rule-based approach
 */
function extractWithRules(structure, contentResult) {
  console.log('[SemanticExtractor] Using rule-based extraction');

  const semantic = {
    entities: [],
    time_range: {
      start: null,
      end: null,
      inferred: false,
      confidence: 0.0
    },
    units: {},
    domain: 'general',
    assumptions: []
  };

  // Extract entities from column names (for tables)
  const tableArtifacts = contentResult.artifacts.filter(a => a.type === 'table');

  for (const artifact of tableArtifacts) {
    // Use metadata if available
    if (artifact.metadata_path) {
      try {
        const metadataContent = require('fs').readFileSync(artifact.metadata_path, 'utf8');
        const metadata = JSON.parse(metadataContent);

        // Extract entities from column names
        const columnNames = metadata.columns.map(c => c.name.toLowerCase());

        // Detect domain-specific keywords
        const clinicalKeywords = ['patient', 'drug', 'dose', 'glucose', 'hba1c', 'insulin', 'weight', 'biomarker'];
        const financeKeywords = ['price', 'revenue', 'profit', 'stock', 'transaction', 'amount', 'balance'];
        const researchKeywords = ['experiment', 'trial', 'control', 'sample', 'measurement', 'observation'];
        const genomicKeywords = ['gene', 'snp', 'variant', 'chromosome', 'allele', 'genotype', 'phenotype', 'mutation', 'dna', 'rna', 'sequence', 'expression', 'transcription', 'protein', 'pathway', 'genome', 'exon', 'intron', 'nucleotide', 'base_pair', 'methylation', 'gwas'];

        const hasClinical = columnNames.some(name => clinicalKeywords.some(kw => name.includes(kw)));
        const hasFinance = columnNames.some(name => financeKeywords.some(kw => name.includes(kw)));
        const hasResearch = columnNames.some(name => researchKeywords.some(kw => name.includes(kw)));
        const hasGenomic = columnNames.some(name => genomicKeywords.some(kw => name.includes(kw)));

        if (hasGenomic) {
          semantic.domain = 'genomics';
          semantic.entities.push(...genomicKeywords.filter(kw => columnNames.some(name => name.includes(kw))));
        } else if (hasClinical) {
          semantic.domain = 'clinical_trial';
          semantic.entities.push(...clinicalKeywords.filter(kw => columnNames.some(name => name.includes(kw))));
        } else if (hasFinance) {
          semantic.domain = 'finance';
          semantic.entities.push(...financeKeywords.filter(kw => columnNames.some(name => name.includes(kw))));
        } else if (hasResearch) {
          semantic.domain = 'research';
          semantic.entities.push(...researchKeywords.filter(kw => columnNames.some(name => name.includes(kw))));
        }

        // Detect units from column names
        const unitPatterns = {
          'mg/dl': /glucose|sugar/i,
          '%': /hba1c|percent|pct/i,
          'kg': /weight|mass/i,
          'cm': /height|length/i,
          'mmHg': /pressure|bp|blood_pressure/i,
          'USD': /price|cost|revenue|profit/i,
          'units': /dose|dosage/i
        };

        for (const col of metadata.columns) {
          for (const [unit, pattern] of Object.entries(unitPatterns)) {
            if (pattern.test(col.name)) {
              semantic.units[col.name] = unit;
            }
          }
        }

        // Detect time columns
        const timeColumns = metadata.columns.filter(c =>
          /date|time|timestamp|year|month|day/i.test(c.name)
        );

        if (timeColumns.length > 0) {
          semantic.time_range.inferred = true;
          semantic.time_range.confidence = 0.7;
        }

      } catch (err) {
        console.warn(`[SemanticExtractor] Failed to parse metadata for ${artifact.id}:`, err.message);
      }
    }
  }

  // Deduplicate entities
  semantic.entities = [...new Set(semantic.entities)];

  // Add domain-specific assumptions
  if (semantic.domain === 'clinical_trial') {
    semantic.assumptions.push('human_subjects', 'controlled_conditions');
  } else if (semantic.domain === 'research') {
    semantic.assumptions.push('experimental_data');
  } else if (semantic.domain === 'genomics') {
    semantic.assumptions.push('genetic_data', 'molecular_biology');
  }

  console.log('[SemanticExtractor] Rule-based extraction complete');

  return semantic;
}

module.exports = {
  extract
};
