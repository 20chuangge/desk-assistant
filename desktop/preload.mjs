/**
 * Preload for the tiny "connect to hub" window only. The main window stays
 * sandboxed with no preload at all - the renderer is the hub's own web UI.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desk', {
  setHub: (url) => ipcRenderer.invoke('desk:set-hub', url),
  current: () => ipcRenderer.invoke('desk:current-hub'),
  useLocal: () => ipcRenderer.invoke('desk:use-local'),
});
