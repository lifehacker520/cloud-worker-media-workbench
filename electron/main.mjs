import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

let mainWindow = null;
let baseUrl = null;
let updaterCheckPromise = null;

const APP_PORT = Number(process.env.XHS_DESKTOP_PORT || 43188);

function projectRoot() {
  if (app.isPackaged) {
    return app.getAppPath();
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

async function readClientConfig() {
  const configPath = join(app.getPath('userData'), 'client-config.json');
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    return config && typeof config === 'object' ? config : {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[desktop-config]', error.message);
    }
    return {};
  }
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForServer(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url + '/api/health', { cache: 'no-store' });
      if (response.ok) {
        return;
      }
      lastError = new Error('本地服务返回 HTTP ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw lastError || new Error('本地服务启动超时');
}

async function startLocalServer() {
  process.env.XHS_MONITOR_HOST = '127.0.0.1';
  process.env.XHS_MONITOR_PORT = String(APP_PORT);
  process.env.XHS_DATA_DIR = join(app.getPath('userData'), 'data');
  process.env.XHS_AUTH_REQUIRED = 'false';
  process.env.NODE_ENV = 'desktop';

  const serverUrl = pathToFileURL(join(projectRoot(), 'server.mjs')).href;
  await import(serverUrl);
  baseUrl = 'http://127.0.0.1:' + APP_PORT;
  await waitForServer(baseUrl);
}

function sendUpdaterStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', payload);
  }
}

function configureUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendUpdaterStatus({ status: 'checking', version: app.getVersion() });
  });
  autoUpdater.on('update-available', (info) => {
    sendUpdaterStatus({ status: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    sendUpdaterStatus({ status: 'not-available', version: info.version });
  });
  autoUpdater.on('download-progress', (progress) => {
    sendUpdaterStatus({
      status: 'downloading',
      percent: Math.round(progress.percent),
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdaterStatus({ status: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (error) => {
    sendUpdaterStatus({
      status: 'error',
      message: error?.message || String(error),
    });
  });

  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      return { status: 'dev', version: app.getVersion() };
    }
    if (updaterCheckPromise) {
      return { status: 'checking', version: app.getVersion() };
    }
    try {
      const checkPromise = autoUpdater.checkForUpdates();
      updaterCheckPromise = Promise.race([
        checkPromise,
        wait(20000).then(() => {
          throw new Error('检查更新超时，请稍后重试');
        }),
      ]);
      const result = await updaterCheckPromise;
      if (result?.isUpdateAvailable) {
        const version = result.updateInfo?.version;
        sendUpdaterStatus({ status: 'available', version });
        return { status: 'available', version };
      }
      if (result?.isUpdateAvailable === false) {
        const version = result.updateInfo?.version || app.getVersion();
        sendUpdaterStatus({ status: 'not-available', version });
        return { status: 'not-available', version };
      }
      return { status: 'checking', version: app.getVersion() };
    } catch (error) {
      const result = {
        status: 'error',
        message: error?.message || String(error),
      };
      sendUpdaterStatus(result);
      return result;
    } finally {
      updaterCheckPromise = null;
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { status: 'downloading' };
    } catch (error) {
      const result = {
        status: 'error',
        message: error?.message || String(error),
      };
      sendUpdaterStatus(result);
      return result;
    }
  });

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall();
    return { status: 'installing' };
  });
}

async function createWindow() {
  const config = await readClientConfig();
  const remoteUrl = String(config.remoteUrl || process.env.XHS_REMOTE_URL || '').trim();
  if (remoteUrl) {
    baseUrl = remoteUrl.replace(/\/$/, '');
  } else {
    await startLocalServer();
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: join(projectRoot(), 'electron', 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  await mainWindow.loadURL(baseUrl);
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    configureUpdater();
    await createWindow();
    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  }).catch((error) => {
    console.error('[desktop-startup]', error);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
