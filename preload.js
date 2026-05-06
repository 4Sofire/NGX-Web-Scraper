const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onStockUpdate:   (cb)  => ipcRenderer.on('stock-update', (_, data) => cb(data)),
  getAllSymbols:   ()     => ipcRenderer.invoke('get-all-symbols'),
  getSignal:       (sym) => ipcRenderer.invoke('get-signal', sym),
  getHistory:      (sym) => ipcRenderer.invoke('get-history', sym),
  getMarketStatus: ()    => ipcRenderer.invoke('get-market-status'),
  setRefreshRate:  (ms)  => ipcRenderer.invoke('set-refresh-rate', ms),
  closeApp:    () => ipcRenderer.send('close-app'),
  minimizeApp: () => ipcRenderer.send('minimize-app'),
  togglePin:   () => ipcRenderer.send('toggle-pin'),
});