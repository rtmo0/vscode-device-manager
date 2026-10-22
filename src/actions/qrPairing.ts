import * as vscode from 'vscode';
import { Adb } from '../android/adb';
import { parsePairResult } from '../android/parse';
import { adbPairingPayload, qrSvg, randomToken } from '../android/qr';
import { DevicesTree } from '../views/devicesTree';
import { delay, errorMessage, notify } from '../ui';
import { connectTo, waitForDevice } from './connect';

const TIMEOUT = 3 * 60 * 1000;
const POLL_INTERVAL = 1000;

function page(svg: string, status: string, error = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; align-items: center; padding: 24px; }
  .qr { width: 280px; height: 280px; padding: 8px; background: #fff; border-radius: 8px; }
  .qr svg { width: 100%; height: 100%; }
  ol { max-width: 420px; line-height: 1.6; }
  .status { margin-top: 12px; font-weight: 600; color: ${error ? 'var(--vscode-errorForeground)' : 'var(--vscode-foreground)'}; }
</style>
</head>
<body>
  <h2>Pair Android device with QR code</h2>
  <div class="qr">${svg}</div>
  <div class="status">${status}</div>
  <ol>
    <li>Connect the phone to the same Wi-Fi network as this computer.</li>
    <li>On the phone open <b>Settings → Developer options → Wireless debugging</b>.</li>
    <li>Tap <b>Pair device with QR code</b> and scan this code.</li>
  </ol>
</body>
</html>`;
}

/**
 * QR pairing as in Android Studio: the code carries a service name and password; the phone that scans it
 * advertises `_adb-tls-pairing._tcp` under that name, and `adb pair` completes with the password.
 */
export async function pairWithQr(adb: Adb, tree: DevicesTree, state: vscode.Memento): Promise<void> {
  const name = `studio-${randomToken(10)}`;
  const password = randomToken(12);
  const svg = qrSvg(adbPairingPayload(name, password));
  const panel = vscode.window.createWebviewPanel('mobile-device-manager.qrPairing', 'Pair with QR Code', vscode.ViewColumn.Active, { enableScripts: false });
  let closed = false;
  panel.onDidDispose(() => (closed = true));
  const show = (status: string, error = false) => {
    if (!closed) {
      panel.webview.html = page(svg, status, error);
    }
  };
  show('Waiting for the phone to scan the code…');

  const end = Date.now() + TIMEOUT;
  while (!closed && Date.now() < end) {
    const service = (await adb.mdnsServices()).find((s) => s.kind === 'pairing' && s.name === name);
    if (!service) {
      await delay(POLL_INTERVAL);
      continue;
    }
    show(`Pairing with ${service.address}…`);
    const result = parsePairResult(await adb.pair(service.address, password));
    if (!result.ok) {
      show(`Pairing failed: ${result.message || 'unknown error'}. Scan the code again.`, true);
      await delay(3000);
      continue;
    }
    show('Paired. Connecting…');
    const host = service.address.replace(/:\d+$/, '');
    const device = await waitForDevice(tree, (d) => d.serial.startsWith(host) || (!!result.guid && d.serial.startsWith(result.guid)));
    if (!device) {
      const connect = (await adb.mdnsServices()).find((s) => s.kind === 'connect' && (s.address.startsWith(`${host}:`) || s.name === result.guid));
      if (!connect || !(await connectTo(adb, tree, state, connect.address))) {
        show('Paired, but the phone did not connect. Use Connect over Wi-Fi with the address from the Wireless debugging screen.', true);
        return;
      }
    }
    panel.dispose();
    notify(`$(radio-tower) Paired and connected ${device?.model ?? host}`);
    return;
  }
  if (!closed) {
    show('The code expired. Close this tab and start pairing again.', true);
  }
}

/** Shown when mDNS discovery is not available in this adb; QR pairing depends on it. */
export async function checkMdns(adb: Adb): Promise<boolean> {
  try {
    const output = await adb.run(['mdns', 'check'], { allowFailure: true, timeout: 5000 });
    if (/unavailable|not supported|unknown command/i.test(output)) {
      await vscode.window.showErrorMessage(`QR pairing needs mDNS discovery in adb, which is not available: ${output.trim()}. Update Platform-Tools or pair with a code.`);
      return false;
    }
  } catch (error) {
    await vscode.window.showErrorMessage(errorMessage(error));
    return false;
  }
  return true;
}
