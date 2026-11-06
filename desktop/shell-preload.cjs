// CommonJS on purpose: a sandboxed preload (sandbox: true) cannot be an ES
// module, and this file must be listed in electron-builder.yml `files:` or it
// simply will not exist inside app.asar.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskShell', {
  minimize: () => ipcRenderer.send('shell:minimize'),
  toggleMaximize: () => ipcRenderer.send('shell:toggle-maximize'),
  close: () => ipcRenderer.send('shell:close'),
});

// Machine switching lives in the main window, which uses THIS preload (not
// preload.mjs). Without it window.desk is undefined and every machine button
// silently does nothing.
contextBridge.exposeInMainWorld('desk', {
  pickMachine: () => ipcRenderer.invoke('desk:pick-machine'),
  switchHub: (url) => ipcRenderer.invoke('desk:switch-hub', url),
  listMachines: () => ipcRenderer.invoke('desk:list-machines'),
  useLocal: () => ipcRenderer.invoke('desk:use-local'),
});
