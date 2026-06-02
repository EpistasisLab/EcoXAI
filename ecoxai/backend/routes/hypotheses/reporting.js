function attachHypothesisReportingRoutes(router, {
  state,
  dbManager,
  volumeManager
}) {
  router.get('/datasets/:datasetId/feature-importance-aggregate', async (req, res) => {
    try {
      const { datasetId } = req.params;
      const features = await dbManager.getAggregatedFeatureImportance(datasetId);

      res.json({
        success: true,
        datasetId,
        featureCount: features.length,
        features
      });
    } catch (error) {
      console.error('Error getting aggregated feature importance:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.get('/datasets/:datasetId/feature-importance-report', async (req, res) => {
    try {
      const { datasetId } = req.params;
      const threshold = parseFloat(req.query.threshold) || 0.10;

      if (!state.datasets[datasetId]) {
        return res.status(404).json({
          success: false,
          error: `Dataset ${datasetId} not found`
        });
      }

      const featureReporter = require('../../services/featureImportanceReporter');
      const report = await featureReporter.generateFeatureImportanceReport(datasetId, threshold);

      res.json({
        success: true,
        datasetId,
        threshold,
        featureCount: report.featureCount,
        markdown: report.markdown,
        json: report.json
      });
    } catch (error) {
      console.error('Error generating feature importance report:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.post('/datasets/:datasetId/extract-feature-importances', async (req, res) => {
    try {
      const { datasetId } = req.params;

      if (!state.datasets[datasetId]) {
        return res.status(404).json({
          success: false,
          error: `Dataset ${datasetId} not found`
        });
      }

      console.log(`[Extract Feature Importances] Starting extraction for dataset ${datasetId}`);

      const extractedFeatures = [];
      let dbFeaturesCount = 0;
      let fileFeaturesCount = 0;

      try {
        const dbResults = await dbManager.getFeatureImportanceResults(datasetId);
        if (dbResults && dbResults.length > 0) {
          console.log(`[Extract] Found ${dbResults.length} feature results in database`);
          for (const result of dbResults) {
            extractedFeatures.push({
              source: 'database',
              feature_name: result.feature_name,
              importance: result.importance_score
            });
            dbFeaturesCount++;
          }
        }
      } catch (dbErr) {
        console.warn(`[Extract] Could not read from database: ${dbErr.message}`);
      }

      try {
        const aggregatedResults = await dbManager.getAggregatedFeatureImportance(datasetId);
        if (aggregatedResults && aggregatedResults.length > 0) {
          console.log(`[Extract] Found ${aggregatedResults.length} aggregated features in database`);
          for (const result of aggregatedResults) {
            const exists = extractedFeatures.find(
              (feature) => feature.feature_name.toLowerCase() === result.feature_name.toLowerCase()
            );
            if (!exists) {
              extractedFeatures.push({
                source: 'database_aggregated',
                feature_name: result.feature_name,
                importance: result.avg_importance
              });
              dbFeaturesCount++;
            }
          }
        }
      } catch (aggErr) {
        console.warn(`[Extract] Could not read aggregated features: ${aggErr.message}`);
      }

      const datasetJobs = state.jobs.filter((job) => job.datasetId === datasetId);
      console.log(`[Extract] Scanning ${datasetJobs.length} job workspaces for feature files`);

      for (const job of datasetJobs) {
        const volumeName = `ecoxai-workspace-${job.id}`;
        let featureData = null;

        const filesToTry = [
          '/volume/feature_importance.json',
          '/volume/feature_importance_results.json',
          '/volume/output/feature_importance.json',
          '/volume/feature_importance.csv'
        ];

        for (const filePath of filesToTry) {
          try {
            const buffer = await volumeManager.readFileFromVolume(volumeName, filePath);
            const content = buffer.toString('utf-8');

            if (filePath.endsWith('.csv')) {
              const lines = content.trim().split('\n');
              if (lines.length > 1) {
                featureData = [];
                const header = lines[0].toLowerCase();
                const featureIdx = header.includes('feature')
                  ? header.split(',').findIndex((value) => value.includes('feature'))
                  : 0;
                const importanceIdx = header.includes('importance')
                  ? header.split(',').findIndex((value) => value.includes('importance'))
                  : 1;

                for (let i = 1; i < lines.length; i++) {
                  const cols = lines[i].split(',');
                  if (cols.length > Math.max(featureIdx, importanceIdx)) {
                    featureData.push({
                      feature_name: cols[featureIdx]?.trim().replace(/"/g, ''),
                      importance: parseFloat(cols[importanceIdx]?.trim())
                    });
                  }
                }
              }
            } else {
              featureData = JSON.parse(content);
            }

            console.log(`[Extract] Found ${filePath} in job ${job.id}`);
            break;
          } catch (fileErr) {
            continue;
          }
        }

        if (featureData) {
          let features = [];

          if (Array.isArray(featureData)) {
            features = featureData;
          } else if (featureData.features && Array.isArray(featureData.features)) {
            features = featureData.features;
          } else if (featureData.feature_importances && Array.isArray(featureData.feature_importances)) {
            features = featureData.feature_importances;
          }

          for (const feature of features) {
            const featureName = feature.feature || feature.feature_name || feature.name;
            const importance = feature.importance || feature.importance_score || feature.score;

            if (featureName && importance !== undefined && !isNaN(parseFloat(importance))) {
              const exists = extractedFeatures.find(
                (entry) => entry.feature_name.toLowerCase() === featureName.toLowerCase()
              );
              if (!exists) {
                extractedFeatures.push({
                  source: 'workspace',
                  jobId: job.id,
                  feature_name: featureName,
                  importance: parseFloat(importance)
                });
                fileFeaturesCount++;
              }
            }
          }
        }
      }

      console.log(`[Extract] Total extracted: ${extractedFeatures.length} features (${dbFeaturesCount} from DB, ${fileFeaturesCount} from files)`);

      let updatedCount = 0;
      const hypotheses = await dbManager.getHypothesesForDataset(datasetId);

      for (const hypothesis of hypotheses) {
        if (!hypothesis.feature_name) {
          continue;
        }

        const matchingFeature = extractedFeatures.find(
          (feature) => feature.feature_name.toLowerCase() === hypothesis.feature_name.toLowerCase()
        );

        if (matchingFeature && hypothesis.actual_importance !== matchingFeature.importance) {
          await dbManager.updateHypothesis(hypothesis.hypothesis_id, {
            actual_importance: matchingFeature.importance
          });
          updatedCount++;
          console.log(`[Extract] Updated hypothesis ${hypothesis.hypothesis_id} (${hypothesis.feature_name}): actual_importance = ${matchingFeature.importance}`);
        }
      }

      for (const feature of extractedFeatures) {
        if (feature.source === 'workspace' && feature.jobId) {
          try {
            await dbManager.insertFeatureImportanceResult({
              dataset_id: datasetId,
              run_id: feature.jobId,
              feature_name: feature.feature_name,
              importance_score: feature.importance
            });
          } catch (insertErr) {
            // Ignore duplicate insertions from previously scanned workspaces.
          }
        }
      }

      res.json({
        success: true,
        datasetId,
        featuresFromDatabase: dbFeaturesCount,
        featuresFromFiles: fileFeaturesCount,
        totalFeatures: extractedFeatures.length,
        hypothesesUpdated: updatedCount,
        jobsScanned: datasetJobs.length
      });
    } catch (error) {
      console.error('Error extracting feature importances:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.get('/datasets/:datasetId/ontology-graph', async (req, res) => {
    try {
      const { datasetId } = req.params;
      const threshold = parseFloat(req.query.threshold) || 0.1;

      const dataset = state.datasets[datasetId];
      if (!dataset) {
        return res.status(404).json({
          success: false,
          error: `Dataset ${datasetId} not found`
        });
      }

      const normalizationReport = await dbManager.getNormalizationReport(datasetId);

      let metadata = {};
      let domain = 'general';
      let entities = [];

      if (normalizationReport && normalizationReport.metadata) {
        metadata = normalizationReport.metadata;
        domain = metadata.domain || 'general';
        entities = metadata.entities || [];
      }

      const aggregatedFeatures = await dbManager.getAggregatedFeatureImportance(datasetId);

      let centerLabel = 'Target Variable';

      if (domain === 'genomics') {
        const diseaseKeywords = ['alzheimer', 'parkinsons', 'parkinson', 'cancer', 'diabetes', 'disease'];

        const diseaseEntity = entities.find((entity) =>
          diseaseKeywords.some((keyword) => entity.toLowerCase().includes(keyword))
        );

        if (diseaseEntity) {
          centerLabel = diseaseEntity
            .split(' ')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
        } else {
          centerLabel = 'Genetic Condition';
        }
      } else if (domain === 'clinical_trial') {
        centerLabel = 'Clinical Outcome';
      } else if (domain === 'finance') {
        centerLabel = 'Financial Target';
      } else if (domain === 'research') {
        centerLabel = 'Research Outcome';
      }

      const centerNode = {
        id: 'center',
        label: centerLabel,
        type: 'target',
        domain
      };

      const filteredFeatures = aggregatedFeatures
        .filter((feature) => feature.avg_importance >= threshold && feature.avg_importance > 0)
        .sort((a, b) => b.avg_importance - a.avg_importance);

      const featureNodes = filteredFeatures.map((feature, idx) => ({
        id: `feature_${idx}`,
        label: feature.feature_name,
        type: 'feature',
        importance: feature.avg_importance,
        num_tests: feature.num_tests,
        max_importance: feature.max_importance,
        min_importance: feature.min_importance,
        last_tested: feature.last_tested
      }));

      const edges = featureNodes.map((node) => ({
        id: `center_to_${node.id}`,
        source: 'center',
        target: node.id,
        importance: node.importance,
        label: `${(node.importance * 100).toFixed(1)}%`
      }));

      res.json({
        success: true,
        datasetId,
        centerNode,
        featureNodes,
        edges,
        metadata: {
          threshold,
          total_features: aggregatedFeatures.length,
          filtered_features: filteredFeatures.length,
          domain
        }
      });
    } catch (error) {
      console.error('Error generating ontology graph:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.post('/jobs/:jobId/feature-importance-report', async (req, res) => {
    try {
      const { jobId } = req.params;
      const { threshold = 0.10 } = req.body;

      const job = state.jobs.find((entry) => entry.id === jobId);
      if (!job) {
        return res.status(404).json({
          success: false,
          error: `Job ${jobId} not found`
        });
      }

      if (!job.datasetId) {
        return res.status(400).json({
          success: false,
          error: 'Job does not have an associated dataset'
        });
      }

      const featureReporter = require('../../services/featureImportanceReporter');
      const report = await featureReporter.generateFeatureImportanceReport(job.datasetId, threshold);
      await featureReporter.saveReportToWorkspace(jobId, report.markdown, report.json);

      res.json({
        success: true,
        jobId,
        datasetId: job.datasetId,
        threshold,
        featureCount: report.featureCount,
        message: 'Feature importance report saved to workspace'
      });
    } catch (error) {
      console.error('Error saving feature importance report:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
}

module.exports = attachHypothesisReportingRoutes;
