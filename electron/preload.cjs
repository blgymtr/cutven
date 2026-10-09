const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cv', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
  on: (channel, fn) => {
    const listener = (_e, data) => fn(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
