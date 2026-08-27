(function (root) {
  'use strict';

  const createChromeStoragePromises = (chromeApi) => {
    const local = chromeApi?.storage?.local;
    if (!local) throw new Error('CHROME_STORAGE_UNAVAILABLE');

    const call = (method, input) => new Promise((resolve, reject) => {
      local[method](input, (value) => {
        const lastError = chromeApi.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message || `chrome.storage.local.${method} failed`));
          return;
        }
        resolve(value);
      });
    });

    return Object.freeze({
      get: (keys) => call('get', keys),
      set: (values) => call('set', values),
      remove: (keys) => call('remove', keys),
    });
  };

  const api = Object.freeze({ createChromeStoragePromises });
  root.JzChromeStoragePromises = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
