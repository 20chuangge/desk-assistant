// CommonJS on purpose: a sandboxed preload (sandbox: true) cannot be an ES
// module, and this file must be listed in electron-builder.yml `files:` or it
// simply will not exist inside app.asar.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskShell', {
  minimize: () => ipcRenderer.send('shell:minimize'),
  toggleMaximize: () => ipcRenderer.send('shell:toggle-maximize'),
  close: () => ipcRenderer.send('shell:close'),
});
