/**
 * Content Canonicalizer (Stage 2)
 *
 * Converts content to canonical formats:
 * - Tables → CSV + markdown representation + metadata
 * - Narrative → Markdown
 * - Mixed → Separate files for tables and docs
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Canonicalize content based on structural analysis
 *
 * @param {string} rawPath - Path to raw file
 * @param {string} filename - Original filename
 * @param {Object} structure - Structure analysis from Stage 1
 * @param {string} docsDir - Output directory for narrative docs
 * @param {string} tablesDir - Output directory for tables
 * @returns {Promise<Object>} Canonicalization result
 */
async function canonicalize(rawPath, filename, structure, docsDir, tablesDir) {
  const ext = path.extname(filename).toLowerCase();

  const artifacts = [];

  // Special handling for Excel workbooks (binary format)
  if ((ext === '.xlsx' || ext === '.xls') && structure.document_type === 'workbook') {
    artifacts.push(...await canonicalizeWorkbook(rawPath, structure.sections, tablesDir));
  }
  // Special handling for Feather files (binary format)
  else if (ext === '.feather' && structure.document_type === 'table_dump') {
    const featherArtifacts = await canonicalizeFeatherFile(
      rawPath,
      tablesDir
    );
    artifacts.push(...featherArtifacts);
  }
  // Text-based files
  else {
    const content = await fs.readFile(rawPath, 'utf8');

    // Route based on document type
    if (structure.document_type === 'table_dump') {
      // Pure table - convert to canonical CSV
      const tableArtifacts = await canonicalizeTableDump(
        content,
        ext,
        structure.sections,
        tablesDir
      );
      artifacts.push(...tableArtifacts);

  } else if (structure.document_type === 'report') {
    // Pure narrative - convert to markdown
    const docArtifacts = await canonicalizeReport(
      content,
      ext,
      structure.sections,
      docsDir
    );
    artifacts.push(...docArtifacts);

  } else if (structure.document_type === 'mixed') {
    // Mixed content - separate tables and narrative
    const mixedArtifacts = await canonicalizeMixed(
      content,
      ext,
      structure.sections,
      docsDir,
      tablesDir
    );
    artifacts.push(...mixedArtifacts);

  } else if (structure.document_type === 'log') {
    // Log file - convert to markdown with metadata
    const logArtifacts = await canonicalizeLog(
      content,
      structure.sections,
      docsDir
    );
    artifacts.push(...logArtifacts);

    } else {
      // Unknown type - save as narrative
      const unknownArtifacts = await canonicalizeUnknown(
        content,
        filename,
        docsDir
      );
      artifacts.push(...unknownArtifacts);
    }
  }

  return {
    artifacts,
    canonical_formats: artifacts.map(a => a.format),
    total_artifacts: artifacts.length
  };
}

/**
 * Canonicalize table dump (CSV/TSV)
 */
async function canonicalizeTableDump(content, ext, sections, tablesDir) {
  const artifacts = [];

  for (const section of sections.filter(s => s.type === 'table')) {
    const tableId = section.id;
    const delimiter = section.delimiter || (ext === '.tsv' ? '\t' : ',');

    // Parse CSV
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    const rows = lines.map(line => parseCSVLine(line, delimiter));

    if (rows.length === 0) {
      continue;
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);

    // Write canonical CSV
    const csvPath = path.join(tablesDir, `${tableId}.csv`);
    const csvContent = [
      headers.join(','),
      ...dataRows.map(row => row.map(escapeCSV).join(','))
    ].join('\n');

    await fs.writeFile(csvPath, csvContent);

    // Generate markdown representation
    const mdPath = path.join(tablesDir, `${tableId}.md`);
    const mdContent = generateTableMarkdown(headers, dataRows);

    await fs.writeFile(mdPath, mdContent);

    // Generate table metadata
    const metaPath = path.join(tablesDir, `${tableId}_meta.json`);
    const metadata = generateTableMetadata(headers, dataRows);

    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));

    artifacts.push({
      id: tableId,
      type: 'table',
      format: 'csv',
      path: csvPath,
      markdown_path: mdPath,
      metadata_path: metaPath,
      row_count: dataRows.length,
      column_count: headers.length
    });
  }

  return artifacts;
}

/**
 * Canonicalize report (narrative document)
 */
async function canonicalizeReport(content, ext, sections, docsDir) {
  const artifacts = [];

  // Convert to markdown
  let markdownContent = content;

  if (ext === '.txt') {
    // Plain text - wrap in markdown
    markdownContent = `# Document\n\n${content}`;
  } else if (ext === '.json') {
    // JSON - format as code block
    markdownContent = `# JSON Document\n\n\`\`\`json\n${content}\n\`\`\``;
  }
  // .md and .markdown are already in markdown format

  // Write to docs directory
  const docPath = path.join(docsDir, 'content.md');
  await fs.writeFile(docPath, markdownContent);

  artifacts.push({
    id: 'content',
    type: 'narrative',
    format: 'markdown',
    path: docPath,
    line_count: content.split('\n').length
  });

  return artifacts;
}

/**
 * Canonicalize mixed content (tables + narrative)
 */
async function canonicalizeMixed(content, ext, sections, docsDir, tablesDir) {
  const artifacts = [];

  // Separate table and narrative sections
  const tableSections = sections.filter(s => s.type === 'table');
  const narrativeSections = sections.filter(s => s.type === 'narrative' || s.type === 'mixed');

  // Process tables (for JSON with arrays)
  if (ext === '.json') {
    const jsonData = JSON.parse(content);

    for (const section of tableSections) {
      const tableData = jsonData[section.json_key];

      if (Array.isArray(tableData) && tableData.length > 0) {
        // Convert array of objects to CSV
        const headers = Object.keys(tableData[0]);
        const rows = tableData.map(obj => headers.map(h => obj[h]));

        const tableId = section.id;
        const csvPath = path.join(tablesDir, `${tableId}.csv`);
        const csvContent = [
          headers.join(','),
          ...rows.map(row => row.map(v => escapeCSV(String(v))).join(','))
        ].join('\n');

        await fs.writeFile(csvPath, csvContent);

        // Markdown representation
        const mdPath = path.join(tablesDir, `${tableId}.md`);
        const mdContent = generateTableMarkdown(headers, rows);

        await fs.writeFile(mdPath, mdContent);

        // Metadata
        const metaPath = path.join(tablesDir, `${tableId}_meta.json`);
        const metadata = generateTableMetadata(headers, rows);

        await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));

        artifacts.push({
          id: tableId,
          type: 'table',
          format: 'csv',
          path: csvPath,
          markdown_path: mdPath,
          metadata_path: metaPath,
          row_count: rows.length,
          column_count: headers.length,
          source_key: section.json_key
        });
      }
    }

    // Process narrative sections (metadata fields)
    const narrativeContent = [];
    for (const section of narrativeSections) {
      const value = jsonData[section.json_key];
      narrativeContent.push(`## ${section.json_key}\n\n${JSON.stringify(value, null, 2)}`);
    }

    if (narrativeContent.length > 0) {
      const docPath = path.join(docsDir, 'metadata.md');
      await fs.writeFile(docPath, narrativeContent.join('\n\n'));

      artifacts.push({
        id: 'metadata',
        type: 'narrative',
        format: 'markdown',
        path: docPath
      });
    }
  }

  return artifacts;
}

/**
 * Canonicalize log file
 */
async function canonicalizeLog(content, sections, docsDir) {
  const artifacts = [];

  // Convert log to markdown with metadata
  const lines = content.split('\n');
  const markdownContent = `# Log File\n\n**Total Lines:** ${lines.length}\n\n\`\`\`\n${content}\n\`\`\``;

  const docPath = path.join(docsDir, 'log.md');
  await fs.writeFile(docPath, markdownContent);

  artifacts.push({
    id: 'log',
    type: 'narrative',
    format: 'markdown',
    path: docPath,
    line_count: lines.length
  });

  return artifacts;
}

/**
 * Canonicalize unknown format
 */
async function canonicalizeUnknown(content, filename, docsDir) {
  const artifacts = [];

  // Save as markdown code block
  const markdownContent = `# ${filename}\n\n\`\`\`\n${content}\n\`\`\``;

  const docPath = path.join(docsDir, 'content.md');
  await fs.writeFile(docPath, markdownContent);

  artifacts.push({
    id: 'content',
    type: 'narrative',
    format: 'markdown',
    path: docPath
  });

  return artifacts;
}

/**
 * Parse CSV line (handles quoted fields)
 */
function parseCSVLine(line, delimiter = ',') {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());

  return result;
}

/**
 * Escape CSV field
 */
function escapeCSV(value) {
  const str = String(value);

  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Generate markdown table from headers and rows
 */
function generateTableMarkdown(headers, rows) {
  const headerRow = `| ${headers.join(' | ')} |`;
  const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;
  const dataRows = rows.slice(0, 10).map(row => `| ${row.join(' | ')} |`);

  const lines = [
    `# Table\n`,
    headerRow,
    separatorRow,
    ...dataRows
  ];

  if (rows.length > 10) {
    lines.push(`\n_Showing 10 of ${rows.length} rows_`);
  }

  return lines.join('\n');
}

/**
 * Generate table metadata (column schemas)
 */
function generateTableMetadata(headers, rows) {
  const columns = headers.map((header, index) => {
    // Infer data type from first non-empty value
    let dtype = 'string';
    let nullable = false;
    let sampleValues = [];

    for (const row of rows) {
      const value = row[index];

      if (value === null || value === undefined || value === '') {
        nullable = true;
        continue;
      }

      sampleValues.push(value);

      // Infer type
      if (!isNaN(value) && value !== '') {
        dtype = value.includes('.') ? 'float64' : 'int64';
      }

      if (sampleValues.length >= 10) {
        break;
      }
    }

    return {
      name: header,
      dtype,
      nullable,
      description: `Column: ${header}`
    };
  });

  return {
    columns,
    row_count: rows.length,
    missing_value_strategy: 'explicit_NaN'
  };
}

/**
 * Canonicalize Feather file (binary Apache Arrow format)
 * Reads Feather file, converts to CSV, and generates metadata
 */
async function canonicalizeFeatherFile(rawPath, tablesDir) {
  const arrow = require('apache-arrow');

  try {
    // Read Feather file
    const buffer = await fs.readFile(rawPath);
    let table;

    try {
      table = arrow.tableFromIPC(buffer);
    } catch (arrowError) {
      // If Arrow fails (e.g., compressed), use Python fallback
      if (arrowError.message.includes('codec not found') || arrowError.message.includes('compressed')) {
        console.log('[ContentCanonicalizer] Using Python fallback for compressed Feather file');
        return await canonicalizeFeatherWithPython(rawPath, tablesDir);
      }
      throw arrowError;
    }

    // Extract schema and data
    const schema = table.schema;
    const numRows = table.numRows;
    const columns = [];

    // Generate column metadata
    schema.fields.forEach((field) => {
      const column = table.getChild(field.name);
      const values = [];
      for (let i = 0; i < Math.min(numRows, 100); i++) { // Sample first 100 rows for type detection
        values.push(column.get(i));
      }

      columns.push({
        name: field.name,
        type: inferColumnType(values),
        nullable: field.nullable,
        arrow_type: field.type.toString()
      });
    });

    // Run null-rate pre-flight
    let preflightResult = null;
    try {
      preflightResult = await runFeatherPreflightCheck(rawPath);
    } catch (preflightErr) {
      if (preflightErr.code === 'FEATHER_CORRUPT') throw preflightErr;
      console.warn('[ContentCanonicalizer] Pre-flight unavailable:', preflightErr.message);
    }

    // Copy feather file directly — no CSV conversion
    const featherPath = path.join(tablesDir, 'table_1.feather');
    await fs.copyFile(rawPath, featherPath);

    // Write table metadata
    const metadataPath = path.join(tablesDir, 'table_1_meta.json');
    const metadata = {
      id: 'table_1',
      source_format: 'feather',
      columns,
      row_count: numRows,
      column_count: columns.length,
      arrow_schema: schema.fields.map(f => ({
        name: f.name,
        type: f.type.toString(),
        nullable: f.nullable
      })),
      null_rates:             preflightResult?.null_rates             ?? null,
      missing_value_strategy: preflightResult?.missing_value_strategy ?? null,
      quality_warnings:       preflightResult?.quality_warnings       ?? [],
      preflight_sample_rows:  preflightResult?.sample_rows_checked    ?? null,
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    // Generate markdown representation (column list only)
    const mdPath = path.join(tablesDir, 'table_1.md');
    const mdContent = generateFeatherTableMarkdown('table_1', columns, numRows);
    await fs.writeFile(mdPath, mdContent, 'utf8');

    return [{
      id: 'table_1',
      type: 'table',
      path: featherPath,
      metadata_path: metadataPath,
      markdown_path: mdPath,
      format: 'feather',
      row_count: numRows,
      column_count: columns.length
    }];

  } catch (error) {
    console.error('[ContentCanonicalizer] Failed to process Feather file:', error);
    throw error;
  }
}

/**
 * Canonicalize Feather file using Python's pyarrow (fallback for compressed files)
 */
async function canonicalizeFeatherWithPython(rawPath, tablesDir) {
  const { spawn } = require('child_process');

  const featherPath = path.join(tablesDir, 'table_1.feather');

  return new Promise((resolve, reject) => {
    // Python only reads schema metadata — Node copies the file
    const pythonScript = `
import sys, json
import pyarrow.feather as feather

raw_path = sys.argv[1]

try:
    t = feather.read_table(raw_path)
    columns = [{'name': f.name, 'type': str(f.type), 'nullable': f.nullable} for f in t.schema]
    print(json.dumps({'columns': columns, 'row_count': t.num_rows, 'column_count': t.num_columns}))

except Exception as e:
    print(json.dumps({'error': str(e)}), file=sys.stderr)
    sys.exit(1)
`;

    const python = spawn('python', ['-c', pythonScript, rawPath]);
    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => { stdout += data.toString(); });
    python.stderr.on('data', (data) => { stderr += data.toString(); });

    python.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Python processing failed: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);

        // Run null-rate pre-flight
        let preflightResult = null;
        try {
          preflightResult = await runFeatherPreflightCheck(rawPath);
        } catch (preflightErr) {
          if (preflightErr.code === 'FEATHER_CORRUPT') throw preflightErr;
          console.warn('[ContentCanonicalizer] Pre-flight unavailable:', preflightErr.message);
        }

        // Copy feather file — no CSV conversion needed
        await fs.copyFile(rawPath, featherPath);

        // Write metadata
        const metadataPath = path.join(tablesDir, 'table_1_meta.json');
        const metadata = {
          id: 'table_1',
          source_format: 'feather',
          columns: result.columns,
          row_count: result.row_count,
          column_count: result.column_count,
          null_rates:             preflightResult?.null_rates             ?? null,
          missing_value_strategy: preflightResult?.missing_value_strategy ?? null,
          quality_warnings:       preflightResult?.quality_warnings       ?? [],
          preflight_sample_rows:  preflightResult?.sample_rows_checked    ?? null,
        };
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

        // Generate markdown (column list only)
        const mdPath = path.join(tablesDir, 'table_1.md');
        const mdContent = generateFeatherTableMarkdown('table_1', result.columns, result.row_count);
        await fs.writeFile(mdPath, mdContent, 'utf8');

        resolve([{
          id: 'table_1',
          type: 'table',
          path: featherPath,
          metadata_path: metadataPath,
          markdown_path: mdPath,
          format: 'feather',
          row_count: result.row_count,
          column_count: result.column_count
        }]);

      } catch (err) {
        reject(new Error(`Failed to process Python output: ${err.message}`));
      }
    });

    python.on('error', (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });
  });
}

/**
 * Infer column type from sample values
 */
function inferColumnType(values) {
  let dtype = 'string';

  for (const value of values) {
    if (value === null || value === undefined) continue;

    if (typeof value === 'number') {
      dtype = Number.isInteger(value) ? 'int64' : 'float64';
      break;
    }

    if (typeof value === 'boolean') {
      dtype = 'boolean';
      break;
    }

    const str = String(value);
    if (!isNaN(str) && str !== '') {
      dtype = str.includes('.') ? 'float64' : 'int64';
      break;
    }
  }

  return dtype;
}

/**
 * Generate markdown representation of a Feather table (column list only)
 */
function generateFeatherTableMarkdown(tableName, columns, rowCount) {
  const lines = [];
  const MAX_COLS = 50;

  lines.push(`# ${tableName}`);
  lines.push('');
  lines.push(`**Format:** Feather  **Rows:** ${rowCount}  **Columns:** ${columns.length}`);
  lines.push('');
  lines.push('| Column | Type | Nullable |');
  lines.push('|---|---|---|');

  columns.slice(0, MAX_COLS).forEach(c => {
    lines.push(`| ${c.name} | ${c.type || c.arrow_type || ''} | ${c.nullable} |`);
  });

  if (columns.length > MAX_COLS) {
    lines.push('');
    lines.push(`_Showing ${MAX_COLS} of ${columns.length} columns_`);
  }

  return lines.join('\n');
}

/**
 * Canonicalize Excel workbook — one CSV per non-empty sheet
 */
async function canonicalizeWorkbook(rawPath, sections, tablesDir) {
  const XLSX = require('xlsx');
  const buffer = await fs.readFile(rawPath);
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const artifacts = [];

  for (const section of sections) {
    const sheet = wb.Sheets[section.sheet_name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (rows.length < 2) continue;

    const headers = rows[0].map(String);
    const dataRows = rows.slice(1).map(r => r.map(String));
    const tableId = section.id;

    const csvPath = path.join(tablesDir, `${tableId}.csv`);
    const csvContent = [
      headers.join(','),
      ...dataRows.map(row => row.map(escapeCSV).join(','))
    ].join('\n');
    await fs.writeFile(csvPath, csvContent);

    const mdPath = path.join(tablesDir, `${tableId}.md`);
    await fs.writeFile(mdPath, generateTableMarkdown(headers, dataRows));

    const metaPath = path.join(tablesDir, `${tableId}_meta.json`);
    await fs.writeFile(metaPath, JSON.stringify(generateTableMetadata(headers, dataRows), null, 2));

    artifacts.push({
      id: tableId,
      type: 'table',
      format: 'csv',
      path: csvPath,
      markdown_path: mdPath,
      metadata_path: metaPath,
      row_count: dataRows.length,
      column_count: headers.length,
      sheet_name: section.sheet_name
    });
  }

  return artifacts;
}

/**
 * Run the feather_null_check.py pre-flight script against a feather file.
 * Throws with err.code === 'FEATHER_CORRUPT' when hard_stop is set.
 * Returns the parsed result object on success.
 */
async function runFeatherPreflightCheck(rawPath, sampleRows = 10000) {
  const { execFile } = require('child_process');
  const scriptPath = path.join(__dirname, '..', 'scripts', 'feather_null_check.py');

  return new Promise((resolve, reject) => {
    execFile('python', [scriptPath, rawPath, String(sampleRows)], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`feather_null_check.py failed: ${err.message}${stderr ? '\n' + stderr : ''}`));
      }
      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch (parseErr) {
        return reject(new Error(`feather_null_check.py: unexpected output — ${parseErr.message}`));
      }
      if (result.error) {
        return reject(new Error(`feather_null_check.py: ${result.error}`));
      }
      if (result.quality_warnings?.length) {
        result.quality_warnings.forEach(w => console.warn('[ContentCanonicalizer] Pre-flight warning:', w));
      }
      if (result.hard_stop) {
        const e = new Error(`[HARD STOP] ${result.hard_stop}`);
        e.code = 'FEATHER_CORRUPT';
        return reject(e);
      }
      resolve(result);
    });
  });
}

module.exports = {
  canonicalize
};
