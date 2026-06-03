const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const tar = require('tar-stream');

const docker = new Docker();

// Volume names
const DATASETS_VOLUME = 'ecoxai-datasets';
const WORKSPACE_PREFIX = 'ecoxai-workspace-';
// Note: No shared skills volume - skills copied per-job to workspaces

class VolumeManager {
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'ecoxai-volumes');
  }

  /**
   * Sanitize filename for safe storage
   * @param {string} filename - Original filename
   * @returns {string} Sanitized filename
   */
  sanitizeFilename(filename) {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  /**
   * Initialize the shared datasets volume
   */
  async initializeDatasetVolume() {
    try {
      // Check if volume exists
      const volumes = await docker.listVolumes({
        filters: { name: [DATASETS_VOLUME] },
      });

      if (volumes.Volumes.length === 0) {
        // Create the volume
        await docker.createVolume({
          Name: DATASETS_VOLUME,
          Labels: {
            'com.ecoxai.type': 'datasets',
            'com.ecoxai.created': new Date().toISOString(),
          },
        });
        console.log(`Created datasets volume: ${DATASETS_VOLUME}`);
      } else {
        console.log(`Datasets volume exists: ${DATASETS_VOLUME}`);
      }

      return true;
    } catch (error) {
      console.error('Error initializing datasets volume:', error.message);
      return false;
    }
  }

  // Note: Shared skills volume methods removed - skills are now copied per-job to workspaces

  /**
   * Create a workspace volume for a specific job and initialize with proper ownership
   * @param {string} jobId - Job ID
   */
  async createWorkspaceVolume(jobId) {
    const volumeName = `${WORKSPACE_PREFIX}${jobId}`;

    try {
      await docker.createVolume({
        Name: volumeName,
        Labels: {
          'com.ecoxai.type': 'workspace',
          'com.ecoxai.jobId': jobId,
          'com.ecoxai.created': new Date().toISOString(),
        },
      });
      console.log(`Created workspace volume: ${volumeName}`);

      // Initialize workspace with proper ownership (chown to claude user uid:gid 1000:1000)
      const initContainer = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['sh', '-c', 'chown -R 1000:1000 /workspace && mkdir -p /workspace/output && chown -R 1000:1000 /workspace/output'],
        HostConfig: {
          Binds: [`${volumeName}:/workspace`],
        },
      });

      await initContainer.start();
      await initContainer.wait();
      await initContainer.remove();

      console.log(`✓ Initialized workspace volume with proper ownership for user claude (1000:1000)`);
      return volumeName;
    } catch (error) {
      console.error(`Error creating workspace volume for job ${jobId}:`, error.message);
      throw error;
    }
  }

  /**
   * Delete a workspace volume for a specific job
   * @param {string} jobId - Job ID
   */
  async deleteWorkspaceVolume(jobId) {
    const volumeName = `${WORKSPACE_PREFIX}${jobId}`;

    try {
      const volume = docker.getVolume(volumeName);
      await volume.remove();
      console.log(`Deleted workspace volume: ${volumeName}`);
      return true;
    } catch (error) {
      if (error.statusCode === 404) {
        console.log(`Workspace volume not found: ${volumeName}`);
        return true;
      }
      console.error(`Error deleting workspace volume for job ${jobId}:`, error.message);
      return false;
    }
  }

  /**
   * Copy a dataset file into the shared datasets volume
   * @param {string} datasetId - Dataset ID
   * @param {string} filename - Original filename
   * @param {Buffer|string} content - File content
   */
  async copyDatasetToVolume(datasetId, filename, content) {
    try {
      // Ensure content is a Buffer
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

      // Sanitize filename for safe storage
      const sanitizedFilename = this.sanitizeFilename(filename);
      const targetPath = `/datasets/${datasetId}_${sanitizedFilename}`;

      // Create a temporary container to copy files into the volume
      const container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['sh', '-c', `cat > "${targetPath}"`],
        HostConfig: {
          Binds: [`${DATASETS_VOLUME}:/datasets`],
        },
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });

      // Attach BEFORE starting to ensure stdin is ready
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });

      // Start the container
      await container.start();

      // Write content to stdin and close it
      stream.write(buffer);
      stream.end();

      // Wait for container to finish
      const result = await container.wait();

      // Check exit code
      if (result.StatusCode !== 0) {
        throw new Error(`Container exited with code ${result.StatusCode}`);
      }

      await container.remove();

      console.log(`✓ Copied dataset ${datasetId} (${filename} → ${sanitizedFilename}) to volume: ${buffer.length} bytes`);
      return { success: true, sanitizedFilename };
    } catch (error) {
      console.error(`Error copying dataset to volume:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Copy normalized dataset directory structure to volume
   * Creates: /datasets/{datasetId}/raw/ and /datasets/{datasetId}/normalized/
   * @param {string} datasetId - Dataset ID
   * @param {string} normalizedPath - Path to normalized directory structure
   */
  async copyNormalizedDatasetToVolume(datasetId, normalizedPath) {
    try {
      // Build tar archive using tar-stream (cross-platform, no shell needed)
      const pack = tar.pack();
      const chunks = [];
      const packFinished = new Promise((resolve, reject) => {
        pack.on('data', chunk => chunks.push(chunk));
        pack.on('end', resolve);
        pack.on('error', reject);
      });

      const addToTar = async (dirPath, baseInTar) => {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          const tarEntryName = baseInTar ? `${baseInTar}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await new Promise((resolve, reject) => {
              pack.entry({ name: tarEntryName, type: 'directory' }, err => {
                if (err) reject(err); else resolve();
              });
            });
            await addToTar(fullPath, tarEntryName);
          } else {
            const content = await fs.readFile(fullPath);
            await new Promise((resolve, reject) => {
              pack.entry({ name: tarEntryName, size: content.length }, content, err => {
                if (err) reject(err); else resolve();
              });
            });
          }
        }
      };

      await addToTar(normalizedPath, '');
      pack.finalize();
      await packFinished;
      const tarBuffer = Buffer.concat(chunks);

      // Copy tar to volume and extract
      const container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['sh', '-c', `mkdir -p /datasets/${datasetId} && tar -xf - -C /datasets/${datasetId}`],
        HostConfig: {
          Binds: [`${DATASETS_VOLUME}:/datasets`],
        },
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });

      // Attach BEFORE starting
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });

      // Start container
      await container.start();

      // Write tar data to stdin
      stream.write(tarBuffer);
      stream.end();

      // Wait for completion
      const result = await container.wait();

      if (result.StatusCode !== 0) {
        throw new Error(`Container exited with code ${result.StatusCode}`);
      }

      await container.remove();

      console.log(`✓ Copied normalized dataset ${datasetId} to volume (${tarBuffer.length} bytes)`);

      return {
        success: true,
        sanitizedFilename: datasetId // For backward compatibility
      };

    } catch (error) {
      console.error(`Error copying normalized dataset to volume:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Copy a set of raw files (fileMap: { filename → Buffer }) into the datasets volume
   * as a single dataset under /datasets/{datasetId}/raw/.
   * Used for multi-file dataset suites (e.g. csanalyze output).
   */
  async copyRawFilesAsDataset(datasetId, fileMap) {
    try {
      const pack = tar.pack();
      const chunks = [];
      const packFinished = new Promise((resolve, reject) => {
        pack.on('data', chunk => chunks.push(chunk));
        pack.on('end', resolve);
        pack.on('error', reject);
      });

      await new Promise((resolve, reject) => {
        pack.entry({ name: 'raw', type: 'directory' }, err => { if (err) reject(err); else resolve(); });
      });

      const metaBuf = Buffer.from(JSON.stringify({
        files: Object.keys(fileMap),
        createdAt: new Date().toISOString(),
        type: 'multi-file-dataset'
      }, null, 2));
      await new Promise((resolve, reject) => {
        pack.entry({ name: 'raw/metadata.json', size: metaBuf.length }, metaBuf, err => { if (err) reject(err); else resolve(); });
      });

      for (const [filename, content] of Object.entries(fileMap)) {
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
        await new Promise((resolve, reject) => {
          pack.entry({ name: `raw/${filename}`, size: buf.length }, buf, err => { if (err) reject(err); else resolve(); });
        });
      }

      pack.finalize();
      await packFinished;
      const tarBuffer = Buffer.concat(chunks);

      const container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['sh', '-c', `mkdir -p /datasets/${datasetId} && tar -xf - -C /datasets/${datasetId}`],
        HostConfig: { Binds: [`${DATASETS_VOLUME}:/datasets`] },
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await container.attach({
        stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
      });

      await container.start();
      stream.write(tarBuffer);
      stream.end();

      const result = await container.wait();
      if (result.StatusCode !== 0) throw new Error(`Container exited with code ${result.StatusCode}`);
      await container.remove();

      console.log(`✓ Copied raw dataset suite ${datasetId} to volume (${Object.keys(fileMap).length} files, ${tarBuffer.length} bytes)`);
      return { success: true };
    } catch (error) {
      console.error(`Error copying raw dataset suite to volume:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove a dataset file from the shared datasets volume
   * @param {string} datasetId - Dataset ID
   * @param {string} filename - Original filename
   */
  async removeDatasetFromVolume(datasetId, filename) {
    try {
      // Sanitize filename to match what was saved
      const sanitizedFilename = this.sanitizeFilename(filename);
      const targetPath = `/datasets/${datasetId}_${sanitizedFilename}`;

      const container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['rm', '-f', targetPath],
        HostConfig: {
          Binds: [`${DATASETS_VOLUME}:/datasets`],
        },
      });

      await container.start();
      await container.wait();
      await container.remove();

      console.log(`✓ Removed dataset ${datasetId} from volume`);
      return true;
    } catch (error) {
      console.error(`Error removing dataset from volume:`, error.message);
      return false;
    }
  }

  /**
   * List all datasets in the shared volume
   * @returns {Array} List of dataset files
   */
  async listDatasetsInVolume() {
    try {
      const container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['ls', '-la', '/datasets'],
        HostConfig: {
          Binds: [`${DATASETS_VOLUME}:/datasets:ro`],
        },
      });

      await container.start();
      const result = await container.wait();

      let files = [];
      if (result.StatusCode === 0) {
        const logs = await container.logs({ stdout: true });
        files = logs.toString().trim().split('\n').filter((line) => !line.startsWith('total'));
      }

      await container.remove();
      return files;
    } catch (error) {
      console.error('Error listing datasets in volume:', error.message);
      return [];
    }
  }

  /**
   * Read an artifact file from a job's workspace
   * Tries both /workspace/output/ (preferred) and /workspace/ root (fallback)
   * @param {string} jobId - Job ID
   * @param {string} filePath - Filename or path
   * @returns {Buffer} File content
   */
  async readArtifact(jobId, filePath) {
    const volumeName = `${WORKSPACE_PREFIX}${jobId}`;
    let container;

    try {
      // Use tail -f /dev/null so the container stays running until we explicitly stop it.
      // sleep 1 exits too quickly — getArchive fails on a stopped container.
      container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['tail', '-f', '/dev/null'],
        HostConfig: {
          Binds: [`${volumeName}:/workspace:ro`],
        },
      });

      await container.start();

      // Try /workspace/output/ first (preferred location)
      let tarStream;
      try {
        tarStream = await container.getArchive({
          path: `/workspace/output/${filePath}`,
        });
      } catch (error) {
        // Fallback: try /workspace/ root (handles subdirectory-relative paths too)
        console.log(`[${jobId}] Artifact not in output/, trying workspace root: ${filePath}`);
        tarStream = await container.getArchive({
          path: `/workspace/${filePath}`,
        });
      }

      // Extract file content from tar stream
      const fileBuffer = await new Promise((resolve, reject) => {
        const extract = tar.extract();
        const chunks = [];

        extract.on('entry', (header, stream, next) => {
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', next);
          stream.resume();
        });

        extract.on('finish', () => {
          resolve(Buffer.concat(chunks));
        });

        extract.on('error', reject);

        tarStream.pipe(extract);
      });

      return fileBuffer;
    } catch (error) {
      console.error(`Error reading artifact ${filePath} for job ${jobId}:`, error.message);
      throw error;
    } finally {
      // Always stop and remove the container, even on error
      if (container) {
        await container.stop({ t: 0 }).catch(() => {});
        await container.remove().catch(() => {});
      }
    }
  }

  /**
   * Write task file to a job's workspace before execution
   * @param {string} jobId - Job ID
   * @param {string} taskContent - Task/prompt content
   */
  async writeTaskFile(jobId, taskContent) {
    const volumeName = `${WORKSPACE_PREFIX}${jobId}`;

    try {
      const buffer = Buffer.from(taskContent);

      const container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['sh', '-c', 'cat > "/workspace/task.txt"'],
        HostConfig: {
          Binds: [`${volumeName}:/workspace`],
        },
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });

      // Attach BEFORE starting
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });

      await container.start();

      stream.write(buffer);
      stream.end();

      const result = await container.wait();

      if (result.StatusCode !== 0) {
        throw new Error(`Container exited with code ${result.StatusCode}`);
      }

      await container.remove();

      console.log(`✓ Wrote task file for job ${jobId}: ${buffer.length} bytes`);
      return true;
    } catch (error) {
      console.error(`Error writing task file for job ${jobId}:`, error.message);
      return false;
    }
  }

  /**
   * Copy CLAUDE.md context file to a job's workspace
   * @param {string} jobId - Job ID
   */
  async copyCLAUDEmdToWorkspace(jobId) {
    const volumeName = `${WORKSPACE_PREFIX}${jobId}`;
    const claudeMdPath = path.join(__dirname, '../docker/CLAUDE.md');

    try {
      // Read CLAUDE.md from docker directory
      const content = await fs.readFile(claudeMdPath);

      const container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['sh', '-c', 'cat > "/workspace/CLAUDE.md" && chown 1000:1000 /workspace/CLAUDE.md'],
        HostConfig: {
          Binds: [`${volumeName}:/workspace`],
        },
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });

      // Attach BEFORE starting
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });

      await container.start();

      stream.write(content);
      stream.end();

      const result = await container.wait();

      if (result.StatusCode !== 0) {
        throw new Error(`Container exited with code ${result.StatusCode}`);
      }

      await container.remove();

      console.log(`✓ Copied CLAUDE.md to workspace ${jobId}: ${content.length} bytes`);
      return true;
    } catch (error) {
      console.error(`Error copying CLAUDE.md to workspace ${jobId}:`, error.message);
      return false;
    }
  }

  /**
   * Copy selected skills to a job's workspace
   * Creates flat structure: .claude/skills/{skill-name}/SKILL.md
   * @param {string} jobId - Job ID
   * @param {Array<string>} skillIds - Array of skill IDs (e.g., ["org:alzkb-graph-query", "public:data-cleaning"])
   */
  async copySkillsToWorkspace(jobId, skillIds) {
    if (!skillIds || skillIds.length === 0) {
      console.log(`No skills to copy for job ${jobId}`);
      return true;
    }

    const volumeName = `${WORKSPACE_PREFIX}${jobId}`;
    const skillsSourceDir = path.join(__dirname, '../skills');

    try {
      // Create tar archive with selected skills in flat structure
      const pack = tar.pack();

      for (const skillId of skillIds) {
        // Parse skill ID (format: "visibility:skill-name")
        const [visibility, skillName] = skillId.split(':', 2);
        const skillSourcePath = path.join(skillsSourceDir, visibility, skillName);

        // Check if skill directory exists
        try {
          await fs.access(skillSourcePath);
        } catch (error) {
          console.warn(`Skill not found: ${skillId} at ${skillSourcePath}`);
          continue;
        }

        // Add skill files to tar with flat structure (skills/{skill-name}/...)
        await this.addSkillToTar(pack, skillSourcePath, skillName);
      }

      pack.finalize();

      // Convert pack stream to buffer
      const chunks = [];
      for await (const chunk of pack) {
        chunks.push(chunk);
      }
      const tarBuffer = Buffer.concat(chunks);

      console.log(`Created skills tarball for job ${jobId}: ${tarBuffer.length} bytes, ${skillIds.length} skills`);

      // Create a temporary container to extract the tarball into workspace
      const container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['sh', '-c', 'mkdir -p /workspace/.claude/skills && cd /workspace/.claude/skills && tar -xf - && chown -R 1000:1000 /workspace/.claude'],
        HostConfig: {
          Binds: [`${volumeName}:/workspace`],
        },
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });

      // Attach BEFORE starting
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });

      await container.start();

      // Write tarball to stdin
      stream.write(tarBuffer);
      stream.end();

      const result = await container.wait();

      if (result.StatusCode !== 0) {
        throw new Error(`Container exited with code ${result.StatusCode}`);
      }

      await container.remove();

      console.log(`✓ Copied ${skillIds.length} skills to workspace ${jobId}`);
      for (const skillId of skillIds) {
        const skillName = skillId.split(':')[1];
        console.log(`  - ${skillName}/`);
      }

      return true;
    } catch (error) {
      console.error(`Error copying skills to workspace ${jobId}:`, error.message);
      console.error('Stack:', error.stack);
      return false;
    }
  }

  /**
   * Add a single skill directory to tar archive with flat structure
   * @param {Object} pack - tar-stream pack object
   * @param {string} skillSourcePath - Source skill directory path
   * @param {string} skillName - Skill name for tar path
   */
  async addSkillToTar(pack, skillSourcePath, skillName) {
    const entries = await fs.readdir(skillSourcePath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(skillSourcePath, entry.name);
      // Always use forward slashes in tar paths (Linux inside Docker)
      const tarEntryPath = `${skillName}/${entry.name}`;

      if (entry.isDirectory()) {
        // Recursively add subdirectory
        await this.addSkillToTarRecursive(pack, fullPath, tarEntryPath);
      } else if (entry.isFile()) {
        // Add file to tar
        const content = await fs.readFile(fullPath);
        const stats = await fs.stat(fullPath);

        pack.entry({
          name: tarEntryPath,
          size: content.length,
          mode: stats.mode
        }, content);
      }
    }
  }

  /**
   * Recursively add directory contents to tar
   * @param {Object} pack - tar-stream pack object
   * @param {string} sourcePath - Source directory path
   * @param {string} tarPath - Path in tar archive (must use forward slashes for Linux)
   */
  async addSkillToTarRecursive(pack, sourcePath, tarPath) {
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(sourcePath, entry.name);
      // Always use forward slashes in tar paths (Linux inside Docker)
      const tarEntryPath = `${tarPath}/${entry.name}`;

      if (entry.isDirectory()) {
        await this.addSkillToTarRecursive(pack, fullPath, tarEntryPath);
      } else if (entry.isFile()) {
        const content = await fs.readFile(fullPath);
        const stats = await fs.stat(fullPath);

        pack.entry({
          name: tarEntryPath,
          size: content.length,
          mode: stats.mode
        }, content);
      }
    }
  }

  /**
   * Clean up old workspace volumes (older than specified hours)
   * @param {number} maxAgeHours - Maximum age in hours
   */
  async cleanupOldVolumes(maxAgeHours = 24) {
    try {
      const volumes = await docker.listVolumes({
        filters: { label: ['com.ecoxai.type=workspace'] },
      });

      const cutoffTime = Date.now() - maxAgeHours * 60 * 60 * 1000;
      let cleaned = 0;

      for (const vol of volumes.Volumes || []) {
        const createdLabel = vol.Labels?.['com.ecoxai.created'];
        if (createdLabel) {
          const createdTime = new Date(createdLabel).getTime();
          if (createdTime < cutoffTime) {
            try {
              const volume = docker.getVolume(vol.Name);
              await volume.remove();
              cleaned++;
              console.log(`Cleaned up old volume: ${vol.Name}`);
            } catch (err) {
              console.error(`Failed to remove volume ${vol.Name}:`, err.message);
            }
          }
        }
      }

      console.log(`Volume cleanup complete: removed ${cleaned} volumes`);
      return cleaned;
    } catch (error) {
      console.error('Error during volume cleanup:', error.message);
      return 0;
    }
  }

  /**
   * Read a file from a Docker volume using a temporary Alpine container
   * Uses the same approach as readArtifact for consistency
   * @param {string} volumeName - Name of the volume
   * @param {string} filePath - Path to file within volume (e.g., /volume/dataset_123/normalized/semantic.json)
   * @returns {Promise<Buffer>} File content as Buffer
   */
  async readFileFromVolume(volumeName, filePath) {
    try {
      const container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['sleep', '1'],
        HostConfig: {
          Binds: [`${volumeName}:/volume:ro`],
        },
      });

      await container.start();

      // Use getArchive to extract file (same as readArtifact)
      const tarStream = await container.getArchive({
        path: filePath,
      });

      // Extract file content from tar stream
      const fileBuffer = await new Promise((resolve, reject) => {
        const extract = tar.extract();
        const chunks = [];

        extract.on('entry', (header, stream, next) => {
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', next);
          stream.resume();
        });

        extract.on('finish', () => {
          resolve(Buffer.concat(chunks));
        });

        extract.on('error', reject);

        tarStream.pipe(extract);
      });

      // Wait for container to finish and remove it
      await container.wait();
      await container.remove();

      return fileBuffer;
    } catch (error) {
      console.error(`Error reading file ${filePath} from volume ${volumeName}:`, error.message);
      throw error;
    }
  }

  /**
   * Write a file to a Docker volume using a temporary Alpine container
   * @param {string} volumeName - Name of the volume
   * @param {string} filePath - Path to file within volume (will be prefixed with /volume/)
   * @param {string|Buffer} content - File content
   * @returns {Promise<boolean>} Success status
   */
  async writeFileToVolume(volumeName, filePath, content) {
    try {
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

      // Add /volume prefix if not present
      const volumePath = filePath.startsWith('/volume/') ? filePath : `/volume${filePath}`;
      const dirPath = path.dirname(volumePath);

      const container = await docker.createContainer({
        Image: 'alpine',
        Cmd: ['sh', '-c', `mkdir -p "${dirPath}" && cat > "${volumePath}"`],
        HostConfig: {
          Binds: [`${volumeName}:/volume`],
        },
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });

      await container.start();

      stream.write(buffer);
      stream.end();

      const result = await container.wait();
      await container.remove();

      if (result.StatusCode !== 0) {
        throw new Error(`Failed to write file: container exited with code ${result.StatusCode}`);
      }

      console.log(`✓ Wrote file to volume ${volumeName}:${filePath} (${buffer.length} bytes)`);
      return true;
    } catch (error) {
      console.error(`Error writing file ${filePath} to volume ${volumeName}:`, error.message);
      throw error;
    }
  }

  /**
   * Read all normalized context files for a dataset from the datasets volume
   * @param {string} datasetId - Dataset ID
   * @returns {Promise<Object>} Context object with structure, semantic, confidence, provenance
   */
  async readDatasetContext(datasetId) {
    const contextFiles = ['structure.json', 'semantic.json', 'confidence.json', 'provenance.json'];
    const context = {};

    try {
      // Read all context files in parallel
      const results = await Promise.allSettled(
        contextFiles.map(async (filename) => {
          const filePath = `/volume/${datasetId}/normalized/${filename}`;
          try {
            const buffer = await this.readFileFromVolume(DATASETS_VOLUME, filePath);
            const content = JSON.parse(buffer.toString('utf-8'));
            return { filename, content };
          } catch (error) {
            console.warn(`Could not read ${filename} for dataset ${datasetId}:`, error.message);
            return { filename, content: null };
          }
        })
      );

      // Collect results
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.content !== null) {
          const key = result.value.filename.replace('.json', '');
          context[key] = result.value.content;
        }
      }

      console.log(`✓ Read dataset context for ${datasetId}: ${Object.keys(context).length} files`);
      return context;
    } catch (error) {
      console.error(`Error reading dataset context for ${datasetId}:`, error.message);
      throw error;
    }
  }

  /**
   * Read a file from a job's workspace volume
   * Convenience wrapper around readFileFromVolume for workspace volumes
   * @param {string} jobId - Job ID
   * @param {string} filePath - Path within workspace (e.g., '/workspace/MEMORY.md')
   * @returns {Promise<Buffer>} File content
   */
  async readFileFromWorkspace(jobId, filePath) {
    const volumeName = `${WORKSPACE_PREFIX}${jobId}`;
    return this.readFileFromVolume(volumeName, filePath);
  }

  /**
   * Get volume statistics
   * @returns {Object} Volume statistics
   */
  async getVolumeStats() {
    try {
      const volumes = await docker.listVolumes();
      const ecoxaiVolumes = (volumes.Volumes || []).filter(
        (v) => v.Name.startsWith('ecoxai-') || v.Labels?.['com.ecoxai.type']
      );

      return {
        total: ecoxaiVolumes.length,
        datasets: ecoxaiVolumes.filter((v) => v.Name === DATASETS_VOLUME).length,
        workspaces: ecoxaiVolumes.filter((v) => v.Name.startsWith(WORKSPACE_PREFIX)).length,
        volumes: ecoxaiVolumes.map((v) => ({
          name: v.Name,
          type: v.Labels?.['com.ecoxai.type'] || 'unknown',
          jobId: v.Labels?.['com.ecoxai.jobId'],
          created: v.Labels?.['com.ecoxai.created'],
        })),
      };
    } catch (error) {
      console.error('Error getting volume stats:', error.message);
      return { total: 0, datasets: 0, workspaces: 0, volumes: [], error: error.message };
    }
  }
}

// Export singleton instance
module.exports = new VolumeManager();
module.exports.VolumeManager = VolumeManager;
