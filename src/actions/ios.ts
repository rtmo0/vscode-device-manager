import * as vscode from 'vscode';
import { IosDevices } from '../ios/devices';
import { DevicesTree, IosDeviceNode } from '../views/devicesTree';
import { withProgress } from '../ui';

const WINDOWS_DRIVER_URL = 'https://apps.microsoft.com/detail/9np83lwlpz9k';

/** "Show this iPhone when on Wi‑Fi": once set over USB, the device also appears over the network. */
export async function enableWifi(ios: IosDevices, tree: DevicesTree, node?: IosDeviceNode): Promise<void> {
  const usb = tree.iosDevices.filter((d) => d.transport === 'usb' && d.state === 'ready');
  const device =
    node?.device ??
    (usb.length === 1
      ? usb[0]
      : (await vscode.window.showQuickPick(usb.map((d) => ({ label: d.name ?? d.udid, description: d.version && `iOS ${d.version}`, device: d })), { title: 'Enable Wi‑Fi Connection' }))
          ?.device);
  if (!device) {
    if (!usb.length) {
      await showIosHelp();
    }
    return;
  }
  await withProgress(`Enabling Wi‑Fi connection on ${device.name ?? device.udid}…`, () => ios.enableWifi(device.udid));
  void vscode.window.showInformationMessage(
    `${device.name ?? 'The device'} can now be reached over Wi‑Fi. Unplug the cable: it stays in the list while it is on the same network as this computer and awake.`
  );
}

export async function showIosHelp(): Promise<void> {
  const steps = [
    '1. Connect the iPhone or iPad with a USB cable and unlock it.',
    '2. Tap Trust on the device (open Finder on macOS or the Apple Devices app on Windows if the dialog does not appear).',
    '3. Right-click the device in the Devices view → Enable Wi‑Fi Connection.',
    '4. Unplug the cable. On the same Wi‑Fi network the device keeps showing up.'
  ];
  if (process.platform === 'win32') {
    steps.push('', 'Windows needs the Apple Devices app (or iTunes) for its USB driver.');
  } else if (process.platform === 'linux') {
    steps.push('', 'Linux needs usbmuxd (sudo apt install usbmuxd).');
  }
  const action = process.platform === 'win32' ? 'Get Apple Devices' : undefined;
  const choice = await vscode.window.showInformationMessage('Connect an iPhone or iPad', { modal: true, detail: steps.join('\n') }, ...(action ? [action] : []));
  if (choice === action) {
    await vscode.env.openExternal(vscode.Uri.parse(WINDOWS_DRIVER_URL));
  }
}
