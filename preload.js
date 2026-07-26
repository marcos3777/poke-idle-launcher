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
  setModalOpen: (open) => ipcRenderer.invoke('setModalOpen', open),
  openPiwTools: (poke) => ipcRenderer.invoke('openPiwTools', poke),
  setAccountName: (slot, name) => ipcRenderer.invoke('setAccountName', slot, name),
  reloadGame: (slot) => ipcRenderer.invoke('reloadGame', slot),
  clearGameCache: (slot) => ipcRenderer.invoke('clearGameCache', slot),
  viewsInfo: () => ipcRenderer.invoke('viewsInfo'),
  snapshotAll: () => ipcRenderer.invoke('snapshotAll'),
  refreshServer: (slot) => ipcRenderer.invoke('refreshServer', slot),
  getEvents: () => ipcRenderer.invoke('getEvents'),
  getDaily: () => ipcRenderer.invoke('getDaily'),
  gotoHunt: (slot, name) => ipcRenderer.invoke('gotoHunt', slot, name),
  returnCerulean: (slot) => ipcRenderer.invoke('returnCerulean', slot),
  startBot: (slot, huntList) => ipcRenderer.invoke('startBot', slot, huntList),
  stopBot: (slot) => ipcRenderer.invoke('stopBot', slot),
  getBotStatus: (slot) => ipcRenderer.invoke('getBotStatus', slot),
  getCreatures: () => ipcRenderer.invoke('getCreatures'),
  getBox: () => ipcRenderer.invoke('getBox'),
  getMarket: (slot, category) => ipcRenderer.invoke('getMarket', slot, category),
  probeGameDom: (slot) => ipcRenderer.invoke('probeGameDom', slot),
  toggleOverlay: () => ipcRenderer.invoke('toggleOverlay'),
  winMinimize: () => ipcRenderer.invoke('winMinimize'),
  winClose: () => ipcRenderer.invoke('winClose'),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('setSettings', patch),
  readShot: (p) => ipcRenderer.invoke('readShot', p),
  setDiag: (on) => ipcRenderer.invoke('setDiag', on),
  testDiscord: () => ipcRenderer.invoke('testDiscord'),
  openDumpFolder: () => ipcRenderer.invoke('openDumpFolder'),
  openLanding: () => ipcRenderer.invoke('openLanding'),
});
