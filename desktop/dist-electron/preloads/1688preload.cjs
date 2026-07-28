const { ipcRenderer } = require('electron');

const winIdArg = process.argv.find((value) => value.startsWith('--winId='));
const winId = winIdArg ? winIdArg.slice('--winId='.length) : '';
const channel = winId && /^[a-f0-9-]{20,40}$/i.test(winId)
  ? `result-page-${winId}`
  : '';

const timer = setInterval(() => {
  const href = globalThis.location.href;
  if (channel && (href.includes('tab=imageSearch') || href.includes('imageId'))) {
    ipcRenderer.send(channel, winId);
    clearInterval(timer);
  }
}, 2000);

globalThis.addEventListener('unload', () => clearInterval(timer), { once: true });
