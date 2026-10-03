const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  getWindowState: () => ipcRenderer.invoke('get-window-state'),
});
