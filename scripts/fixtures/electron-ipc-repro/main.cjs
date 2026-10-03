const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
app.setPath('userData', process.env.SAND_USER_DATA_DIR);
app.setPath('sessionData', process.env.SAND_USER_DATA_DIR);
let window;
ipcMain.handle('get-window-state', () => {
  const value = { isFullscreen: window.isFullScreen(), isMaximized: window.isMaximized(), electron: process.versions.electron, platform: process.platform };
  console.log('IPC_REPRO_RECEIVED', JSON.stringify(value));
  return value;
});
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 600, height: 300, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') } });
  await window.loadFile(path.join(__dirname, 'index.html'));
  console.log('IPC_REPRO_READY', JSON.stringify({ pid: process.pid, electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }));
});
app.on('window-all-closed', () => app.quit());
