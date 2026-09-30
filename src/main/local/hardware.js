'use strict';
// RAM, best GPU and its VRAM, free disk. VRAM comes from the registry (WMI's AdapterRAM caps at 4 GB)
// or nvidia-smi when available.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

const GB = 1024 ** 3;
const DISPLAY_CLASS = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
const IGNORED = /basic display|basic render|remote display|virtual|parsec|citrix|hyper-v|idd/i;

function run(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function parseReg(text) {
  const keys = {};
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) { current = keys[line.trim()] = {}; continue; }
    const m = /^\s{2,}(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(line);
    if (m && current) current[m[1]] = m[2] === 'REG_QWORD' || m[2] === 'REG_DWORD' ? Number(BigInt(m[3].trim())) : m[3].trim();
  }
  return keys;
}

function adaptersFromReg(text) {
  return Object.values(parseReg(text))
    .filter((v) => v.DriverDesc && !IGNORED.test(v.DriverDesc))
    .map((v) => {
      const bytes = Number(v['HardwareInformation.qwMemorySize']) || Number(v['HardwareInformation.MemorySize']) || 0;
      const vendor = /ven_([0-9a-f]{4})/i.exec(v.MatchingDeviceId || '');
      return { name: v.DriverDesc, vramGB: bytes / GB, vendor: vendor ? vendor[1].toLowerCase() : '' };
    })
    .sort((a, b) => b.vramGB - a.vramGB);
}

function adaptersFromNvidiaSmi(text) {
  return String(text).split(/\r?\n/).map((l) => l.split(',').map((s) => s.trim())).filter((p) => p.length >= 2 && p[0])
    .map(([name, mib]) => ({ name, vramGB: (Number(mib) || 0) / 1024, vendor: '10de' }));
}

async function freeDiskGB(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return (s.bavail * s.bsize) / GB;
  } catch {
    return null;
  }
}

async function detect(dataDir) {
  const [reg, smi, disk] = await Promise.all([
    process.platform === 'win32' ? run('reg', ['query', DISPLAY_CLASS, '/s']) : '',
    process.platform === 'win32' ? run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']) : '',
    freeDiskGB(dataDir || os.homedir()),
  ]);
  const adapters = [...adaptersFromNvidiaSmi(smi), ...adaptersFromReg(reg)]
    .filter((a, i, all) => all.findIndex((b) => b.name === a.name) === i)
    .sort((a, b) => b.vramGB - a.vramGB);
  const best = adapters[0] || null;
  const dedicated = Boolean(best && best.vramGB >= 2);
  const cpus = os.cpus();
  return {
    gpu: best ? best.name : 'No dedicated GPU',
    vramGB: dedicated ? round(best.vramGB) : 0,
    dedicated,
    ramGB: round(os.totalmem() / GB),
    freeDiskGB: disk == null ? null : round(disk),
    cpu: cpus.length ? `${cpus[0].model.trim()} · ${cpus.length} threads` : '',
  };
}

function round(n) { return Math.round(n * 10) / 10; }

module.exports = { detect, parseReg, adaptersFromReg, adaptersFromNvidiaSmi };
