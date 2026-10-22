/* Pure parsers for adb output. Covered by test/parse.test.ts. */

export type DeviceState = 'device' | 'offline' | 'unauthorized' | 'authorizing' | 'connecting' | 'no permissions' | 'unknown';
export type Transport = 'wifi' | 'usb' | 'emulator';

export interface AndroidDevice {
  serial: string;
  state: DeviceState;
  transport: Transport;
  model?: string;
  product?: string;
}

export interface MdnsService {
  name: string;
  kind: 'connect' | 'pairing';
  address: string;
}

export interface StatEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: number;
}

const STATES: readonly string[] = ['device', 'offline', 'unauthorized', 'authorizing', 'connecting', 'no permissions'];

/** Wireless serials are `host:port` or the mDNS service name `adb-<id>._adb-tls-connect._tcp`. */
export function transportOf(serial: string): Transport {
  if (/^emulator-\d+$/.test(serial)) {
    return 'emulator';
  }
  if (/._adb-tls-connect._tcp\.?$/.test(serial) || /^[\w.-]+:\d+$/.test(serial) || /^\[[0-9a-f:]+\]:\d+$/i.test(serial)) {
    return 'wifi';
  }
  return 'usb';
}

/** Parses `adb devices -l`. */
export function parseDevices(output: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('*') || line.startsWith('List of devices')) {
      continue;
    }
    const match = /^(\S+)\s+(no permissions|\S+)(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, serial, rawState, rest] = match;
    const props = new Map([...rest.matchAll(/(\w+):(\S+)/g)].map((m) => [m[1], m[2]]));
    devices.push({
      serial,
      state: (STATES.includes(rawState) ? rawState : 'unknown') as DeviceState,
      transport: transportOf(serial),
      model: props.get('model')?.replace(/_/g, ' '),
      product: props.get('product')
    });
  }
  return devices;
}

/** Parses `adb mdns services`. */
export function parseMdnsServices(output: string): MdnsService[] {
  const services: MdnsService[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+_adb-tls-(connect|pairing)\._tcp\.?\s+(\S+)\s*$/.exec(line);
    if (match) {
      services.push({ name: match[1], kind: match[2] as MdnsService['kind'], address: match[3] });
    }
  }
  return services;
}

/** `adb connect` exits 0 on some failures, so success is decided from its output. */
export function parseConnectResult(output: string): { ok: boolean; message: string } {
  const message = output.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  return { ok: /^(connected|already connected) to /m.test(output), message };
}

export function parsePairResult(output: string): { ok: boolean; guid?: string; message: string } {
  const message = output.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  const match = /Successfully paired to \S+(?: \[guid=([^\]]+)\])?/.exec(output);
  return { ok: !!match, guid: match?.[1], message };
}

/** Reads the IPv4 address from `ip -o -4 addr show wlan0` or `ip route`. */
export function parseWifiAddress(output: string): string | undefined {
  return /\binet (\d+\.\d+\.\d+\.\d+)\//.exec(output)?.[1] ?? /\bsrc (\d+\.\d+\.\d+\.\d+)/.exec(output)?.[1];
}

function typeOfMode(mode: number): StatEntry['type'] {
  switch (mode & 0o170000) {
    case 0o040000:
      return 'directory';
    case 0o100000:
      return 'file';
    case 0o120000:
      return 'symlink';
    default:
      return 'other';
  }
}

/** Format string for toybox `stat -c`, parsed by parseStat. The name goes last because it may contain `|`. */
export const STAT_FORMAT = '%f|%s|%Y|%n';

/** Parses lines of `stat -L -c '%f|%s|%Y|%n'`, skipping `.` and `..`. */
export function parseStat(output: string): StatEntry[] {
  const entries: StatEntry[] = [];
  for (const line of output.split('\n')) {
    const match = /^([0-9a-f]+)\|(\d+)\|(\d+)\|(.+)$/.exec(line);
    if (!match || match[4] === '.' || match[4] === '..') {
      continue;
    }
    entries.push({ type: typeOfMode(parseInt(match[1], 16)), size: Number(match[2]), mtime: Number(match[3]) * 1000, name: match[4] });
  }
  return entries;
}

/** Quotes an argument for the device shell (mksh / toybox sh). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

export function dirname(path: string): string {
  const index = path.replace(/\/+$/, '').lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || '/';
}

export interface DeviceInfo {
  os?: string;
  manufacturer?: string;
  /** Percent. */
  battery?: number;
  charging?: boolean;
  /** Bytes. */
  storageTotal?: number;
  storageFree?: number;
}

/** One round trip for version, battery and free space; parsed by parseAndroidInfo. */
export const ANDROID_INFO_COMMAND =
  'echo "release=$(getprop ro.build.version.release)"; echo "manufacturer=$(getprop ro.product.manufacturer)"; dumpsys battery 2>/dev/null; df -k /data 2>/dev/null | tail -n 1';

export function parseAndroidInfo(output: string): DeviceInfo {
  const info: DeviceInfo = {};
  const release = /^release=(.+)$/m.exec(output)?.[1]?.trim();
  if (release) {
    info.os = `Android ${release}`;
  }
  info.manufacturer = /^manufacturer=(.+)$/m.exec(output)?.[1]?.trim() || undefined;
  const level = /^\s*level: (\d+)/m.exec(output);
  if (level) {
    info.battery = Number(level[1]);
    // BatteryManager: 2 = charging, 5 = full while plugged in.
    const status = Number(/^\s*status: (\d+)/m.exec(output)?.[1]);
    info.charging = status === 2 || /^\s*(AC|USB|Wireless) powered: true/m.test(output);
  }
  const df = /^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+\/data\s*$/m.exec(output);
  if (df) {
    info.storageTotal = Number(df[1]) * 1024;
    info.storageFree = Number(df[3]) * 1024;
  }
  return info;
}
