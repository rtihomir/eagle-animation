import { execSync, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROMPT_REGEX = /gphoto2:[^\n]*?>\s*$/;
const ERROR_REGEX = /\*\*\* Error/;

// Electron apps launched from Finder/Dock don't inherit the user's shell PATH,
// so Homebrew-installed gphoto2 (/opt/homebrew/bin or /usr/local/bin) won't be found.
// Resolve the binary path once at module load using a login shell which sources .zprofile/.bash_profile.
const resolveGphoto2Bin = () => {
  const extra = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  try {
    return execSync('which gphoto2', { shell: '/bin/zsh', env: { ...process.env, PATH: `${process.env.PATH || ''}:${extra}` } })
      .toString()
      .trim();
  } catch (_) {}
  for (const p of ['/opt/homebrew/bin/gphoto2', '/usr/local/bin/gphoto2']) {
    try {
      execSync(`test -x "${p}"`);
      return p;
    } catch (_) {}
  }
  return 'gphoto2';
};

const GPHOTO2_BIN = resolveGphoto2Bin();

const runGphoto2Once = (args) =>
  new Promise((resolve, reject) => {
    const proc = spawn(GPHOTO2_BIN, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gphoto2 exit ${code}: ${stderr.trim()}`));
    });
    proc.on('error', reject);
  });

class GPhoto2Camera {
  constructor(deviceId, context = {}) {
    this.deviceId = deviceId;
    this.context = context;
    this.shellProcess = null;
    this.previewActive = false;
    this.capturing = false;
    this.liveCallback = null;
    this.commandPending = null;
    this.outputBuffer = '';
    this.previewLoopRunning = false;
    this.startShellPromise = null;
    this.tmpDir = join(tmpdir(), `eagle-gphoto2-${process.pid}-${deviceId.replace(/[^a-z0-9]/gi, '-')}`);
  }

  async _startShell() {
    if (this.shellProcess) return;
    if (!this.startShellPromise) {
      this.startShellPromise = this._spawnShell().finally(() => {
        this.startShellPromise = null;
      });
    }
    return this.startShellPromise;
  }

  async _spawnShell() {
    await mkdir(this.tmpDir, { recursive: true });

    // Best-effort: free USB before shell takes it (single shot, no respawn loop needed —
    // shell holds claim continuously so PTPCamera can't grab it after this point).
    if (process.platform === 'darwin') {
      try {
        execSync('pkill -f PTPCamera 2>/dev/null');
      } catch (_) {
        // not running
      }
    }

    const proc = spawn(GPHOTO2_BIN, ['--port', this.deviceId, '--force-overwrite', '--shell']);
    this.shellProcess = proc;

    const onOutput = (chunk) => {
      this.outputBuffer += chunk.toString();
      this._processOutput();
    };

    proc.stdout.on('data', onOutput);
    proc.stderr.on('data', onOutput);

    proc.on('close', (code) => {
      console.warn(`📸 gphoto2 shell exited (${code})`);
      if (this.shellProcess === proc) {
        this.shellProcess = null;
      }
      if (this.commandPending) {
        const pending = this.commandPending;
        this.commandPending = null;
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(`shell closed: exit ${code}`));
      }
    });

    proc.on('error', (err) => {
      console.warn(`📸 gphoto2 shell error: ${err.message}`);
    });

    // Wait for first prompt = shell ready and USB claimed
    await this._waitForPrompt(15000);

    // Set local working directory so capture-preview / capture-image-and-download
    // write into our private tmp dir.
    await this._sendCommand(`lcd ${this.tmpDir}`);
    console.log(`📸 gphoto2 shell ready for ${this.deviceId} (pid ${proc.pid})`);
  }

  _processOutput() {
    if (!this.commandPending) return;

    const match = this.outputBuffer.match(PROMPT_REGEX);
    if (!match) return;

    const promptIdx = this.outputBuffer.length - match[0].length;
    const output = this.outputBuffer.slice(0, promptIdx);
    this.outputBuffer = '';

    const pending = this.commandPending;
    this.commandPending = null;
    clearTimeout(pending.timeoutId);

    if (ERROR_REGEX.test(output)) {
      pending.reject(new Error(output.trim()));
    } else {
      pending.resolve(output);
    }
  }

  _waitForPrompt(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.commandPending) {
          this.commandPending = null;
          reject(new Error('shell prompt timeout'));
        }
      }, timeoutMs);
      this.commandPending = { resolve, reject, timeoutId };
      this._processOutput();
    });
  }

  _sendCommand(cmd, timeoutMs = 30000) {
    if (!this.shellProcess) return Promise.reject(new Error('shell not running'));
    if (this.commandPending) return Promise.reject(new Error(`command already pending, cannot send: ${cmd}`));

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.commandPending) {
          this.commandPending = null;
          reject(new Error(`command timeout (${timeoutMs}ms): ${cmd}`));
          this._abortCurrentCommand().catch((e) => console.warn(`📸 abort failed: ${e.message}`));
        }
      }, timeoutMs);
      this.commandPending = { resolve, reject, timeoutId };
      this.shellProcess.stdin.write(`${cmd}\n`);
    });
  }

  async _abortCurrentCommand() {
    if (!this.shellProcess) return;
    console.warn('📸 sending SIGINT to gphoto2 shell to abort hung command');
    try {
      this.shellProcess.kill('SIGINT');
    } catch (_) {
      return;
    }
    try {
      await this._waitForPrompt(10000);
      console.log('📸 shell recovered after SIGINT, ready for next command');
    } catch (_) {
      console.warn('📸 shell did not recover after SIGINT — will respawn on next connect');
    }
  }

  async _previewLoop() {
    if (this.previewLoopRunning) return;
    this.previewLoopRunning = true;

    const previewPath = join(this.tmpDir, 'capture_preview.jpg');

    while (this.previewActive && this.shellProcess) {
      if (this.capturing || this.commandPending) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      try {
        // Defense in depth: remove stale preview file so gphoto2 has no overwrite prompt
        // if --force-overwrite isn't honored in shell mode.
        try {
          await unlink(previewPath);
        } catch (_) {
          // file doesn't exist yet
        }
        await this._sendCommand('capture-preview', 5000);
        const buffer = await readFile(previewPath);
        if (this.previewActive && !this.capturing) {
          this.liveCallback?.(`data:image/jpeg;base64,${buffer.toString('base64')}`);
        }
      } catch (err) {
        if (!this.previewActive) break;
        console.warn(`📸 preview error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    this.previewLoopRunning = false;
  }

  async connect(liveCallback) {
    this.previewActive = true;
    this.liveCallback = liveCallback;
    await this._startShell();
    this._previewLoop().catch((err) => console.error('📸 preview loop crashed:', err));
  }

  async takePicture() {
    // If connect() is in flight, shell may still be spawning — wait briefly
    if (!this.shellProcess && this.previewActive) {
      let waited = 0;
      while (!this.shellProcess && this.previewActive && waited < 15000) {
        await new Promise((r) => setTimeout(r, 100));
        waited += 100;
      }
    }
    console.log(`📸 takePicture: shell=${this.shellProcess ? `pid ${this.shellProcess.pid}` : 'null'}, previewActive=${this.previewActive}`);
    if (!this.shellProcess) throw new Error('camera not connected');
    this.capturing = true;
    try {
      // Yield until any in-flight preview command resolves
      while (this.commandPending) {
        await new Promise((r) => setTimeout(r, 30));
      }

      // Snapshot tmp dir state before capture so we can find the new file by diff
      const before = new Set(await readdir(this.tmpDir));

      // S5 capture takes ~15s over USB tether — generous timeout
      const tCmd0 = Date.now();
      await this._sendCommand('capture-image-and-download', 60000);
      const tCmd = Date.now() - tCmd0;

      const tFs0 = Date.now();
      const after = await readdir(this.tmpDir);
      const newFiles = after.filter((f) => !before.has(f) && f !== 'capture_preview.jpg');
      const tFs = Date.now() - tFs0;
      console.log(`📸 capture timing: gphoto2=${tCmd}ms, fsScan=${tFs}ms, newFiles=${newFiles.length}`);

      if (newFiles.length === 0) {
        console.warn(`📸 tmp dir contents after capture: ${after.join(', ')}`);
        throw new Error('capture file not found after capture-image-and-download');
      }

      // Prefer JPEG over RAW if camera saved both
      const captFile = newFiles.find((f) => /\.jpe?g$/i.test(f)) || newFiles[0];
      const ext = captFile.split('.').pop()?.toLowerCase() || 'jpg';
      const mimeType = /^jpe?g$/.test(ext) ? 'image/jpeg' : `image/${ext}`;

      const buffer = await readFile(join(this.tmpDir, captFile));

      // Cleanup all newly captured files (RAW + JPEG if dual save)
      for (const f of newFiles) {
        try {
          await unlink(join(this.tmpDir, f));
        } catch (_) {
          // best effort
        }
      }

      console.log(`📸 captured ${buffer.length} bytes from ${captFile}`);
      return { type: mimeType, buffer };
    } finally {
      this.capturing = false;
    }
  }

  async disconnect() {
    this.previewActive = false;
    this.liveCallback = null;

    const proc = this.shellProcess;
    if (proc) {
      try {
        proc.stdin.write('quit\n');
      } catch (_) {
        // stdin closed
      }
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try {
            proc.kill('SIGTERM');
          } catch (_) {
            // already gone
          }
          resolve();
        }, 2000);
        proc.once('close', () => {
          clearTimeout(t);
          resolve();
        });
      });
      this.shellProcess = null;
    }

    try {
      await rm(this.tmpDir, { recursive: true, force: true });
    } catch (_) {
      // best effort
    }
  }

  async getCapabilities() {
    return [];
  }

  async applyCapability() {
    return null;
  }

  async resetCapabilities() {
    return null;
  }

  async canResetCapabilities() {
    return false;
  }
}

class GPhoto2Browser {
  static async getCameras() {
    try {
      const out = await runGphoto2Once(['--auto-detect']);
      // Output format:
      //   Model                          Port
      //   ----------------------------------------
      //   Panasonic DC-GH5               usb:001,001
      const lines = out.split('\n').slice(2);
      return lines
        .map((line) => {
          const idx = line.lastIndexOf('usb:');
          if (idx === -1) return null;
          return {
            module: 'GPHOTO2',
            label: line.slice(0, idx).trim(),
            deviceId: line.slice(idx).trim(),
          };
        })
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }
}

export const Camera = GPhoto2Camera;
export const CameraBrowser = GPhoto2Browser;
