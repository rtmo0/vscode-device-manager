import * as vscode from 'vscode';
import { connect, disconnect, pair, switchToWifi } from './actions/connect';
import { addToWorkspace, download, move, newFolder, openShell, remove, rename, upload } from './actions/files';
import { enableWifi, showIosHelp } from './actions/ios';
import { Adb } from './android/adb';
import { ANDROID_SCHEME, AndroidFileSystem } from './android/fileSystem';
import { installPlatformTools } from './android/platformTools';
import { IosDevices } from './ios/devices';
import { IOS_SCHEME, IosFileSystem } from './ios/fileSystem';
import { guarded, notify } from './ui';
import { AndroidDeviceNode, DeviceNode, deviceName, deviceRoot, DevicesTree, EntryNode, IosDeviceNode, Node, targetFolder } from './views/devicesTree';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Mobile Device Manager', { log: true });
  const adb = new Adb(output, context.globalStorageUri);
  const ios = new IosDevices(output);
  const androidFs = new AndroidFileSystem(adb);
  const iosFs = new IosFileSystem(ios);
  const tree = new DevicesTree(adb, ios, { [ANDROID_SCHEME]: androidFs, [IOS_SCHEME]: iosFs }, output);
  const state = context.globalState;
  context.subscriptions.push(
    output,
    ios,
    androidFs,
    iosFs,
    tree,
    vscode.workspace.registerFileSystemProvider(ANDROID_SCHEME, androidFs, { isCaseSensitive: true }),
    vscode.workspace.registerFileSystemProvider(IOS_SCHEME, iosFs, { isCaseSensitive: true })
  );

  const selection = (node?: Node, selected?: readonly Node[]) => tree.targets(node, selected);
  const entries = (node?: Node, selected?: readonly Node[]): EntryNode[] => selection(node, selected).filter((n): n is EntryNode => n.kind === 'entry');
  const androidDevices = (node?: Node, selected?: readonly Node[]): AndroidDeviceNode[] =>
    selection(node, selected).filter((n): n is AndroidDeviceNode => n.kind === 'device' && n.platform === 'android');
  const folder = (node?: Node): vscode.Uri | undefined => {
    const target = node ?? tree.view.selection[0];
    return target && target.kind !== 'message' ? targetFolder(target) : undefined;
  };

  const commands: Record<string, (...args: never[]) => unknown> = {
    'mobile-device-manager.showOutput': () => output.show(),
    'mobile-device-manager.refresh': () => tree.refresh(),
    'mobile-device-manager.connect': () => connect(adb, tree, state, showIosHelp),
    'mobile-device-manager.pair': () => pair(adb, tree, state),
    'mobile-device-manager.switchToWifi': (node?: AndroidDeviceNode) => switchToWifi(adb, tree, state, node?.device),
    'mobile-device-manager.disconnect': (node?: Node, selected?: Node[]) => disconnect(adb, tree, androidDevices(node, selected).map((n) => n.device)),
    'mobile-device-manager.enableIosWifi': (node?: IosDeviceNode) => enableWifi(ios, tree, node),
    'mobile-device-manager.iosHelp': () => showIosHelp(),
    'mobile-device-manager.installAdb': async () => {
      const path = await installPlatformTools(context.globalStorageUri);
      if (path) {
        adb.resetPath();
        output.info(`Downloaded adb to ${path}`);
        notify('$(check) Android Platform-Tools downloaded');
        await tree.refresh();
      }
    },
    'mobile-device-manager.addToWorkspace': (node?: DeviceNode | EntryNode) => {
      const target = node ?? tree.view.selection[0];
      if (target?.kind === 'device') {
        addToWorkspace(deviceRoot(target), deviceName(target));
      } else if (target?.kind === 'entry') {
        const device = tree.deviceOf(target.uri);
        const uri = target.type === 'directory' ? target.uri : vscode.Uri.joinPath(target.uri, '..');
        addToWorkspace(uri, `${device ? deviceName(device) : uri.authority} (${uri.path})`);
      }
    },
    'mobile-device-manager.openShell': (node?: DeviceNode | EntryNode) => {
      const target = node ?? tree.view.selection[0];
      if (target?.kind === 'device') {
        openShell(adb, target);
      } else if (target?.kind === 'entry') {
        const device = tree.deviceOf(target.uri);
        if (device) {
          openShell(adb, device, target.type === 'directory' ? target.uri.path : vscode.Uri.joinPath(target.uri, '..').path);
        }
      } else {
        const device = tree.devices.find((d) => d.state === 'device');
        if (device) {
          openShell(adb, { kind: 'device', platform: 'android', device });
        }
      }
    },
    'mobile-device-manager.upload': (node?: Node | vscode.Uri, uris?: vscode.Uri[]) => {
      const target = node instanceof vscode.Uri ? node : folder(node);
      return target && upload(adb, tree, target, uris);
    },
    'mobile-device-manager.download': (node?: Node, selected?: Node[]) => download(adb, tree, entries(node, selected)),
    'mobile-device-manager.newFolder': (node?: Node) => {
      const target = folder(node);
      return target && newFolder(target);
    },
    'mobile-device-manager.rename': (node?: EntryNode) => {
      const [target] = entries(node);
      return target && rename(target);
    },
    'mobile-device-manager.delete': (node?: Node, selected?: Node[]) => remove(entries(node, selected)),
    'mobile-device-manager.move': (moved: EntryNode[], target: vscode.Uri) => move(moved, target),
    'mobile-device-manager.copyPath': async (node?: Node, selected?: Node[]) => {
      const paths = entries(node, selected).map((n) => n.uri.path);
      await vscode.env.clipboard.writeText(paths.join('\n'));
      notify(`$(copy) Copied ${paths.length === 1 ? paths[0] : `${paths.length} paths`}`);
    },
    'mobile-device-manager.openFile': (node?: EntryNode) => {
      const [target] = entries(node);
      return target && vscode.commands.executeCommand('vscode.open', target.uri);
    }
  };
  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, guarded(handler)));
  }
}

export function deactivate(): void {
  // Wi‑Fi connections belong to the adb server and usbmuxd and outlive the extension.
}
