import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { adbPairingPayload, qrSvg, randomToken } from '../src/android/qr';

test('the QR payload matches what Android Studio puts in its pairing code', () => {
  assert.equal(adbPairingPayload('studio-abc', 'p4ss'), 'WIFI:T:ADB;S:studio-abc;P:p4ss;;');
  assert.equal(adbPairingPayload('a;b', 'c:d\\'), String.raw`WIFI:T:ADB;S:a\;b;P:c\:d\\;;`);
});

test('random tokens use an unambiguous alphabet', () => {
  const token = randomToken(32);
  assert.equal(token.length, 32);
  assert.match(token, /^[a-km-np-z2-9]+$/);
});

test('qrSvg draws a square code with a quiet zone and the three finder patterns', () => {
  const svg = qrSvg(adbPairingPayload('studio-abcdefghij', 'abcdefghijkm'));
  const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
  // 45 bytes fit version 4 (33 modules) at level M; plus 4 modules of white on each side.
  assert.equal(size, 33 + 8);
  for (const [x, y] of [
    [4, 4],
    [size - 11, 4],
    [4, size - 11]
  ]) {
    assert.ok(svg.includes(`M${x} ${y}h1v1h-1z`), `finder pattern corner at ${x},${y}`);
  }
});
