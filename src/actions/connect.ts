import * as vscode from 'vscode';
import { Adb } from '../android/adb';
import { AndroidDevice, MdnsService, parseConnectResult, parsePairResult } from '../android/parse';
import { DevicesTree } from '../views/devicesTree';
import { delay, notify, withProgress } from '../ui';

const RECENT_KEY = 'android.recentAddresses';
const RECENT_LIMIT = 10;
const TCPIP_PORT = 5555;
const ADDRESS_PATTERN = /^(\[[0-9a-f:]+\]|[\w.-]+):\d{1,5}$/i;

type Action = 'address' | 'pair' | 'usb' | 'ios';
interface Choice extends vscode.QuickPickItem {
  address?: string;
  action?: Action;
}

function validateAddress(value: string): string | undefined {
  return ADDRESS_PATTERN.test(value.trim()) ? undefined : 'Enter IP address and port, for example 192.168.1.23:37123';
}

function remember(state: vscode.Memento, address: string): Thenable<void> {
  const recent = state.get<string[]>(RECENT_KEY, []).filter((a) => a !== address);
  return state.update(RECENT_KEY, [address, ...recent].slice(0, RECENT_LIMIT));
}

async function connectTo(adb: Adb, tree: DevicesTree, state: vscode.Memento, address: string): Promise<boolean> {
  const result = parseConnectResult(await withProgress(`Connecting to ${address}…`, () => adb.connect(address)));
  await tree.refresh();
  if (result.ok) {
    await remember(state, address);
    notify(`$(radio-tower) ${result.message}`);
    return true;
  }
  if (/authenticate|unauthorized/i.test(result.message)) {
    const choice = await vscode.window.showErrorMessage(
      `${address} is not paired with this computer. Pair it with the code from Wireless debugging on the device.`,
      'Pair with Code…'
    );
    if (choice) {
      await pair(adb, tree, state);
    }
  } else {
    await vscode.window.showErrorMessage(result.message || `Could not connect to ${address}.`);
  }
  return false;
}

/** Quick pick with discovered devices, recent addresses and the other ways to connect. */
export async function connect(adb: Adb, tree: DevicesTree, state: vscode.Memento, ios: () => Promise<void>): Promise<void> {
  const connected = new Set(tree.devices.map((d) => d.serial));
  const usb = tree.devices.filter((d) => d.transport === 'usb' && d.state === 'device');
  const services = await adb.mdnsServices();
  const discovered = services.filter((s) => s.kind === 'connect' && !connected.has(s.address) && ![...connected].some((serial) => serial.startsWith(s.name)));
  const recent = state.get<string[]>(RECENT_KEY, []).filter((a) => !connected.has(a) && !discovered.some((s) => s.address === a));

  const items: Choice[] = [];
  if (discovered.length) {
    items.push({ label: 'Found on the network', kind: vscode.QuickPickItemKind.Separator });
    items.push(...discovered.map((s) => ({ label: `$(radio-tower) ${s.address}`, description: s.name, address: s.address })));
  }
  if (recent.length) {
    items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
    items.push(...recent.map((a) => ({ label: `$(history) ${a}`, address: a })));
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(edit) Enter IP Address and Port…', detail: 'Developer options → Wireless debugging shows them on the device', action: 'address' });
  items.push({ label: '$(key) Pair with Pairing Code…', detail: 'First connection on Android 11 or newer', action: 'pair' });
  if (usb.length) {
    items.push({ label: '$(plug) Switch USB Device to Wi‑Fi…', detail: `adb tcpip ${TCPIP_PORT}, works on any Android version`, action: 'usb' });
  }

  items.push({ label: 'iPhone and iPad', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(device-mobile) Connect iPhone or iPad over Wi‑Fi…', detail: 'Trust this computer over USB once, then enable the Wi‑Fi connection', action: 'ios' });

  const choice = await vscode.window.showQuickPick(items, { title: 'Connect Device over Wi‑Fi', placeHolder: 'Choose a device or a way to connect' });
  if (choice?.address) {
    await connectTo(adb, tree, state, choice.address);
  } else if (choice?.action === 'address') {
    const address = await vscode.window.showInputBox({ title: 'Connect over Wi‑Fi', prompt: 'IP address and port of the device', placeHolder: '192.168.1.23:37123', validateInput: validateAddress });
    if (address) {
      await connectTo(adb, tree, state, address.trim());
    }
  } else if (choice?.action === 'pair') {
    await pair(adb, tree, state, services);
  } else if (choice?.action === 'usb') {
    await switchToWifi(adb, tree, state);
  } else if (choice?.action === 'ios') {
    await ios();
  }
}

/** `adb pair` with the six-digit code from "Pair device with pairing code". */
export async function pair(adb: Adb, tree: DevicesTree, state: vscode.Memento, known?: MdnsService[]): Promise<void> {
  const services = (known ?? (await adb.mdnsServices())).filter((s) => s.kind === 'pairing');
  let address: string | undefined;
  if (services.length) {
    const manual = '$(edit) Enter IP Address and Port…';
    const picked = await vscode.window.showQuickPick([...services.map((s) => ({ label: s.address, description: s.name })), { label: manual }], {
      title: 'Pair with Pairing Code',
      placeHolder: 'Devices showing the pairing dialog'
    });
    if (!picked) {
      return;
    }
    address = picked.label === manual ? undefined : picked.label;
  }
  address ??= (
    await vscode.window.showInputBox({
      title: 'Pair with Pairing Code',
      prompt: 'On the device: Developer options → Wireless debugging → Pair device with pairing code. Enter the IP address and port shown there.',
      placeHolder: '192.168.1.23:37099',
      validateInput: validateAddress
    })
  )?.trim();
  if (!address) {
    return;
  }
  const code = await vscode.window.showInputBox({
    title: `Pair with ${address}`,
    prompt: 'Wi‑Fi pairing code shown on the device',
    placeHolder: '123456',
    validateInput: (value) => (/^\d{6}$/.test(value.trim()) ? undefined : 'The pairing code has six digits')
  });
  if (!code) {
    return;
  }
  const result = parsePairResult(await withProgress(`Pairing with ${address}…`, () => adb.pair(address, code.trim())));
  if (!result.ok) {
    await vscode.window.showErrorMessage(result.message || `Pairing with ${address} failed.`);
    return;
  }
  notify(`$(key) ${result.message}`);
  // A paired device is usually connected by the adb server through mDNS within a few seconds.
  const host = address.replace(/:\d+$/, '');
  const device = await withProgress('Paired. Waiting for the device to connect…', () => waitForDevice(tree, (d) => d.serial.startsWith(host) || (!!result.guid && d.serial.startsWith(result.guid))));
  if (device) {
    return;
  }
  const service = (await adb.mdnsServices()).find((s) => s.kind === 'connect' && (s.address.startsWith(`${host}:`) || s.name === result.guid));
  if (service) {
    await connectTo(adb, tree, state, service.address);
    return;
  }
  const connectAddress = await vscode.window.showInputBox({
    title: 'Connect over Wi‑Fi',
    prompt: 'Paired. Now enter the IP address and port from the Wireless debugging screen (not the pairing port).',
    value: `${host}:`,
    valueSelection: [host.length + 1, host.length + 1],
    validateInput: validateAddress
  });
  if (connectAddress) {
    await connectTo(adb, tree, state, connectAddress.trim());
  }
}

async function waitForDevice(tree: DevicesTree, match: (device: AndroidDevice) => boolean, timeout = 6000): Promise<AndroidDevice | undefined> {
  for (const end = Date.now() + timeout; Date.now() < end; await delay(1000)) {
    await tree.refresh();
    const device = tree.devices.find((d) => d.transport === 'wifi' && d.state === 'device' && match(d));
    if (device) {
      return device;
    }
  }
  return undefined;
}

/** Classic `adb tcpip 5555` for a USB device, then connects to its Wi‑Fi address. */
export async function switchToWifi(adb: Adb, tree: DevicesTree, state: vscode.Memento, device?: AndroidDevice): Promise<void> {
  if (!device) {
    const usb = tree.devices.filter((d) => d.transport === 'usb' && d.state === 'device');
    const picked =
      usb.length === 1
        ? usb[0]
        : (await vscode.window.showQuickPick(usb.map((d) => ({ label: d.model ?? d.serial, description: d.serial, device: d })), { title: 'Switch USB Device to Wi‑Fi' }))?.device;
    if (!picked) {
      if (!usb.length) {
        void vscode.window.showInformationMessage('Connect the device with a USB cable and allow USB debugging first.');
      }
      return;
    }
    device = picked;
  }
  const serial = device.serial;
  const ip = await adb.wifiAddress(serial);
  if (!ip) {
    await vscode.window.showErrorMessage(`${device.model ?? serial} has no Wi‑Fi address. Connect it to the same network as this computer.`);
    return;
  }
  const address = `${ip}:${TCPIP_PORT}`;
  await withProgress(`Switching ${device.model ?? serial} to ${address}…`, async () => {
    await adb.tcpip(serial, TCPIP_PORT);
    await delay(1500);
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (parseConnectResult(await adb.connect(address)).ok) {
      await remember(state, address);
      await tree.refresh();
      notify(`$(radio-tower) Connected to ${address}. The USB cable can be unplugged.`);
      return;
    }
    await delay(1500);
  }
  await connectTo(adb, tree, state, address);
}

export async function disconnect(adb: Adb, tree: DevicesTree, devices: AndroidDevice[]): Promise<void> {
  for (const device of devices) {
    await adb.disconnect(device.serial);
  }
  await tree.refresh();
}
