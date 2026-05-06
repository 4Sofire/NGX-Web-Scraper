const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Receive stock updates pushed from main process
  onStockUpdate: (callback) => {
    ipcRenderer.on('stock-update', (_, data) => callback(data));
  },

  // Invoke calls (return promises)
  getAllSymbols:  ()    => ipcRenderer.invoke('get-all-symbols'),
  getSignal:     (sym) => ipcRenderer.invoke('get-signal', sym),
  getHistory:    (sym) => ipcRenderer.invoke('get-history', sym),
  setRefreshRate:(ms)  => ipcRenderer.invoke('set-refresh-rate', ms),

  // One-way control messages
  closeApp:    () => ipcRenderer.send('close-app'),
  minimizeApp: () => ipcRenderer.send('minimize-app'),
  togglePin:   () => ipcRenderer.send('toggle-pin'),
});
