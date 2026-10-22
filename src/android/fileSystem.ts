import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { DeviceFileSystem } from '../deviceFs';
import { Adb, AdbError } from './adb';
import { basename, dirname, parseStat, shellQuote, STAT_FORMAT, StatEntry } from './parse';

export const ANDROID_SCHEME = 'android';

/** `android://<serial>/sdcard/Download/file.txt` */
export function androidUri(serial: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: ANDROID_SCHEME, authority: serial, path });
}

function fileType(entry: StatEntry): vscode.FileType {
  switch (entry.type) {
    case 'directory':
      return vscode.FileType.Directory;
    case 'file':
      return vscode.FileType.File;
    case 'symlink':
      return vscode.FileType.SymbolicLink;
    default:
      return vscode.FileType.Unknown;
  }
}

/** Maps toybox / adb error text to the FileSystemError VS Code expects. */
function toFileSystemError(error: unknown, uri: vscode.Uri): unknown {
  if (!(error instanceof AdbError)) {
    return error;
  }
  const text = error.message;
  if (/No such file or directory|does not exist/i.test(text)) {
    return vscode.FileSystemError.FileNotFound(uri);
  }
  if (/Permission denied|Read-only file system|Operation not permitted/i.test(text)) {
    return vscode.FileSystemError.NoPermissions(uri);
  }
  if (/File exists/i.test(text)) {
    return vscode.FileSystemError.FileExists(uri);
  }
  if (/Not a directory/i.test(text)) {
    return vscode.FileSystemError.FileNotADirectory(uri);
  }
  if (/Is a directory/i.test(text)) {
    return vscode.FileSystemError.FileIsADirectory(uri);
  }
  if (/device .*not found|device offline|no devices/i.test(text)) {
    return vscode.FileSystemError.Unavailable(`${uri.authority}: ${text}`);
  }
  return new Error(text);
}

/**
 * Exposes an Android device as `android://<serial>/…` through adb, so device files open in editors,
 * appear in the Explorer as a workspace folder and can be copied with the regular Explorer commands.
 */
export class AndroidFileSystem implements DeviceFileSystem {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;

  constructor(private readonly adb: Adb) {}

  dispose(): void {
    this.changes.dispose();
  }

  /** The provider has no device-side watcher; it reports its own changes and those made by the Devices view. */
  notify(type: vscode.FileChangeType, ...uris: vscode.Uri[]): void {
    const events = uris.map((uri) => ({ type, uri }));
    this.changes.fire([...events, ...uris.map((uri) => ({ type: vscode.FileChangeType.Changed, uri: uri.with({ path: dirname(uri.path) }) }))]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  private async run<T>(uri: vscode.Uri, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const [entry] = await this.run(uri, async () =>
      parseStat(await this.adb.shell(uri.authority, `stat -L -c '${STAT_FORMAT}' ${shellQuote(uri.path)}`))
    );
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { type: fileType(entry), size: entry.size, mtime: entry.mtime, ctime: entry.mtime };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return (await this.list(uri)).map((entry) => [entry.name, fileType(entry)]);
  }

  /** Directory entries with sizes and dates. Symbolic links are resolved; broken ones are left out. */
  list(uri: vscode.Uri): Promise<StatEntry[]> {
    // `stat` exits non-zero for an unmatched glob in an empty directory, so only `cd` decides failure.
    const command = `cd ${shellQuote(uri.path)} || exit 1; stat -L -c '${STAT_FORMAT}' .* * 2>/dev/null; exit 0`;
    return this.run(uri, async () => parseStat(await this.adb.shell(uri.authority, command)));
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.withTempDir(async (dir) => {
      const local = join(dir, basename(uri.path));
      await this.run(uri, () => this.adb.pull(uri.authority, [uri.path], local));
      return readFile(local);
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
    await this.withTempDir(async (dir) => {
      const local = join(dir, basename(uri.path));
      await writeFile(local, content);
      await this.run(uri, () => this.adb.push(uri.authority, [local], uri.path));
    });
    this.notify(exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.run(uri, () => this.adb.shell(uri.authority, `mkdir ${shellQuote(uri.path)}`));
    this.notify(vscode.FileChangeType.Created, uri);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const stat = await this.stat(uri);
    const path = shellQuote(uri.path);
    const command = stat.type === vscode.FileType.Directory ? (options.recursive ? `rm -rf ${path}` : `rmdir ${path}`) : `rm -f ${path}`;
    await this.run(uri, () => this.adb.shell(uri.authority, command));
    this.notify(vscode.FileChangeType.Deleted, uri);
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    return this.transfer('mv', oldUri, newUri, options.overwrite);
  }

  copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    return this.transfer('cp -r', source, destination, options.overwrite);
  }

  private async transfer(command: string, source: vscode.Uri, destination: vscode.Uri, overwrite: boolean): Promise<void> {
    if (await this.exists(destination)) {
      if (!overwrite) {
        throw vscode.FileSystemError.FileExists(destination);
      }
      await this.run(destination, () => this.adb.shell(destination.authority, `rm -rf ${shellQuote(destination.path)}`));
    }
    if (source.authority === destination.authority) {
      await this.run(source, () => this.adb.shell(source.authority, `${command} ${shellQuote(source.path)} ${shellQuote(destination.path)}`));
    } else {
      // Between two devices the files go through a temporary folder on this computer.
      await this.withTempDir(async (dir) => {
        const local = join(dir, basename(destination.path));
        await this.run(source, () => this.adb.pull(source.authority, [source.path], local));
        await this.run(destination, () => this.adb.push(destination.authority, [local], destination.path));
      });
      if (command === 'mv') {
        await this.run(source, () => this.adb.shell(source.authority, `rm -rf ${shellQuote(source.path)}`));
      }
    }
    if (command === 'mv') {
      this.notify(vscode.FileChangeType.Deleted, source);
    }
    this.notify(vscode.FileChangeType.Created, destination);
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

  private async withTempDir<T>(action: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'mobile-device-manager-'));
    try {
      return await action(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
