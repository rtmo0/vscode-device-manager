import * as vscode from 'vscode';
import { Adb } from '../android/adb';
import { ANDROID_SCHEME } from '../android/fileSystem';
import { basename } from '../android/parse';
import { DeviceNode, deviceName, DevicesTree, EntryNode } from '../views/devicesTree';
import { confirm, notify, plural, withProgress } from '../ui';

function where(tree: DevicesTree, uri: vscode.Uri): string {
  const device = tree.deviceOf(uri);
  return `${device ? deviceName(device) : uri.authority}:${uri.path}`;
}

function child(folder: vscode.Uri, uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(folder, basename(uri.path));
}

/** Uploads local files and folders into a device folder. `uris` comes from drag and drop; otherwise a dialog asks. */
export async function upload(adb: Adb, tree: DevicesTree, folder: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  uris ??= await vscode.window.showOpenDialog({ title: `Upload to ${folder.path}`, canSelectFiles: true, canSelectFolders: true, canSelectMany: true, openLabel: 'Upload' });
  if (!uris?.length) {
    return;
  }
  const items = uris;
  await withProgress(
    `Uploading ${plural(items.length, 'item')} to ${where(tree, folder)}…`,
    async (token) => {
      // adb push streams whole folders at native speed; everything else goes through the VS Code file service.
      const local = folder.scheme === ANDROID_SCHEME ? items.filter((u) => u.scheme === 'file') : [];
      if (local.length) {
        await adb.push(folder.authority, local.map((u) => u.fsPath), folder.path.endsWith('/') ? folder.path : `${folder.path}/`, token);
        tree.fileSystem(folder).notify(vscode.FileChangeType.Changed, folder);
      }
      for (const uri of items.filter((u) => !local.includes(u))) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        await vscode.workspace.fs.copy(uri, child(folder, uri), { overwrite: true });
      }
    },
    true
  );
  notify(`$(cloud-upload) Uploaded ${plural(items.length, 'item')} to ${folder.path}`);
}

/** Downloads device files and folders into a local folder. */
export async function download(adb: Adb, tree: DevicesTree, entries: EntryNode[]): Promise<void> {
  const items = entries.filter((e) => e.readonly !== 'virtual');
  if (!items.length) {
    return;
  }
  const [dest] =
    (await vscode.window.showOpenDialog({ title: `Download ${plural(items.length, 'item')}`, canSelectFiles: false, canSelectFolders: true, openLabel: 'Download Here' })) ?? [];
  if (!dest) {
    return;
  }
  await withProgress(
    `Downloading ${plural(items.length, 'item')} to ${dest.fsPath}…`,
    async (token) => {
      const android = new Map<string, string[]>();
      for (const entry of items) {
        if (entry.uri.scheme === ANDROID_SCHEME) {
          android.set(entry.uri.authority, [...(android.get(entry.uri.authority) ?? []), entry.uri.path]);
        } else {
          if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
          }
          await vscode.workspace.fs.copy(entry.uri, child(dest, entry.uri), { overwrite: true });
        }
      }
      for (const [serial, paths] of android) {
        await adb.pull(serial, paths, dest.fsPath, token);
      }
    },
    true
  );
  const choice = await vscode.window.showInformationMessage(`Downloaded ${plural(items.length, 'item')} from ${where(tree, items[0].uri)}.`, 'Reveal in OS');
  if (choice) {
    await vscode.commands.executeCommand('revealFileInOS', items.length === 1 ? child(dest, items[0].uri) : dest);
  }
}

function validateName(value: string): string | undefined {
  return value.trim() && !value.includes('/') ? undefined : 'Enter a name without "/"';
}

export async function newFolder(folder: vscode.Uri): Promise<void> {
  const name = await vscode.window.showInputBox({ title: `New Folder in ${folder.path}`, validateInput: validateName });
  if (name) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, name.trim()));
  }
}

export async function rename(entry: EntryNode): Promise<void> {
  const old = basename(entry.uri.path);
  const name = await vscode.window.showInputBox({
    title: `Rename ${old}`,
    value: old,
    valueSelection: [0, old.lastIndexOf('.') > 0 ? old.lastIndexOf('.') : old.length],
    validateInput: validateName
  });
  if (name && name.trim() !== old) {
    await vscode.workspace.fs.rename(entry.uri, vscode.Uri.joinPath(entry.uri, '..', name.trim()), { overwrite: false });
  }
}

export async function remove(entries: EntryNode[]): Promise<void> {
  const items = entries.filter((e) => !e.readonly);
  if (!items.length) {
    return;
  }
  const message = items.length === 1 ? `Delete "${basename(items[0].uri.path)}" from the device?` : `Delete ${plural(items.length, 'item')} from the device?`;
  const detail = `${items.map((e) => e.uri.path).slice(0, 10).join('\n')}\n\nThis cannot be undone.`;
  if (!(await confirm(message, detail, 'Delete'))) {
    return;
  }
  for (const entry of items) {
    await vscode.workspace.fs.delete(entry.uri, { recursive: true, useTrash: false });
  }
}

/** Drag and drop inside the Devices view: moves within one device, copies between devices. */
export async function move(entries: EntryNode[], folder: vscode.Uri): Promise<void> {
  const sameDevice = (uri: vscode.Uri) => uri.scheme === folder.scheme && uri.authority === folder.authority;
  const items = entries.filter((e) => {
    const parent = vscode.Uri.joinPath(e.uri, '..');
    // Dropping onto its own folder, itself or one of its subfolders does nothing.
    return !e.readonly && !(sameDevice(e.uri) && (parent.path === folder.path || folder.path === e.uri.path || folder.path.startsWith(`${e.uri.path}/`)));
  });
  if (!items.length) {
    return;
  }
  await withProgress(`Moving ${plural(items.length, 'item')} to ${folder.path}…`, async () => {
    for (const entry of items) {
      if (sameDevice(entry.uri)) {
        await vscode.workspace.fs.rename(entry.uri, child(folder, entry.uri), { overwrite: false });
      } else {
        await vscode.workspace.fs.copy(entry.uri, child(folder, entry.uri), { overwrite: false });
      }
    }
  });
}

/** Adds device storage to the workspace, so the Explorer, search and Quick Open work on it. */
export function addToWorkspace(uri: vscode.Uri, name: string): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.some((f) => f.uri.toString() === uri.toString())) {
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name });
  }
  void vscode.commands.executeCommand('workbench.view.explorer');
}

export function openShell(adb: Adb, device: DeviceNode, cwd?: string): void {
  if (device.platform !== 'android') {
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: `adb shell: ${deviceName(device)}`,
    shellPath: adb.path,
    shellArgs: adb.shellArgs(device.device.serial, cwd),
    iconPath: new vscode.ThemeIcon('device-mobile')
  });
  terminal.show();
}
