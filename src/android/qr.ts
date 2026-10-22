import { randomInt } from 'node:crypto';
// The core encoder only; the package entry point would also bundle its PNG and terminal renderers.
import { create } from 'qrcode/lib/core/qrcode';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function randomToken(length: number): string {
  return Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/** Wi-Fi QR payload that "Pair device with QR code" understands; the device then advertises `name` over mDNS. */
export function adbPairingPayload(name: string, password: string): string {
  const escape = (value: string) => value.replace(/([\\;,:"])/g, '\\$1');
  return `WIFI:T:ADB;S:${escape(name)};P:${escape(password)};;`;
}

/** An SVG of the QR code: black modules on white with the standard four-module quiet zone. */
export function qrSvg(text: string): string {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  const quiet = 4;
  const size = modules.size + quiet * 2;
  let path = '';
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) {
        path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
