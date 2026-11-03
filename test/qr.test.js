import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeQr, renderQr } from '../src/qr.js';

const fingerprint = modules => createHash('sha256').update(modules.map(row => row.map(Number).join('')).join('\n')).digest('hex');

test('QR encoder matches a reference matrix for a canvas device link', () => {
  // Reference cross-checked module-by-module against the qrcode npm package (byte mode, level M).
  const modules = encodeQr('http://192.168.2.83:8080/#key=' + 'ab'.repeat(24) + '&canvas=8cdf569c-5c4a-4ca6-97c6-ed92c0ca05f5');
  assert.equal(modules.length, 45); // Version 7, which also carries version information.
  assert.equal(fingerprint(modules), '05348e352a8cd8db9bcdb507ca5de1e5ccd0d60a84bf639d8b40e0e1320432f3');
});

test('QR terminal rendering uses two module rows per line plus quiet zone', () => {
  const lines = renderQr('Paperlink').split('\n');
  assert.equal(lines.length, Math.ceil((21 + 4) / 2));
  assert.throws(() => encodeQr('x'.repeat(3000)), /too long/);
});
