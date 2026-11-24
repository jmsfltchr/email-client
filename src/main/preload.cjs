const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('mailApi', {
  bootstrap: call('bootstrap'),
  saveState: call('saveState'),
  setOAuthClient: call('setOAuthClient'),
  addAccount: call('addAccount'),
  removeAccount: call('removeAccount'),
  updateAccount: call('updateAccount'),
  getMessage: call('getMessage'),
  saveAttachment: call('saveAttachment'),
  send: call('send'),
  searchRemote: call('searchRemote'),
  unsubscribePost: call('unsubscribePost'),
  notionStatus: call('notionStatus'),
  notionConnect: call('notionConnect'),
  notionDisconnect: call('notionDisconnect'),
  notionLoad: call('notionLoad'),
  notionCreate: call('notionCreate'),
  notionUpdate: call('notionUpdate'),
  notionTrash: call('notionTrash'),
  syncNow: call('syncNow'),
  orgIcon: call('orgIcon'),
  openExternal: call('openExternal'),
  focusWindow: call('focusWindow'),
  onEvent: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('event', fn);
    return () => ipcRenderer.removeListener('event', fn);
  },
});
