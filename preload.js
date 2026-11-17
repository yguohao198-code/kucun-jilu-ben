const { contextBridge, ipcRenderer } = require('electron');

// 只暴露白名单接口，页面拿不到 Node 能力
contextBridge.exposeInMainWorld('dataStore', {
  load: () => ipcRenderer.invoke('load-data'),
  save: (data) => ipcRenderer.invoke('save-data', data),
  importData: (data) => ipcRenderer.invoke('import-data', data),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  saveXlsx: (opts) => ipcRenderer.invoke('save-xlsx', opts),
  ocrImage: (buf) => ipcRenderer.invoke('ocr-image', buf),
  exportTemplate: () => ipcRenderer.invoke('export-template'),
  parseImportFile: () => ipcRenderer.invoke('parse-import-file'),
  exportRestockTemplate: () => ipcRenderer.invoke('export-restock-template'),
  parseRestockFile: () => ipcRenderer.invoke('parse-restock-file'),
  exportBatchOrderTemplate: () => ipcRenderer.invoke('export-batch-order-template'),
  parseBatchOrderFile: () => ipcRenderer.invoke('parse-batch-order-file'),
  exportCustomerTemplate: () => ipcRenderer.invoke('export-customer-template'),
  parseCustomerFile: () => ipcRenderer.invoke('parse-customer-file'),
  saveReportPdf: (html) => ipcRenderer.invoke('save-report-pdf', html),
});
