'use strict';

// Ponte IPC das NOSSAS páginas (painel app.html e overlay). Nunca das telas do jogo.
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const h = (_e, payload) => { try { cb(payload); } catch {} };
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('poke', {
  // eventos main -> UI
  onState: on('state'),
  onEvent: on('event'),
  onAlert: on('alert'),
  onAccounts: on('accounts'),
  onChat: on('chat'),
  // ações
  addView: () => ipcRenderer.invoke('addView'),
  removeView: (slot) => ipcRenderer.invoke('removeView', slot),
  selectAccount: (slot) => ipcRenderer.invoke('selectAccount', slot),
  setGameMode: (mode) => ipcRenderer.invoke('setGameMode', mode),
  setView: (view, slot) => ipcRenderer.invoke('setView', view, slot),
  setAccountName: (slot, name) => ipcRenderer.invoke('setAccountName', slot, name),
  reloadGame: (slot) => ipcRenderer.invoke('reloadGame', slot),
  viewsInfo: () => ipcRenderer.invoke('viewsInfo'),
  snapshotAll: () => ipcRenderer.invoke('snapshotAll'),
  refreshServer: (slot) => ipcRenderer.invoke('refreshServer', slot),
  getEvents: () => ipcRenderer.invoke('getEvents'),
  getCreatures: () => ipcRenderer.invoke('getCreatures'),
  toggleOverlay: () => ipcRenderer.invoke('toggleOverlay'),
  winMinimize: () => ipcRenderer.invoke('winMinimize'),
  winClose: () => ipcRenderer.invoke('winClose'),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('setSettings', patch),
  readShot: (p) => ipcRenderer.invoke('readShot', p),
  setDiag: (on) => ipcRenderer.invoke('setDiag', on),
  openDumpFolder: () => ipcRenderer.invoke('openDumpFolder'),
  openLanding: () => ipcRenderer.invoke('openLanding'),
});
