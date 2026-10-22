import * as vscode from 'vscode';
import { DirEntry } from '../deviceFs';
import { AfcClient, AfcError, AfcStat, AfcStatus } from './afc';
import { IosDevices } from './devices';
import { LockdownError, NotPairedError } from './lockdown';
import { APPS_FOLDER, IosLocation, MEDIA_FOLDER, resolveIosPath } from './paths';
import { UsbmuxError } from './usbmux';

export const IOS_SCHEME = 'ios';

/** `ios://<udid>/Media/DCIM/100APPLE/IMG_0001.HEIC`, `ios://<udid>/Apps/com.example.app/notes.txt` */
export function iosUri(udid: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: IOS_SCHEME, authority: udid, path });
}

function fileType(type: AfcStat['type']): vscode.FileType {
  return type === 'directory' ? vscode.FileType.Directory : type === 'symlink' ? vscode.FileType.File | vscode.FileType.SymbolicLink : vscode.FileType.File;
}

function toFileSystemError(error: unknown, uri: vscode.Uri): unknown {
  if (error instanceof vscode.FileSystemError) {
    return error;
  }
  if (error instanceof AfcError) {
    switch (error.status) {
      case AfcStatus.ObjectNotFound:
        return vscode.FileSystemError.FileNotFound(uri);
      case AfcStatus.ObjectIsDir:
        return vscode.FileSystemError.FileIsADirectory(uri);
      case AfcStatus.PermDenied:
        return vscode.FileSystemError.NoPermissions(uri);
      case AfcStatus.ObjectExists:
        return vscode.FileSystemError.FileExists(uri);
      default:
        return new Error(error.message);
    }
  }
  if (error instanceof NotPairedError || error instanceof LockdownError || error instanceof UsbmuxError || (error as NodeJS.ErrnoException)?.code) {
    return vscode.FileSystemError.Unavailable(`${uri.authority}: ${(error as Error).message}`);
  }
  return error;
}

const VIRTUAL_DIR: vscode.FileStat = { type: vscode.FileType.Directory, size: 0, ctime: 0, mtime: 0, permissions: vscode.FilePermission.Readonly };

/**
 * Exposes an iPhone or iPad as `ios://<udid>/` over usbmuxd: the shared media folder (photos, Downloads)
 * and the Documents of apps that share files. iOS does not give access to the rest of its file system.
 */
export class IosFileSystem implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;

  constructor(private readonly devices: IosDevices) {}

  dispose(): void {
    this.changes.dispose();
  }

  notify(type: vscode.FileChangeType, ...uris: vscode.Uri[]): void {
    const parent = (uri: vscode.Uri) => uri.with({ path: uri.path.replace(/\/[^/]*\/?$/, '') || '/' });
    this.changes.fire([...uris.map((uri) => ({ type, uri })), ...uris.map((uri) => ({ type: vscode.FileChangeType.Changed, uri: parent(uri) }))]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  private locate(uri: vscode.Uri): IosLocation {
    const location = resolveIosPath(uri.path);
    if (!location) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return location;
  }

  /** Runs an AFC action, reconnecting once if the cached connection dropped (Wi‑Fi sleep, device relock). */
  private async withAfc<T>(uri: vscode.Uri, action: (afc: AfcClient, path: string, location: Extract<IosLocation, { kind: 'afc' }>) => Promise<T>): Promise<T> {
    const location = this.locate(uri);
    if (location.kind !== 'afc') {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const afc = await this.devices.afc(uri.authority, location.domain);
        return await action(afc, location.path, location);
      } catch (error) {
        const retry = attempt === 0 && !(error instanceof AfcError) && !(error instanceof vscode.FileSystemError) && !(error instanceof NotPairedError);
        if (!retry) {
          throw toFileSystemError(error, uri);
        }
      }
    }
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const location = this.locate(uri);
    if (location.kind !== 'afc') {
      return VIRTUAL_DIR;
    }
    const stat = await this.withAfc(uri, (afc, path) => afc.stat(path));
    return { type: fileType(stat.type), size: stat.size, mtime: stat.mtime, ctime: stat.ctime };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return (await this.list(uri)).map((entry) => [entry.name, fileType(entry.type)]);
  }

  /** Entries with sizes and dates; app folders carry the app name as label. */
  async list(uri: vscode.Uri): Promise<DirEntry[]> {
    const location = this.locate(uri);
    if (location.kind === 'root') {
      return [
        { name: MEDIA_FOLDER, type: 'directory', size: 0, mtime: 0, label: 'Media', description: 'DCIM, Downloads, Books…', readonly: 'root' },
        { name: APPS_FOLDER, type: 'directory', size: 0, mtime: 0, label: 'Apps', description: 'Documents of apps that share files', readonly: 'virtual' }
      ];
    }
    if (location.kind === 'apps') {
      try {
        const apps = await this.devices.listApps(uri.authority);
        return apps.map((app) => ({ name: app.bundleId, type: 'directory', size: 0, mtime: 0, label: app.name, description: app.bundleId, readonly: 'root' }));
      } catch (error) {
        throw toFileSystemError(error, uri);
      }
    }
    return this.withAfc(uri, async (afc, path) => {
      const names = await afc.readDir(path);
      // Requests are pipelined, so stat all entries at once.
      const stats = await Promise.all(names.map((name) => afc.stat(`${path.replace(/\/$/, '')}/${name}`).catch(() => undefined)));
      return names.flatMap((name, i) => {
        const stat = stats[i];
        return stat ? [{ name, type: stat.type, size: stat.size, mtime: stat.mtime }] : [];
      });
    });
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.withAfc(uri, async (afc, path) => {
      if ((await afc.stat(path)).type === 'directory') {
        throw vscode.FileSystemError.FileIsADirectory(uri);
      }
      return afc.readFile(path);
    });
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const exists = await this.exists(uri);
    if (exists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    await this.withAfc(uri, (afc, path) => afc.writeFile(path, content));
    this.notify(exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    if (await this.exists(uri)) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    await this.withAfc(uri, (afc, path) => afc.mkdir(path));
    this.notify(vscode.FileChangeType.Created, uri);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.withAfc(uri, (afc, path, location) => {
      if (location.isDomainRoot) {
        throw vscode.FileSystemError.NoPermissions(uri);
      }
      return options.recursive ? afc.removeAll(path) : afc.remove(path);
    });
    this.notify(vscode.FileChangeType.Deleted, uri);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const from = this.locate(oldUri);
    const to = this.locate(newUri);
    const sameConnection =
      from.kind === 'afc' && to.kind === 'afc' && oldUri.authority === newUri.authority && JSON.stringify(from.domain) === JSON.stringify(to.domain);
    if (from.kind !== 'afc' || from.isDomainRoot || to.kind !== 'afc' || to.isDomainRoot) {
      throw vscode.FileSystemError.NoPermissions(oldUri);
    }
    if (await this.exists(newUri)) {
      if (!options.overwrite) {
        throw vscode.FileSystemError.FileExists(newUri);
      }
      await this.delete(newUri, { recursive: true });
    }
    if (sameConnection) {
      await this.withAfc(oldUri, (afc, path) => afc.rename(path, to.path));
    } else {
      // Between apps or devices: copy through this computer, then remove the source.
      await this.copyTree(oldUri, newUri);
      await this.delete(oldUri, { recursive: true });
    }
    this.notify(vscode.FileChangeType.Deleted, oldUri);
    this.notify(vscode.FileChangeType.Created, newUri);
  }

  async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (await this.exists(destination)) {
      if (!options.overwrite) {
        throw vscode.FileSystemError.FileExists(destination);
      }
      await this.delete(destination, { recursive: true });
    }
    await this.copyTree(source, destination);
    this.notify(vscode.FileChangeType.Created, destination);
  }

  private async copyTree(source: vscode.Uri, destination: vscode.Uri): Promise<void> {
    const stat = await this.stat(source);
    if (stat.type & vscode.FileType.Directory) {
      await this.withAfc(destination, (afc, path) => afc.mkdir(path));
      for (const entry of await this.list(source)) {
        await this.copyTree(vscode.Uri.joinPath(source, entry.name), vscode.Uri.joinPath(destination, entry.name));
      }
    } else {
      const content = await this.readFile(source);
      await this.withAfc(destination, (afc, path) => afc.writeFile(path, content));
    }
  }

  async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await this.stat(uri);
      return true;
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return false;
      }
      throw error;
    }
  }
}
