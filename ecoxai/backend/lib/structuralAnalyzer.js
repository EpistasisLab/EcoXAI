/**
 * Structural Analyzer (Stage 1)
 *
 * Classifies document structure and identifies content sections.
 * Determines whether the file is:
 * - table_dump: Pure tabular data (CSV, TSV)
 * - report: Narrative document with text
 * - log: Sequential event log
 * - mixed: Combination of tables and narrative
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Analyze file structure and classify document type
 *
 * @param {string} rawPath - Path to raw file
 * @param {string} filename - Original filename
 * @returns {Promise<Object>} Structure analysis result
 */
async function analyze(rawPath, filename) {
  const ext = path.extname(filename).toLowerCase();

  // Classify document type based on extension and content
  let documentType = 'unknown';
  let sections = [];
  let layoutComplexity = 'low';
  let encodingIssues = [];
  let content = null;

  // Handle Excel workbooks
  if (ext === '.xlsx' || ext === '.xls') {
    const XLSX = require('xlsx');
    const wb = XLSX.read(await fs.readFile(rawPath), { type: 'buffer' });
    const sections = wb.SheetNames.map((name, i) => {
      const sheet = wb.Sheets[name];
      const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
      return {
        id: `table_${i + 1}`,
        type: 'table',
        confidence: 0.95,
        sheet_name: name,
        row_count: range.e.r,      // rows excluding header
        column_count: range.e.c + 1
      };
    }).filter(s => s.row_count > 0);

    return {
      document_type: 'workbook',
      sections,
      encoding_issues: ['binary-format'],
      layout_complexity: sections.length > 1 ? 'medium' : 'low',
      total_size_bytes: (await fs.stat(rawPath)).size,
      extension: ext
    };
  }

  // Handle binary Feather files separately
  if (ext === '.feather') {
    // Feather files are always table dumps
    documentType = 'table_dump';
    sections = [{
      id: 'table_1',
      type: 'table',
      confidence: 1.0,
      byte_offset: 0,
      byte_length: (await fs.stat(rawPath)).size
    }];
    layoutComplexity = 'low';
    encodingIssues = []; // Binary format, no encoding issues

  } else {
    // Read text-based files
    content = await fs.readFile(rawPath, 'utf8');

    // Detect encoding issues
    encodingIssues = detectEncodingIssues(content);

    if (ext === '.csv' || ext === '.tsv') {
      // CSV/TSV files are table dumps
      documentType = 'table_dump';
      sections = analyzeCSVStructure(content, ext);
      layoutComplexity = 'low';

  } else if (ext === '.json') {
    // JSON files could be structured data or mixed
    const jsonData = JSON.parse(content);
    const jsonAnalysis = analyzeJSONStructure(jsonData);

    documentType = jsonAnalysis.documentType;
    sections = jsonAnalysis.sections;
    layoutComplexity = jsonAnalysis.layoutComplexity;

  } else if (ext === '.txt' || ext === '.log') {
    // Text/log files could be logs or narrative
    const logAnalysis = analyzeTextStructure(content);

    documentType = logAnalysis.documentType;
    sections = logAnalysis.sections;
    layoutComplexity = logAnalysis.layoutComplexity;

  } else if (ext === '.md' || ext === '.markdown') {
    // Markdown is narrative with possible tables
    const mdAnalysis = analyzeMarkdownStructure(content);

    documentType = mdAnalysis.documentType;
    sections = mdAnalysis.sections;
    layoutComplexity = mdAnalysis.layoutComplexity;

    } else {
      // Unknown format - treat as narrative
      documentType = 'unknown';
      sections = [{
        id: 'content',
        type: 'narrative',
        confidence: 0.5,
        byte_offset: 0,
        byte_length: content.length
      }];
      layoutComplexity = 'high';
    }
  }

  // Get file size (handle both text and binary files)
  const fileStats = await fs.stat(rawPath);
  const totalSizeBytes = content ? content.length : fileStats.size;

  return {
    document_type: documentType,
    sections,
    encoding_issues: encodingIssues,
    layout_complexity: layoutComplexity,
    total_size_bytes: totalSizeBytes,
    extension: ext
  };
}

/**
 * Detect encoding issues (non-UTF8, special characters)
 */
function detectEncodingIssues(content) {
  const issues = [];

  // Check for common encoding problems
  if (content.includes('\ufffd')) {
    issues.push('replacement-character-detected');
  }

  // Check for byte order mark (BOM)
  if (content.charCodeAt(0) === 0xfeff) {
    issues.push('utf8-bom-detected');
  }

  // If no issues, mark as unicode-normalized
  if (issues.length === 0) {
    issues.push('unicode-normalized');
  }

  return issues;
}

/**
 * Analyze CSV structure
 */
function analyzeCSVStructure(content, ext) {
  const delimiter = ext === '.tsv' ? '\t' : ',';
  const lines = content.split('\n').filter(line => line.trim().length > 0);

  if (lines.length === 0) {
    return [{
      id: 'table_1',
      type: 'table',
      confidence: 0.0,
      row_count: 0,
      column_count: 0
    }];
  }

  // Parse header row
  const headerRow = lines[0];
  const columns = headerRow.split(delimiter);
  const columnCount = columns.length;

  // Estimate confidence based on structural consistency
  let confidence = 0.95;

  // Check if all rows have same number of columns
  const inconsistentRows = lines.slice(1).filter(line => {
    return line.split(delimiter).length !== columnCount;
  });

  if (inconsistentRows.length > 0) {
    confidence -= 0.1 * (inconsistentRows.length / lines.length);
  }

  // Check for empty header cells
  const emptyHeaders = columns.filter(col => col.trim().length === 0);
  if (emptyHeaders.length > 0) {
    confidence -= 0.05 * (emptyHeaders.length / columnCount);
  }

  return [{
    id: 'table_1',
    type: 'table',
    confidence: Math.max(0.0, confidence),
    row_count: lines.length - 1, // Exclude header
    column_count: columnCount,
    has_header: true,
    delimiter
  }];
}

/**
 * Analyze JSON structure
 */
function analyzeJSONStructure(jsonData) {
  // Check if it's an array of objects (typical table structure)
  if (Array.isArray(jsonData) && jsonData.length > 0 && typeof jsonData[0] === 'object') {
    return {
      documentType: 'table_dump',
      sections: [{
        id: 'table_1',
        type: 'table',
        confidence: 0.95,
        row_count: jsonData.length,
        column_count: Object.keys(jsonData[0]).length
      }],
      layoutComplexity: 'low'
    };
  }

  // Check if it's a single object with nested structure
  if (typeof jsonData === 'object' && !Array.isArray(jsonData)) {
    const keys = Object.keys(jsonData);
    const sections = [];

    // Analyze each top-level key
    keys.forEach((key, index) => {
      const value = jsonData[key];

      if (Array.isArray(value)) {
        // Array could be a table
        sections.push({
          id: `table_${index + 1}`,
          type: 'table',
          confidence: 0.85,
          row_count: value.length,
          column_count: typeof value[0] === 'object' ? Object.keys(value[0]).length : 1,
          json_key: key
        });
      } else if (typeof value === 'object') {
        // Nested object could be metadata
        sections.push({
          id: `metadata_${index + 1}`,
          type: 'narrative',
          confidence: 0.75,
          json_key: key
        });
      } else {
        // Scalar value is metadata
        sections.push({
          id: `field_${index + 1}`,
          type: 'narrative',
          confidence: 0.7,
          json_key: key
        });
      }
    });

    const hasTables = sections.some(s => s.type === 'table');
    const hasNarrative = sections.some(s => s.type === 'narrative');

    return {
      documentType: hasTables && hasNarrative ? 'mixed' : hasTables ? 'table_dump' : 'report',
      sections,
      layoutComplexity: sections.length > 3 ? 'high' : 'medium'
    };
  }

  // Unknown JSON structure
  return {
    documentType: 'unknown',
    sections: [{
      id: 'content',
      type: 'narrative',
      confidence: 0.5
    }],
    layoutComplexity: 'high'
  };
}

/**
 * Analyze text/log structure
 */
function analyzeTextStructure(content) {
  const lines = content.split('\n');

  // Detect log patterns (timestamps, log levels)
  const logPatternRegex = /^\d{4}-\d{2}-\d{2}|^\[\d{4}-\d{2}-\d{2}|^(INFO|WARN|ERROR|DEBUG)/;
  const logLines = lines.filter(line => logPatternRegex.test(line));

  if (logLines.length > lines.length * 0.5) {
    // Looks like a log file
    return {
      documentType: 'log',
      sections: [{
        id: 'log_1',
        type: 'narrative',
        confidence: 0.9,
        line_count: lines.length
      }],
      layoutComplexity: 'low'
    };
  }

  // Detect tabular patterns (consistent delimiters)
  const tabLines = lines.filter(line => line.split('\t').length > 1);
  const commaLines = lines.filter(line => line.split(',').length > 1);

  if (tabLines.length > lines.length * 0.8 || commaLines.length > lines.length * 0.8) {
    // Looks like a table without .csv extension
    return {
      documentType: 'table_dump',
      sections: [{
        id: 'table_1',
        type: 'table',
        confidence: 0.8,
        row_count: lines.length - 1,
        column_count: Math.max(
          tabLines.length > 0 ? tabLines[0].split('\t').length : 0,
          commaLines.length > 0 ? commaLines[0].split(',').length : 0
        )
      }],
      layoutComplexity: 'low'
    };
  }

  // Default to narrative
  return {
    documentType: 'report',
    sections: [{
      id: 'narrative_1',
      type: 'narrative',
      confidence: 0.85,
      line_count: lines.length
    }],
    layoutComplexity: 'medium'
  };
}

/**
 * Analyze markdown structure
 */
function analyzeMarkdownStructure(content) {
  const lines = content.split('\n');
  const sections = [];

  // Detect headers (sections)
  let currentSection = null;
  let sectionCount = 0;

  lines.forEach((line, index) => {
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headerMatch) {
      // New section detected
      if (currentSection) {
        sections.push(currentSection);
      }

      sectionCount++;
      currentSection = {
        id: `section_${sectionCount}`,
        type: 'narrative',
        confidence: 0.9,
        header_level: headerMatch[1].length,
        title: headerMatch[2],
        start_line: index
      };
    }

    // Detect markdown tables
    if (line.includes('|') && line.split('|').length > 2) {
      // Check if this is a table separator
      const isSeparator = /^\|?\s*[-:]+\s*\|/.test(line);

      if (isSeparator && currentSection && currentSection.type === 'narrative') {
        // Convert section to mixed type
        currentSection.type = 'mixed';
        currentSection.has_table = true;
      }
    }
  });

  // Add final section
  if (currentSection) {
    sections.push(currentSection);
  }

  // Determine document type
  const hasTables = sections.some(s => s.has_table);
  const documentType = hasTables ? 'mixed' : 'report';

  return {
    documentType,
    sections: sections.length > 0 ? sections : [{
      id: 'content',
      type: 'narrative',
      confidence: 0.85,
      line_count: lines.length
    }],
    layoutComplexity: sections.length > 5 ? 'high' : 'medium'
  };
}

module.exports = {
  analyze
};
