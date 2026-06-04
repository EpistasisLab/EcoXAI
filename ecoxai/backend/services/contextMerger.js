/**
 * Context Merger Service
 * Merges custom user-provided context with auto-normalized context
 */

/**
 * Deep merge two objects, with custom values overriding auto values
 * @param {Object} target - Target object (auto-normalized)
 * @param {Object} source - Source object (custom context)
 * @returns {Object} Merged object
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') {
    return target;
  }

  const output = { ...target };

  for (const key in source) {
    if (source[key] === null || source[key] === undefined) {
      // Skip null/undefined custom values (keep auto value)
      continue;
    }

    if (Array.isArray(source[key])) {
      // Array: merge and deduplicate
      output[key] = Array.isArray(target[key])
        ? mergeArrays(target[key], source[key])
        : source[key];
    } else if (typeof source[key] === 'object' && !Array.isArray(source[key])) {
      // Object: recursively merge
      output[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      // Primitive: override with custom value
      output[key] = source[key];
    }
  }

  return output;
}

/**
 * Merge two arrays and deduplicate by value or 'name' field
 * @param {Array} target - Target array
 * @param {Array} source - Source array
 * @returns {Array} Merged and deduplicated array
 */
function mergeArrays(target, source) {
  const merged = [...target];

  for (const item of source) {
    // Check if item is object with 'name' field (entity/unit objects)
    if (typeof item === 'object' && item.name) {
      const exists = merged.some(t => typeof t === 'object' && t.name === item.name);
      if (!exists) {
        merged.push(item);
      }
    } else {
      // Primitive value
      if (!merged.includes(item)) {
        merged.push(item);
      }
    }
  }

  return merged;
}

/**
 * Validate context updates
 * @param {Object} updates - Context updates to validate
 * @returns {Object} { valid: boolean, errors: Array<string> }
 */
function validateContext(updates) {
  const errors = [];

  // Validate semantic context
  if (updates.semantic) {
    const { domain, confidence } = updates.semantic;

    if (domain !== undefined && domain !== null) {
      const validDomains = ['clinical_trial', 'finance', 'research', 'genomics', 'general'];
      if (!validDomains.includes(domain)) {
        errors.push(`Invalid domain: ${domain}. Must be one of: ${validDomains.join(', ')}`);
      }
    }
  }

  // Validate confidence context
  if (updates.confidence) {
    const { threshold, overall } = updates.confidence;

    if (threshold !== undefined && threshold !== null) {
      if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
        errors.push('Confidence threshold must be a number between 0.0 and 1.0');
      }
    }

    if (overall !== undefined && overall !== null) {
      if (typeof overall !== 'number' || overall < 0 || overall > 1) {
        errors.push('Overall confidence must be a number between 0.0 and 1.0');
      }
    }
  }

  // Validate structure context
  if (updates.structure) {
    const { document_type } = updates.structure;

    if (document_type !== undefined && document_type !== null) {
      const validTypes = ['table_dump', 'report', 'log', 'mixed'];
      if (!validTypes.includes(document_type)) {
        errors.push(`Invalid document_type: ${document_type}. Must be one of: ${validTypes.join(', ')}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Track custom overrides in provenance
 * @param {Object} provenance - Current provenance object
 * @param {Object} updates - Updates that were applied
 * @param {string} mergeStrategy - Merge strategy used
 * @returns {Object} Updated provenance object
 */
function trackOverrides(provenance, updates, mergeStrategy) {
  const timestamp = new Date().toISOString();
  const overrides = [];

  // Track semantic overrides
  if (updates.semantic) {
    for (const [key, value] of Object.entries(updates.semantic)) {
      if (value !== null && value !== undefined) {
        overrides.push({
          timestamp,
          field: `semantic.${key}`,
          value,
          type: typeof value
        });
      }
    }
  }

  // Track confidence overrides
  if (updates.confidence) {
    for (const [key, value] of Object.entries(updates.confidence)) {
      if (value !== null && value !== undefined) {
        overrides.push({
          timestamp,
          field: `confidence.${key}`,
          value,
          type: typeof value
        });
      }
    }
  }

  // Track structure overrides
  if (updates.structure) {
    for (const [key, value] of Object.entries(updates.structure)) {
      if (value !== null && value !== undefined) {
        overrides.push({
          timestamp,
          field: `structure.${key}`,
          value,
          type: typeof value
        });
      }
    }
  }

  // Update provenance
  const updatedProvenance = {
    ...provenance,
    custom_overrides: [
      ...(provenance.custom_overrides || []),
      ...overrides
    ],
    last_custom_edit: timestamp,
    merge_strategy: mergeStrategy
  };

  return updatedProvenance;
}

/**
 * Merge custom context with auto-normalized context
 * @param {Object} autoNormalized - Auto-normalized context
 * @param {Object} customContext - Custom user-provided context
 * @param {string} mergeStrategy - Merge strategy ('supplement' or 'override')
 * @returns {Object} Merged context
 */
function mergeCustomContext(autoNormalized, customContext, mergeStrategy = 'supplement') {
  // Validate custom context
  const validation = validateContext(customContext);
  if (!validation.valid) {
    throw new Error(`Invalid custom context: ${validation.errors.join(', ')}`);
  }

  // Merge based on strategy
  const merged = {};

  if (mergeStrategy === 'supplement') {
    // Supplement: Deep merge, custom overrides auto, keep auto values not specified
    merged.structure = deepMerge(autoNormalized.structure || {}, customContext.structure || {});
    merged.semantic = deepMerge(autoNormalized.semantic || {}, customContext.semantic || {});
    merged.confidence = deepMerge(autoNormalized.confidence || {}, customContext.confidence || {});
    merged.provenance = trackOverrides(
      autoNormalized.provenance || {},
      customContext,
      mergeStrategy
    );
  } else {
    // Override: Custom completely replaces auto (not implemented, fallback to supplement)
    console.warn(`Merge strategy '${mergeStrategy}' not implemented, falling back to 'supplement'`);
    return mergeCustomContext(autoNormalized, customContext, 'supplement');
  }

  return merged;
}

module.exports = {
  mergeCustomContext
};
