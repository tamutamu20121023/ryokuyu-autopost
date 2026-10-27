const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;
const appRoot = isDev ? path.resolve(__dirname, '..') : path.join(process.resourcesPath, 'app');
const userData = app.getPath('userData');

function ensureUserData() {
  const srcConfig = path.join(appRoot, 'config.json');
  const templateConfig = path.join(appRoot, 'config.template.json');
  if (!fs.existsSync(path.join(userData, 'config.json'))) {
    let source = null;
    if (fs.existsSync(srcConfig)) source = srcConfig;
    else if (fs.existsSync(templateConfig)) source = templateConfig;
    if (source) fs.copyFileSync(source, path.join(userData, 'config.json'));
  }
  const srcPublic = path.join(appRoot, 'public');
  const dstPublic = path.join(userData, 'public');
  if (!fs.existsSync(dstPublic) && fs.existsSync(srcPublic)) {
    fs.cpSync(srcPublic, dstPublic, { recursive: true });
  }
  const srcSrc = path.join(appRoot, 'src');
  const dstSrc = path.join(userData, 'src');
  if (!fs.existsSync(dstSrc) && fs.existsSync(srcSrc)) {
    fs.cpSync(srcSrc, dstSrc, { recursive: true });
  }
}

let serverProcess = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, RYOKUYU_ROOT: userData, PORT: '3000' };
    const nodeBin = isDev ? 'node' : process.execPath;
    const spawnArgs = isDev
      ? [path.join(appRoot, 'src', 'server.mjs')]
      : [path.join(userData, 'src', 'server.mjs')];
    const spawnEnv = isDev ? env : { ...env, ELECTRON_RUN_AS_NODE: '1' };

    serverProcess = spawn(nodeBin, spawnArgs, { env: spawnEnv, cwd: userData, stdio: 'ignore' });

    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error('server exited with code', code);
    });

    const net = require('net');
    let attempts = 0;
    const timer = setInterval(() => {
      const s = new net.Socket();
      s.setTimeout(500);
      s.once('connect', () => { s.destroy(); clearInterval(timer); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (++attempts > 50) { clearInterval(timer); reject(new Error('server did not start')); }
      });
      s.connect(3000, '127.0.0.1');
    }, 200);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    title: '緑友役員会ツール',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  win.loadURL('http://localhost:3000');
}

app.whenReady().then(async () => {
  try { ensureUserData(); } catch (e) { console.error('ensureUserData:', e.message); }
  try { await startServer(); } catch (e) { console.error('startServer:', e.message); }

  const template = [
    {
      label: 'ファイル',
      submenu: [
        { label: '設定フォルダを開く', click: () => shell.openPath(userData) },
        { label: '設定ファイルを開く (config.json)', click: () => shell.openPath(path.join(userData, 'config.json')) },
        { type: 'separator' },
        { role: 'quit', label: '終了' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) { try { serverProcess.kill(); } catch {} }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
