const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Job operations
  submitJob: (job) => ipcRenderer.invoke('job:submit', job),
  submitBatch: (batch) => ipcRenderer.invoke('job:submit-batch', batch),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
  cancelAll: () => ipcRenderer.invoke('job:cancel-all'),
  retryJob: (jobId) => ipcRenderer.invoke('job:retry', jobId),

  // Job events (main -> renderer)
  onJobProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },
  onJobComplete: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('job:complete', listener);
    return () => ipcRenderer.removeListener('job:complete', listener);
  },
  onJobFailed: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('job:failed', listener);
    return () => ipcRenderer.removeListener('job:failed', listener);
  },
  onBatchComplete: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('batch:complete', listener);
    return () => ipcRenderer.removeListener('batch:complete', listener);
  },

  // Cookie management
  saveCookies: (provider, cookies) => ipcRenderer.invoke('cookies:save', provider, cookies),
  validateCookies: (provider) => ipcRenderer.invoke('cookies:validate', provider),
  getCookieStatus: () => ipcRenderer.invoke('cookies:status'),

  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (settings) => ipcRenderer.invoke('config:save', settings),

  // History
  getHistory: (options) => ipcRenderer.invoke('history:get', options),
  getStats: () => ipcRenderer.invoke('history:stats'),
  deleteJob: (jobId) => ipcRenderer.invoke('history:delete', jobId),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  // File dialogs
  selectFile: (options) => ipcRenderer.invoke('file:select', options),
  selectFolder: () => ipcRenderer.invoke('folder:select'),
  selectJsonFile: () => ipcRenderer.invoke('file:select-json'),
  selectTxtFile: () => ipcRenderer.invoke('file:select-txt'),

  // Utilities
  openFile: (filePath) => ipcRenderer.invoke('util:open-file', filePath),
  openFolder: (folderPath) => ipcRenderer.invoke('util:open-folder', folderPath),
  getProviderCapabilities: () => ipcRenderer.invoke('util:capabilities'),

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close')
});
