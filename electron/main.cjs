// Desktop wrapper: starts the bundled Next.js server, then shows it in a window.
// No terminal, no browser, no install — the whole app lives inside this process.
const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { fork } = require('node:child_process');

// Log to a file next to the user's data so failures in a packaged app are visible.
let logFile = null;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    if (!logFile) logFile = path.join(app.getPath('userData'), 'launch.log');
    fs.appendFileSync(logFile, line);
  } catch {}
  process.stdout.write(line);
}

const PORT = 34117; // fixed, uncommon port so nothing else collides
let serverProcess = null;

/** Where the packaged Next standalone server lives, dev vs installed. */
function serverEntry() {
  // Packaged: extraResources puts it under resources/standalone.
  // Dev: the Next build writes it to .next-build/standalone.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'standalone')
    : path.join(__dirname, '..', '.next-build', 'standalone');
  return path.join(base, 'server.js');
}

function startServer() {
  const entry = serverEntry();
  log('starting server from', entry, 'exists:', fs.existsSync(entry));
  serverProcess = fork(entry, [], {
    // In a packaged app the child would be the Electron binary; ELECTRON_RUN_AS_NODE
    // makes it behave as plain Node so the server boots instead of a second window.
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
    },
    cwd: path.dirname(entry),
    silent: true,  // capture child output so we can log why it fails
  });
  if (serverProcess.stdout) serverProcess.stdout.on('data', (b) => log('[server]', String(b).trimEnd()));
  if (serverProcess.stderr) serverProcess.stderr.on('data', (b) => log('[server:err]', String(b).trimEnd()));
  serverProcess.on('error', (err) => {
    log('server error:', err.message);
    dialog.showErrorBox('Could not start', `The document checker failed to start.\n\n${err.message}`);
  });
  serverProcess.on('exit', (code, sig) => log('server exited code', code, 'sig', sig));
}

/** Resolve once the server answers, so the window never shows a blank page. */
function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => {
        res.destroy();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('Server did not respond in time.'));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 900,
    title: 'SI / B-L Checker',
    backgroundColor: '#f6f7f9',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Open external links (if any) in the real browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    await waitForServer();
    log('server responded; loading window');
    await win.loadURL(`http://127.0.0.1:${PORT}`);
  } catch (err) {
    log('startup failed:', String(err && err.message || err));
    dialog.showErrorBox('Could not start', String(err.message || err));
  }
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('quit', () => { if (serverProcess) serverProcess.kill(); });
