import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import * as vscode from 'vscode';
import { Adb } from '../android/adb';
import { basename, parseConnectResult } from '../android/parse';
import { IosDevices } from '../ios/devices';
import { formatSyslogLine, splitSyslog } from '../ios/syslog';
import { DeviceNode, deviceName, DevicesTree } from '../views/devicesTree';
import { errorMessage, notify, plural } from '../ui';
import { RECENT_KEY, remember } from './connect';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const RECONNECT_INTERVAL = 30000;

export function appExtension(device: DeviceNode): string {
  return device.platform === 'android' ? 'apk' : 'ipa';
}

/** Installs .apk files on Android (adb install) or .ipa files on iOS (installation_proxy). */
export async function installApp(adb: Adb, ios: IosDevices, device: DeviceNode, uris?: vscode.Uri[]): Promise<void> {
  const ext = appExtension(device);
  uris ??= await vscode.window.showOpenDialog({
    title: `Install on ${deviceName(device)}`,
    canSelectMany: true,
    openLabel: 'Install',
    filters: { [device.platform === 'android' ? 'Android apps' : 'iOS apps']: [ext] }
  });
  const apps = (uris ?? []).filter((u) => u.path.toLowerCase().endsWith(`.${ext}`));
  if (!apps.length) {
    return;
  }
  for (const uri of apps) {
    const name = basename(uri.path);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Installing ${name} on ${deviceName(device)}`, cancellable: device.platform === 'android' },
      async (progress, token) => {
        if (device.platform === 'android') {
          if (uri.scheme === 'file') {
            await adb.install(device.device.serial, uri.fsPath, token);
            return;
          }
          // adb needs a local path; files from other file systems go through a temporary copy.
          const dir = await mkdtemp(join(tmpdir(), 'mobile-device-manager-'));
          try {
            const local = join(dir, name);
            await writeFile(local, await vscode.workspace.fs.readFile(uri));
            await adb.install(device.device.serial, local, token);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
          return;
        }
        let reported = 0;
        const ipa = await vscode.workspace.fs.readFile(uri);
        await ios.installIpa(device.device.udid, ipa, (percent, status) => {
          progress.report({ increment: percent - reported, message: `${status} ${percent}%` });
          reported = percent;
        });
      }
    );
  }
  notify(`$(check) Installed ${apps.length === 1 ? basename(apps[0].path) : plural(apps.length, 'app')} on ${deviceName(device)}`);
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
}

/** Saves a PNG of the Android screen and opens it. */
export async function screenshot(adb: Adb, device: DeviceNode): Promise<void> {
  if (device.platform !== 'android') {
    return;
  }
  const png = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Taking screenshot…' }, () => adb.screenshot(device.device.serial));
  if (!png.subarray(0, 4).equals(PNG_SIGNATURE)) {
    throw new Error(png.toString('utf8').trim() || 'The device returned no screenshot.');
  }
  const desktop = join(homedir(), 'Desktop');
  const folder = existsSync(desktop) ? desktop : homedir();
  const target = await vscode.window.showSaveDialog({
    title: 'Save Screenshot',
    defaultUri: vscode.Uri.file(join(folder, `Screenshot ${deviceName(device)} ${timestamp()}.png`)),
    filters: { Images: ['png'] }
  });
  if (target) {
    await vscode.workspace.fs.writeFile(target, png);
    await vscode.commands.executeCommand('vscode.open', target);
  }
}

/** Streams com.apple.syslog_relay into a terminal; lines end with "\n\0". */
class IosSyslogTerminal implements vscode.Pseudoterminal {
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly closer = new vscode.EventEmitter<void>();
  readonly onDidWrite = this.writer.event;
  readonly onDidClose = this.closer.event;
  private socket: Socket | undefined;
  private pending = '';

  constructor(
    private readonly ios: IosDevices,
    private readonly udid: string,
    private readonly filter: string
  ) {}

  open(): void {
    this.writer.fire(`\x1b[2mStreaming the device log${this.filter ? ` (lines containing "${this.filter}")` : ''}. Ctrl+C stops.\x1b[0m\r\n`);
    this.ios.openSyslog(this.udid).then(
      (socket) => {
        this.socket = socket;
        socket.on('data', (chunk: Buffer) => this.receive(chunk.toString('utf8')));
        socket.on('close', () => this.writer.fire('\r\n\x1b[2mThe device closed the log stream.\x1b[0m\r\n'));
      },
      (error) => this.writer.fire(`\x1b[31m${errorMessage(error)}\x1b[0m\r\n`)
    );
  }

  private receive(text: string): void {
    const { lines, pending } = splitSyslog(this.pending, text);
    this.pending = pending;
    for (const line of lines) {
      if (!this.filter || line.toLowerCase().includes(this.filter)) {
        this.writer.fire(`${formatSyslogLine(line).replace(/\n/g, '\r\n')}\r\n`);
      }
    }
  }

  handleInput(data: string): void {
    if (data === '\x03') {
      this.close();
      this.closer.fire();
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}

/** logcat for Android, the system log for iOS, in a terminal. */
export async function showLogs(adb: Adb, ios: IosDevices, device: DeviceNode): Promise<void> {
  const name = `Log: ${deviceName(device)}`;
  if (device.platform === 'android') {
    vscode.window
      .createTerminal({ name, shellPath: adb.path, shellArgs: ['-s', device.device.serial, 'logcat', '-v', 'threadtime', '-v', 'color'], iconPath: new vscode.ThemeIcon('output') })
      .show();
    return;
  }
  const filter = await vscode.window.showInputBox({ title: name, prompt: 'Show only lines containing this text (process name, subsystem…). Leave empty for everything.' });
  if (filter === undefined) {
    return;
  }
  vscode.window
    .createTerminal({ name, pty: new IosSyslogTerminal(ios, device.device.udid, filter.trim().toLowerCase()), iconPath: new vscode.ThemeIcon('output') })
    .show();
}

function hostOf(address: string): string {
  return address.replace(/:\d+$/, '');
}

/**
 * Reconnects Android devices from the recent list when they come back on the network: `adb tcpip` devices
 * at their old address, Wireless debugging devices at the new port mDNS announces for a known host.
 */
export class AutoReconnect implements vscode.Disposable {
  private readonly timer: NodeJS.Timeout;
  private running = false;
  /** Addresses the user disconnected in this session; they stay disconnected until connected by hand. */
  private readonly suppressed = new Set<string>();

  constructor(
    private readonly adb: Adb,
    private readonly tree: DevicesTree,
    private readonly state: vscode.Memento,
    private readonly output: vscode.LogOutputChannel
  ) {
    this.timer = setInterval(() => void this.tick(), RECONNECT_INTERVAL);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  suppress(serials: string[]): void {
    serials.forEach((serial) => this.suppressed.add(hostOf(serial)));
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('mobile-device-manager').get<boolean>('android.autoReconnect', true);
  }

  private async tick(): Promise<void> {
    if (this.running || !this.enabled() || !this.tree.view.visible) {
      return;
    }
    this.running = true;
    try {
      const connectedHosts = new Set(this.tree.devices.map((d) => hostOf(d.serial)));
      // A host the user reconnected by hand is no longer held back.
      connectedHosts.forEach((host) => this.suppressed.delete(host));
      const recent = this.state.get<string[]>(RECENT_KEY, []);
      const recentHosts = new Set(recent.map(hostOf));
      const announced = (await this.adb.mdnsServices()).filter((s) => s.kind === 'connect' && recentHosts.has(hostOf(s.address))).map((s) => s.address);
      const candidates = [...new Set([...announced, ...recent])].filter((a) => !connectedHosts.has(hostOf(a)) && !this.suppressed.has(hostOf(a)));
      const results = await Promise.all(
        candidates.map(async (address) => {
          const ok = parseConnectResult(await this.adb.connect(address)).ok;
          if (ok) {
            this.output.info(`Reconnected to ${address}`);
            await remember(this.state, address);
          }
          return ok;
        })
      );
      if (results.some(Boolean)) {
        await this.tree.refresh();
      }
    } catch (error) {
      this.output.debug(`Auto reconnect: ${errorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }
}
