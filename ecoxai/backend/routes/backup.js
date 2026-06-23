const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

module.exports = function createBackupRoutes({ upload }) {
  const router  = require('express').Router();
  const BACKEND = path.join(__dirname, '..');
  const BACKUP_SCRIPT  = path.join(BACKEND, 'backup.sh');
  const RESTORE_SCRIPT = path.join(BACKEND, 'restore.sh');

  // GET /api/backup — run backup.sh, stream resulting archive, then delete it
  router.get('/backup', (req, res) => {
    const child = spawn('bash', [BACKUP_SCRIPT], { cwd: BACKEND });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', code => {
      if (code !== 0) {
        return res.status(500).json({ error: stderr || `backup.sh exited with code ${code}` });
      }

      // Extract archive path from "Backup saved: <path>"
      const match = stdout.match(/Backup saved:\s*(\S+)/);
      if (!match) {
        return res.status(500).json({ error: 'Could not parse backup path from script output' });
      }

      const archivePath = match[1];
      if (!fs.existsSync(archivePath)) {
        return res.status(500).json({ error: `Archive not found: ${archivePath}` });
      }

      res.download(archivePath, path.basename(archivePath), err => {
        try { fs.unlinkSync(archivePath); } catch (_) {}
        if (err && !res.headersSent) {
          res.status(500).json({ error: err.message });
        }
      });
    });
  });

  // POST /api/restore — accept .tar.gz upload, run restore.sh with "yes" on stdin
  router.post('/restore', upload.single('backup'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No backup file uploaded' });
    }

    const tmpFile = path.join(os.tmpdir(), `ecoxai-restore-${Date.now()}.tar.gz`);
    try {
      fs.writeFileSync(tmpFile, req.file.buffer);

      await new Promise((resolve, reject) => {
        const child = spawn('bash', [RESTORE_SCRIPT, tmpFile], { cwd: BACKEND });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });

        // Bypass interactive prompt by writing "yes\n" to stdin
        child.stdin.write('yes\n');
        child.stdin.end();

        child.on('close', code => {
          if (code === 0) {
            resolve({ stdout, stderr });
          } else {
            reject(new Error(stderr || `restore.sh exited with code ${code}`));
          }
        });
      });

      res.json({ success: true, message: 'Restore complete. Restart the server to reload state.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  });

  return router;
};
