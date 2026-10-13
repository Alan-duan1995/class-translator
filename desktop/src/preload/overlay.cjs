const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('captions',{on:cb=>ipcRenderer.on('overlay:caption',(_e,data)=>cb(data))});
