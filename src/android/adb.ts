import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AndroidDevice, MdnsService, parseDevices, parseMdnsServices, parseWifiAddress, shellQuote } from './parse';
import { bundledAdbPath } from './platformTools';

export class AdbError extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
  }
}

export class AdbNotFoundError extends Error {
  constructor() {
    super('adb (Android SDK Platform-Tools) was not found.');
  }
}

/** Where platform-tools usually live; VS Code started from the Dock does not see the shell PATH. */
function candidates(): string[] {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const sdks = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter((p): p is string => !!p);
  if (process.platform === 'darwin') {
    sdks.push(join(homedir(), 'Library', 'Android', 'sdk'));
  } else if (process.platform === 'win32') {
    sdks.push(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk'));
  } else {
    sdks.push(join(homedir(), 'Android', 'Sdk'));
  }
  const paths = sdks.map((sdk) => join(sdk, 'platform-tools', exe));
  if (process.platform !== 'win32') {
    paths.push('/opt/homebrew/bin/adb', '/usr/local/bin/adb', '/usr/bin/adb');
  }
  return paths;
}

interface RunOptions {
  /** Return the output instead of throwing on a non-zero exit code. */
  allowFailure?: boolean;
  timeout?: number;
  token?: vscode.CancellationToken;
}

export class Adb {
  private resolved: string | undefined;

  constructor(
    private readonly output: vscode.LogOutputChannel,
    private readonly storage: vscode.Uri
  ) {}

  get path(): string {
    const configured = vscode.workspace.getConfiguration('mobile-device-manager').get<string>('adbPath')?.trim();
    if (configured) {
      return configured;
    }
    // An installed adb wins over the downloaded one: two adb servers of different versions keep restarting each other.
    this.resolved ??= [...candidates(), bundledAdbPath(this.storage)].find((p) => existsSync(p)) ?? 'adb';
    return this.resolved;
  }

  resetPath(): void {
    this.resolved = undefined;
  }

  run(args: string[], options: RunOptions = {}): Promise<string> {
    return this.exec(args, options).then((buffer) => buffer.toString('utf8'));
  }

  exec(args: string[], options: RunOptions = {}): Promise<Buffer> {
    this.output.trace(`adb ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.path,
        args,
        { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, timeout: options.timeout ?? 0, windowsHide: true },
        (error, stdout, stderr) => {
          subscription?.dispose();
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            reject(new AdbNotFoundError());
            return;
          }
          const text = `${stdout.toString('utf8')}${stderr.toString('utf8')}`;
          if (options.token?.isCancellationRequested) {
            reject(new vscode.CancellationError());
          } else if (error && !options.allowFailure) {
            const message = stderr.toString('utf8').trim() || stdout.toString('utf8').trim() || error.message;
            this.output.debug(`adb ${args.join(' ')} failed: ${message}`);
            reject(new AdbError(message, text));
          } else {
            resolve(options.allowFailure ? Buffer.from(text) : stdout);
          }
        }
      );
      const subscription = options.token?.onCancellationRequested(() => child.kill());
    });
  }

  async devices(): Promise<AndroidDevice[]> {
    return parseDevices(await this.run(['devices', '-l'], { timeout: 15000 }));
  }

  async mdnsServices(): Promise<MdnsService[]> {
    return parseMdnsServices(await this.run(['mdns', 'services'], { allowFailure: true, timeout: 10000 }));
  }

  connect(address: string): Promise<string> {
    return this.run(['connect', address], { allowFailure: true, timeout: 20000 });
  }

  pair(address: string, code: string): Promise<string> {
    return this.run(['pair', address, code], { allowFailure: true, timeout: 30000 });
  }

  disconnect(serial: string): Promise<string> {
    return this.run(['disconnect', serial], { allowFailure: true, timeout: 10000 });
  }

  tcpip(serial: string, port: number): Promise<string> {
    return this.run(['-s', serial, 'tcpip', String(port)], { timeout: 15000 });
  }

  async wifiAddress(serial: string): Promise<string | undefined> {
    const addr = await this.shell(serial, 'ip -o -4 addr show wlan0', { allowFailure: true });
    return parseWifiAddress(addr) ?? parseWifiAddress(await this.shell(serial, 'ip route', { allowFailure: true }));
  }

  /** Runs a command in the device shell. Paths inside `command` must be quoted with shellQuote. */
  shell(serial: string, command: string, options: RunOptions = {}): Promise<string> {
    return this.run(['-s', serial, 'shell', command], { timeout: 60000, ...options });
  }

  push(serial: string, locals: string[], remote: string, token?: vscode.CancellationToken): Promise<string> {
    return this.run(['-s', serial, 'push', ...locals, remote], { token });
  }

  pull(serial: string, remotes: string[], local: string, token?: vscode.CancellationToken): Promise<string> {
    return this.run(['-s', serial, 'pull', ...remotes, local], { token });
  }

  /** Command line that opens an interactive device shell, for a terminal. */
  shellArgs(serial: string, cwd?: string): string[] {
    return cwd ? ['-s', serial, 'shell', '-t', `cd ${shellQuote(cwd)} && exec sh`] : ['-s', serial, 'shell'];
  }
}
