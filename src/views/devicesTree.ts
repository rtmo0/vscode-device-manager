import * as vscode from 'vscode';
import { Adb, AdbNotFoundError } from '../android/adb';
import { ANDROID_SCHEME, androidUri } from '../android/fileSystem';
import { ANDROID_INFO_COMMAND, AndroidDevice, DeviceInfo, parseAndroidInfo } from '../android/parse';
import { DeviceFileSystem, DirEntry } from '../deviceFs';
import { IosDevice, IosDevices } from '../ios/devices';
import { iosUri } from '../ios/fileSystem';
import { MEDIA_FOLDER } from '../ios/paths';
import { errorMessage, formatSize } from '../ui';

export const DEVICES_VIEW_ID = 'mobile-device-manager.devices';
const TREE_MIME = `application/vnd.code.tree.${DEVICES_VIEW_ID}`;
const POLL_INTERVAL = 3000;
const INFO_TTL = 60000;

export interface AndroidDeviceNode {
  kind: 'device';
  platform: 'android';
  device: AndroidDevice;
}

export interface IosDeviceNode {
  kind: 'device';
  platform: 'ios';
  device: IosDevice;
}

export type DeviceNode = AndroidDeviceNode | IosDeviceNode;

export interface EntryNode extends DirEntry {
  kind: 'entry';
  uri: vscode.Uri;
}

interface MessageNode {
  kind: 'message';
  text: string;
  command?: vscode.Command;
}

export type Node = DeviceNode | EntryNode | MessageNode;

function rootPath(): string {
  return vscode.workspace.getConfiguration('mobile-device-manager').get<string>('android.rootPath') || '/sdcard';
}

export function deviceName(node: DeviceNode): string {
  return node.platform === 'android' ? (node.device.model ?? node.device.serial) : (node.device.name ?? node.device.udid);
}

export function isOnline(node: DeviceNode): boolean {
  return node.platform === 'android' ? node.device.state === 'device' : node.device.state === 'ready';
}

/** The folder a device opens at: the Android root path, or the iOS virtual root with Media and Apps. */
export function deviceRoot(node: DeviceNode): vscode.Uri {
  return node.platform === 'android' ? androidUri(node.device.serial, rootPath()) : iosUri(node.device.udid, '/');
}

/** Where files dropped on or uploaded to a node go. */
export function targetFolder(node: DeviceNode | EntryNode): vscode.Uri | undefined {
  if (node.kind === 'device') {
    if (!isOnline(node)) {
      return undefined;
    }
    return node.platform === 'android' ? deviceRoot(node) : iosUri(node.device.udid, `/${MEDIA_FOLDER}`);
  }
  if (node.type !== 'directory') {
    return vscode.Uri.joinPath(node.uri, '..');
  }
  return node.readonly === 'virtual' ? undefined : node.uri;
}

const ANDROID_HINTS: Record<string, string> = {
  unauthorized: 'allow USB debugging on the device',
  offline: 'offline',
  authorizing: 'authorizing…',
  connecting: 'connecting…',
  'no permissions': 'no USB permissions (udev rules)'
};

const IOS_HINTS: Record<string, string> = {
  unpaired: 'unlock it and tap Trust',
  locked: 'unlock the device',
  error: 'not available'
};

const TRANSPORT_LABELS = { wifi: 'Wi-Fi', usb: 'USB', emulator: 'Emulator' };

function batteryText(info?: DeviceInfo): string | undefined {
  return info?.battery === undefined ? undefined : `${info.battery}%${info.charging ? ' charging' : ''}`;
}

function infoLines(info?: DeviceInfo): string[] {
  if (!info) {
    return [];
  }
  const lines: string[] = [];
  if (info.os) {
    lines.push(`System: ${info.os}`);
  }
  if (info.manufacturer) {
    lines.push(`Manufacturer: ${info.manufacturer}`);
  }
  if (info.battery !== undefined) {
    lines.push(`Battery: ${batteryText(info)}`);
  }
  if (info.storageTotal) {
    lines.push(`Storage: ${info.storageFree !== undefined ? `${formatSize(info.storageFree)} free of ` : ''}${formatSize(info.storageTotal)}`);
  }
  return lines;
}

/** Android devices known to adb and iOS devices known to usbmuxd, with their files. */
export class DevicesTree implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dragMimeTypes = ['text/uri-list'];
  readonly dropMimeTypes = [TREE_MIME, 'text/uri-list', 'files'];

  readonly view: vscode.TreeView<Node>;
  devices: AndroidDevice[] = [];
  iosDevices: IosDevice[] = [];
  private androidError: unknown;
  private iosError: string | undefined;
  private iosLogged: string | undefined;
  private readonly androidInfo = new Map<string, { at: number; info?: DeviceInfo }>();
  private snapshot = '';
  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly adb: Adb,
    private readonly ios: IosDevices,
    private readonly fileSystems: Record<string, DeviceFileSystem>,
    private readonly output: vscode.LogOutputChannel
  ) {
    this.view = vscode.window.createTreeView(DEVICES_VIEW_ID, { treeDataProvider: this, dragAndDropController: this, canSelectMany: true, showCollapseAll: true });
    this.disposables.push(
      this.view,
      this.changed,
      this.view.onDidChangeVisibility(() => this.poll()),
      ...Object.values(fileSystems).map((fs) => fs.onDidChangeFile(() => this.changed.fire(undefined))),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mobile-device-manager')) {
          adb.resetPath();
          void this.refresh();
        }
      })
    );
    this.poll();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  /** Re-reads the device lists while the view is visible. */
  private poll(): void {
    clearTimeout(this.timer);
    if (!this.view.visible) {
      return;
    }
    void this.loadDevices().finally(() => {
      this.timer = setTimeout(() => this.poll(), POLL_INTERVAL);
    });
  }

  private async loadDevices(): Promise<boolean> {
    const [android, ios] = await Promise.allSettled([this.adb.devices(), this.ios.list()]);
    const devices = android.status === 'fulfilled' ? android.value : [];
    const androidError = android.status === 'rejected' ? android.reason : undefined;
    const iosDevices = ios.status === 'fulfilled' ? ios.value : [];
    let iosError: string | undefined;
    if (ios.status === 'rejected') {
      // Without usbmuxd (no Apple Devices app on Windows, no usbmuxd on Linux) iOS is simply unavailable.
      const code = (ios.reason as NodeJS.ErrnoException).code;
      iosError = code === 'ENOENT' || code === 'ECONNREFUSED' ? undefined : errorMessage(ios.reason);
      if (errorMessage(ios.reason) !== this.iosLogged) {
        this.iosLogged = errorMessage(ios.reason);
        this.output.info(`iOS devices are unavailable: ${this.iosLogged}`);
      }
    }
    const snapshot = JSON.stringify([devices, iosDevices, errorMessage(androidError ?? ''), iosError]);
    if (snapshot === this.snapshot) {
      return false;
    }
    this.snapshot = snapshot;
    if (androidError && !(androidError instanceof AdbNotFoundError)) {
      this.output.warn(errorMessage(androidError));
    }
    this.devices = devices;
    this.iosDevices = iosDevices;
    this.androidError = androidError;
    this.iosError = iosError;
    void vscode.commands.executeCommand('setContext', 'mobile-device-manager.hasDevices', devices.length + iosDevices.length > 0 || !!androidError || !!iosError);
    this.changed.fire(undefined);
    return true;
  }

  async refresh(): Promise<void> {
    if (!(await this.loadDevices())) {
      this.changed.fire(undefined);
    }
  }

  androidDevice(serial: string): AndroidDevice | undefined {
    return this.devices.find((d) => d.serial === serial);
  }

  /** The device node behind a file URI, for names and the root folder. */
  deviceOf(uri: vscode.Uri): DeviceNode | undefined {
    if (uri.scheme === ANDROID_SCHEME) {
      const device = this.androidDevice(uri.authority);
      return device && { kind: 'device', platform: 'android', device };
    }
    const device = this.iosDevices.find((d) => d.udid === uri.authority);
    return device && { kind: 'device', platform: 'ios', device };
  }

  fileSystem(uri: vscode.Uri): DeviceFileSystem {
    return this.fileSystems[uri.scheme];
  }

  /** The target of a context menu or toolbar command: the clicked node plus the rest of the selection. */
  targets(node?: Node, selected?: readonly Node[]): Node[] {
    if (selected?.length && (!node || selected.includes(node))) {
      return [...selected];
    }
    return node ? [node] : [...this.view.selection];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon(node.command ? 'cloud-download' : 'warning');
      item.command = node.command;
      return item;
    }
    if (node.kind === 'device') {
      return node.platform === 'android' ? this.androidItem(node.device) : this.iosItem(node.device);
    }
    const isDir = node.type === 'directory';
    const state = isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    const item = node.label ? new vscode.TreeItem(node.label, state) : new vscode.TreeItem(node.uri, state);
    item.resourceUri = node.uri;
    item.id = `entry:${node.uri.toString()}`;
    item.contextValue = isDir ? (node.readonly ? `folder-${node.readonly}` : 'folder') : 'file';
    item.description = node.description ?? (isDir ? undefined : formatSize(node.size));
    item.tooltip = node.mtime ? `${node.uri.path}\n${isDir ? '' : `${formatSize(node.size)} · `}${new Date(node.mtime).toLocaleString()}` : node.uri.path;
    item.iconPath = node.readonly === 'virtual' ? new vscode.ThemeIcon('package') : isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    if (!isDir) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
    }
    return item;
  }

  /** Version, battery and storage of an Android device, re-read in the background at most once a minute. */
  private androidDetails(device: AndroidDevice): DeviceInfo | undefined {
    const cached = this.androidInfo.get(device.serial);
    if (device.state === 'device' && (!cached || Date.now() - cached.at > INFO_TTL)) {
      this.androidInfo.set(device.serial, { at: Date.now(), info: cached?.info });
      void this.adb
        .shell(device.serial, ANDROID_INFO_COMMAND, { allowFailure: true, timeout: 15000 })
        .then((output) => {
          const info = parseAndroidInfo(output);
          if (JSON.stringify(info) !== JSON.stringify(cached?.info)) {
            this.androidInfo.set(device.serial, { at: Date.now(), info });
            this.changed.fire(undefined);
          }
        })
        .catch((error) => this.output.debug(`${device.serial} details: ${errorMessage(error)}`));
    }
    return cached?.info;
  }

  private androidItem(device: AndroidDevice): vscode.TreeItem {
    const online = device.state === 'device';
    const info = this.androidDetails(device);
    const item = new vscode.TreeItem(device.model ?? device.serial, online ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `android:${device.serial}`;
    item.description = [info?.os ?? 'Android', TRANSPORT_LABELS[device.transport], batteryText(info), ANDROID_HINTS[device.state]].filter(Boolean).join(' · ');
    item.tooltip = new vscode.MarkdownString(
      [`**${device.model ?? device.serial}**`, ...infoLines(info), `Serial: \`${device.serial}\``, `Connection: ${TRANSPORT_LABELS[device.transport]}`, `State: ${device.state}`].join('\n\n')
    );
    item.iconPath = online
      ? new vscode.ThemeIcon(device.transport === 'wifi' ? 'radio-tower' : device.transport === 'emulator' ? 'vm' : 'device-mobile')
      : new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    item.contextValue = online ? `device-android-${device.transport}` : 'device-android-offline';
    return item;
  }

  private iosItem(device: IosDevice): vscode.TreeItem {
    const ready = device.state === 'ready';
    const item = new vscode.TreeItem(device.name ?? device.udid, ready ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `ios:${device.udid}`;
    item.description = [device.version ? `iOS ${device.version}` : 'iOS', TRANSPORT_LABELS[device.transport], batteryText(device.details), IOS_HINTS[device.state]]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = new vscode.MarkdownString(
      [
        `**${device.name ?? device.udid}**`,
        device.productType && `Model: ${device.productType}`,
        ...infoLines(device.details).filter((line) => !line.startsWith('System')),
        `UDID: \`${device.udid}\``,
        `Connection: ${TRANSPORT_LABELS[device.transport]}`,
        device.error
      ]
        .filter(Boolean)
        .join('\n\n')
    );
    item.iconPath = ready
      ? new vscode.ThemeIcon(device.transport === 'wifi' ? 'radio-tower' : 'device-mobile')
      : new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    item.contextValue = ready ? `device-ios-${device.transport}` : 'device-ios-offline';
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.rootNodes();
    }
    if (node.kind === 'message' || (node.kind === 'entry' && node.type !== 'directory')) {
      return [];
    }
    const dir = node.kind === 'device' ? deviceRoot(node) : node.uri;
    try {
      const entries = await this.fileSystem(dir).list(dir);
      return entries
        .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || (a.label ?? a.name).localeCompare(b.label ?? b.name, undefined, { numeric: true, sensitivity: 'base' }))
        .map((entry) => ({ ...entry, kind: 'entry', uri: vscode.Uri.joinPath(dir, entry.name) }));
    } catch (error) {
      return [{ kind: 'message', text: errorMessage(error) }];
    }
  }

  private rootNodes(): Node[] {
    const nodes: Node[] = [
      ...this.devices.map((device): Node => ({ kind: 'device', platform: 'android', device })),
      ...this.iosDevices.map((device): Node => ({ kind: 'device', platform: 'ios', device }))
    ];
    if (this.androidError instanceof AdbNotFoundError) {
      nodes.push({
        kind: 'message',
        text: 'Android: download adb (Platform-Tools)…',
        command: { command: 'mobile-device-manager.installAdb', title: 'Download Android Platform-Tools' }
      });
    } else if (this.androidError) {
      nodes.push({ kind: 'message', text: `Android: ${errorMessage(this.androidError)}` });
    }
    if (this.iosError) {
      nodes.push({ kind: 'message', text: `iOS: ${this.iosError}` });
    }
    return nodes;
  }

  handleDrag(nodes: readonly Node[], data: vscode.DataTransfer): void {
    const entries = nodes.filter((n): n is EntryNode => n.kind === 'entry' && !n.readonly);
    data.set('text/uri-list', new vscode.DataTransferItem(entries.map((n) => n.uri.toString()).join('\r\n')));
    data.set(TREE_MIME, new vscode.DataTransferItem(entries));
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    const folder = target && target.kind !== 'message' ? targetFolder(target) : undefined;
    if (!folder) {
      return;
    }
    const moved: EntryNode[] | undefined = data.get(TREE_MIME)?.value;
    if (moved?.length) {
      await vscode.commands.executeCommand('mobile-device-manager.move', moved, folder);
      return;
    }
    const uris = await droppedUris(data);
    // .apk / .ipa files dropped on the device itself are installed rather than copied.
    const appExt = target?.kind === 'device' ? (target.platform === 'android' ? '.apk' : '.ipa') : undefined;
    if (appExt && uris.length && uris.every((u) => u.path.toLowerCase().endsWith(appExt))) {
      await vscode.commands.executeCommand('mobile-device-manager.installApp', target, uris);
      return;
    }
    if (uris.length && !token.isCancellationRequested) {
      await vscode.commands.executeCommand('mobile-device-manager.upload', folder, uris);
    }
  }
}

/** Files dropped from the Explorer arrive as `text/uri-list`, files from the OS as `files`. */
async function droppedUris(data: vscode.DataTransfer): Promise<vscode.Uri[]> {
  const list = await data.get('text/uri-list')?.asString();
  if (list) {
    return list
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => vscode.Uri.parse(line));
  }
  const uris: vscode.Uri[] = [];
  data.forEach((item) => {
    const uri = item.asFile()?.uri;
    if (uri) {
      uris.push(uri);
    }
  });
  return uris;
}
