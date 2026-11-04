import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import path from 'node:path';
import { stateDirectory } from './config.js';

// Devices pair once by scanning a QR code with a one-time code. They keep a
// long-lived token in the browser; this file only stores its hash.

export const devicesPath = () => path.join(stateDirectory(), 'devices.json');
export const hashToken = token => createHash('sha256').update(token).digest('hex');

export async function loadDevices() {
  try {
    const stored = JSON.parse(await readFile(devicesPath(), 'utf8'));
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Cannot read the paired devices at ' + devicesPath() + ': ' + error.message);
  }
}

export async function saveDevices(devices) {
  const file = devicesPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(devices, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

// Re-pairing the same browser replaces its entry instead of adding another.
export async function pairDevice({ deviceId, name }) {
  const devices = await loadDevices();
  const id = /^[a-f0-9]{16}$/.test(deviceId || '') && devices[deviceId] ? deviceId : randomBytes(8).toString('hex');
  const token = randomBytes(32).toString('hex');
  devices[id] = { name: String(name || 'Device').slice(0, 60), tokenHash: hashToken(token), pairedAt: new Date().toISOString() };
  await saveDevices(devices);
  return { deviceId: id, token, devices };
}

// "iPad · Safari" from a user agent, so the device list is readable.
export function deviceName(userAgent = '') {
  const device = /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && /Mobile/.test(userAgent)) ? 'iPad'
    : /iPhone/.test(userAgent) ? 'iPhone' : /Android/.test(userAgent) ? 'Android' : /Macintosh/.test(userAgent) ? 'Mac'
    : /Windows/.test(userAgent) ? 'Windows' : /Linux/.test(userAgent) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\/|CriOS\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : '';
  return browser ? device + ' · ' + browser : device;
}

// The computer's stable network name ("Name.local" via Bonjour). Links use it
// instead of an IP address, so a link inside a note keeps working and every
// link shares one browser origin, where the device token is stored.
let cachedHost;
export function deviceHost() {
  if (cachedHost !== undefined) return cachedHost;
  if (process.env.PAPERLINK_HOST !== undefined) return (cachedHost = process.env.PAPERLINK_HOST || null);
  try {
    if (process.platform === 'darwin') return (cachedHost = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim() + '.local');
  } catch { /* fall through */ }
  const name = hostname();
  return (cachedHost = name ? (name.includes('.') ? name : name + '.local') : null);
}

export const canvasLink = (port, id) => deviceHost() ? 'http://' + deviceHost() + ':' + port + '/#canvas=' + id : null;
