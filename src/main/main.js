const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Config } = require('./config');
const { Database } = require('./database');
const { Orchestrator, CAPABILITIES } = require('./orchestrator');

let mainWindow;
let config;
let db;
let orchestrator;

// Paths
const configPath = path.join(app.getPath('userData'), 'config.json');
const dbPath = path.join(app.getPath('userData'), 'history.json');
const outputDir = path.join(app.getPath('userData'), 'output');
const uploadsDir = path.join(app.getPath('userData'), 'uploads');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0a1a',
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Uncomment for debugging:
  // mainWindow.webContents.openDevTools();
}

// Emit progress events to renderer
function emitProgress(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('job:progress', data);

    if (data.event === 'complete') {
      mainWindow.webContents.send('job:complete', data);
    }
    if (data.event === 'failed') {
      mainWindow.webContents.send('job:failed', data);
    }
    if (data.event === 'batch:complete') {
      mainWindow.webContents.send('batch:complete', data);
    }
  }
}

// ============ App Lifecycle ============

app.whenReady().then(async () => {
  // Create storage dirs
  for (const dir of [outputDir, uploadsDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Initialize modules
  config = new Config(configPath);
  db = new Database(dbPath);
  orchestrator = new Orchestrator(config, db, emitProgress);

  createWindow();

  // Set default output folder if not set
  if (!config.get('settings.outputFolder')) {
    config.set('settings.outputFolder', outputDir);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  // Cleanup converters
  if (orchestrator) {
    await orchestrator.shutdown();
  }
  if (db) db.close();
  app.quit();
});

app.on('before-quit', async () => {
  if (orchestrator) {
    await orchestrator.shutdown();
  }
});

// ============ Window Controls ============

ipcMain.handle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window:maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('window:close', () => {
  if (mainWindow) mainWindow.close();
});

// ============ Job Operations ============

ipcMain.handle('job:submit', async (_event, jobDef) => {
  try {
    // Set output folder default
    if (!jobDef.outputFolder) {
      jobDef.outputFolder = config.get('settings.outputFolder') || outputDir;
    }
    return await orchestrator.submitJob(jobDef);
  } catch (e) {
    return { success: false, errors: [e.message] };
  }
});

ipcMain.handle('job:submit-batch', async (_event, batch) => {
  try {
    // Apply global output folder if not specified
    if (!batch.globalOptions) batch.globalOptions = {};
    if (!batch.globalOptions.outputFolder) {
      batch.globalOptions.outputFolder = config.get('settings.outputFolder') || outputDir;
    }
    return await orchestrator.submitBatch(batch);
  } catch (e) {
    return { success: false, errors: [e.message] };
  }
});

ipcMain.handle('job:cancel', (_event, jobId) => {
  return orchestrator.cancelJob(jobId);
});

ipcMain.handle('job:cancel-all', () => {
  orchestrator.cancelAll();
  return true;
});

ipcMain.handle('job:retry', async (_event, jobId) => {
  return await orchestrator.retryJob(jobId);
});

// ============ Cookie Management ============

ipcMain.handle('cookies:save', (_event, provider, cookies) => {
  config.setCookies(provider, cookies);

  // Update provider status based on whether cookies are provided
  const hasCookies = Object.values(cookies).some(v => v && v.trim());
  config.setProviderStatus(provider, hasCookies ? 'configured' : 'unconfigured');

  return true;
});

ipcMain.handle('cookies:validate', async (_event, provider) => {
  try {
    const valid = await orchestrator.validateProvider(provider);
    return valid;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('cookies:status', () => {
  return {
    meta: config.getProviderStatus('meta'),
    grok: config.getProviderStatus('grok'),
    whisk: config.getProviderStatus('whisk'),
    imagefx: config.getProviderStatus('imagefx')
  };
});

// ============ Config ============

ipcMain.handle('config:load', () => {
  return config.getAll();
});

ipcMain.handle('config:save', (_event, settings) => {
  if (settings.outputFolder !== undefined) config.set('settings.outputFolder', settings.outputFolder);
  if (settings.retryAttempts !== undefined) config.set('settings.retryAttempts', settings.retryAttempts);
  if (settings.delayBetween !== undefined) config.set('settings.delayBetween', settings.delayBetween);
  if (settings.namingPattern !== undefined) config.set('settings.namingPattern', settings.namingPattern);
  return true;
});

// ============ History ============

ipcMain.handle('history:get', (_event, options) => {
  return db.getJobs(options || {});
});

ipcMain.handle('history:stats', () => {
  return db.getStats();
});

ipcMain.handle('history:delete', (_event, jobId) => {
  return db.deleteJob(jobId);
});

ipcMain.handle('history:clear', () => {
  return db.clear();
});

// ============ File Dialogs ============

ipcMain.handle('file:select', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Image(s)',
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }
    ],
    properties: ['openFile', 'multiSelections']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths;
  }
  return null;
});

ipcMain.handle('folder:select', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Output Folder',
    properties: ['openDirectory', 'createDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('file:select-json', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load JSON Batch File',
    filters: [
      { name: 'JSON', extensions: ['json'] }
    ],
    properties: ['openFile']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    try {
      return fs.readFileSync(result.filePaths[0], 'utf8');
    } catch (e) {
      return null;
    }
  }
  return null;
});

ipcMain.handle('file:select-txt', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load Prompts (.txt)',
    filters: [
      { name: 'Text Files', extensions: ['txt'] }
    ],
    properties: ['openFile']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    try {
      return fs.readFileSync(result.filePaths[0], 'utf8');
    } catch (e) {
      return null;
    }
  }
  return null;
});

// ============ Utilities ============

ipcMain.handle('util:open-file', async (_event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    await shell.openPath(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('util:open-folder', async (_event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    const folder = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
    if (fs.existsSync(folder)) {
      shell.showItemInFolder(filePath);
      return true;
    }
  }
  return false;
});

ipcMain.handle('util:capabilities', () => {
  return CAPABILITIES;
});
