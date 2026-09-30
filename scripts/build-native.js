'use strict';
// Compiles the native input helper (src/main/native/InputHelper.cs) with the C# compiler that ships
// with Windows. Runs before `npm start` and `npm run dist`; skips the work when the exe is current.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') process.exit(0);

const dir = path.join(__dirname, '..', 'src', 'main', 'native');
const source = path.join(dir, 'InputHelper.cs');
const exe = path.join(dir, 'input-helper.exe');
const fw = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');

const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
if (mtime(exe) >= mtime(source) && !process.argv.includes('--force')) process.exit(0);

execFileSync(path.join(fw, 'csc.exe'), [
  '-nologo', '-optimize', '-target:exe', `-lib:${path.join(fw, 'WPF')}`,
  '-r:System.Speech.dll', '-r:UIAutomationClient.dll', '-r:UIAutomationTypes.dll', '-r:WindowsBase.dll',
  `-out:${exe}`, source,
], { stdio: 'inherit' });
console.log('Built src/main/native/input-helper.exe');
