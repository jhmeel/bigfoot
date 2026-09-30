'use strict';
// Lets main-process modules load under plain Node for unit tests.

const Module = require('module');
const path = require('path');
const os = require('os');

const stub = {
  app: { getPath: () => path.join(os.tmpdir(), 'buddy-tests'), getVersion: () => '0.0.0-test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => b.toString().replace(/^enc:/, ''),
  },
  shell: { openPath: async () => 'not found', openExternal: async () => {}, trashItem: async () => {} },
  screen: { dipToScreenPoint: (p) => p, screenToDipPoint: (p) => p },
  desktopCapturer: { getSources: async () => [] },
  ipcMain: { on() {}, handle() {}, removeHandler() {} },
};

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return resolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

module.exports = stub;
