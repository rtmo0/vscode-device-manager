import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import * as vscode from 'vscode';
import type { DeviceInfo } from '../android/parse';
import { AfcClient, AfcError, AfcStatus } from './afc';
import { Lockdown, LockdownError, NotPairedError, withLockdown } from './lockdown';
import { PlistDict } from './plist';
import { PlistChannel } from './socket';
import { listMuxDevices, MuxDevice } from './usbmux';

export type IosState = 'ready' | 'unpaired' | 'locked' | 'error';

export interface IosDevice {
  udid: string;
  name?: string;
  productType?: string;
  version?: string;
  transport: 'usb' | 'wifi';
  state: IosState;
  error?: string;
  details?: DeviceInfo;
}

export interface IosApp {
  bundleId: string;
  name: string;
}

/** `media` is the AFC root (DCIM, Downloads…); an app domain is that app's Documents through house_arrest. */
export type AfcDomain = { kind: 'media' } | { kind: 'app'; bundleId: string };

const APPS_TTL = 30000;
const DETAILS_TTL = 60000;
const STAGING_DIR = '/PublicStaging';

function domainKey(udid: string, domain: AfcDomain): string {
  return domain.kind === 'media' ? `${udid}/media` : `${udid}/app/${domain.bundleId}`;
}

/** iOS devices seen by usbmuxd, with cached lockdown details and AFC connections. */
export class IosDevices implements vscode.Disposable {
  private readonly info = new Map<string, Pick<IosDevice, 'name' | 'productType' | 'version'>>();
  private readonly afcClients = new Map<string, Promise<AfcClient>>();
  private readonly apps = new Map<string, { at: number; apps: Promise<IosApp[]> }>();
  private readonly details = new Map<string, { at: number; info?: DeviceInfo }>();
  private mux = new Map<string, MuxDevice>();

  constructor(private readonly output: vscode.LogOutputChannel) {}

  dispose(): void {
    for (const client of this.afcClients.values()) {
      void client.then((c) => c.close(), () => undefined);
    }
    this.afcClients.clear();
  }

  /** Lists devices; a device connected by USB and Wi-Fi at once is shown once, through USB. */
  async list(): Promise<IosDevice[]> {
    const entries = await listMuxDevices();
    const byUdid = new Map<string, MuxDevice>();
    for (const entry of entries) {
      const known = byUdid.get(entry.udid);
      if (!known || (known.connection === 'Network' && entry.connection === 'USB')) {
        byUdid.set(entry.udid, entry);
      }
    }
    this.mux = byUdid;
    for (const key of [...this.afcClients.keys()]) {
      if (!byUdid.has(key.split('/')[0])) {
        void this.afcClients.get(key)?.then((c) => c.close(), () => undefined);
        this.afcClients.delete(key);
      }
    }
    return Promise.all([...byUdid.values()].map((entry) => this.describe(entry)));
  }

  private async describe(entry: MuxDevice): Promise<IosDevice> {
    const device: IosDevice = { udid: entry.udid, transport: entry.connection === 'USB' ? 'usb' : 'wifi', state: 'ready', ...this.info.get(entry.udid) };
    if (this.info.has(entry.udid)) {
      this.refreshDetails(entry);
      return { ...device, details: this.details.get(entry.udid)?.info };
    }
    try {
      const values = await withLockdown(entry, (lockdown) => lockdown.getValue());
      const dict = (values ?? {}) as PlistDict;
      const info = { name: dict.DeviceName as string, productType: dict.ProductType as string, version: dict.ProductVersion as string };
      this.info.set(entry.udid, info);
      return { ...device, ...info };
    } catch (error) {
      const state: IosState = error instanceof NotPairedError ? 'unpaired' : error instanceof LockdownError && error.code === 'PasswordProtected' ? 'locked' : 'error';
      if (state === 'error') {
        this.output.warn(`iOS ${entry.udid}: ${(error as Error).message}`);
      }
      return { ...device, state, error: (error as Error).message };
    }
  }

  /** Battery and storage, re-read in the background at most once a minute; the next poll shows them. */
  private refreshDetails(entry: MuxDevice): void {
    const cached = this.details.get(entry.udid);
    if (cached && Date.now() - cached.at < DETAILS_TTL) {
      return;
    }
    this.details.set(entry.udid, { at: Date.now(), info: cached?.info });
    withLockdown(entry, async (lockdown) => {
      const battery = ((await lockdown.getValue(undefined, 'com.apple.mobile.battery')) ?? {}) as PlistDict;
      const disk = ((await lockdown.getValue(undefined, 'com.apple.disk_usage')) ?? {}) as PlistDict;
      const info: DeviceInfo = { os: this.info.get(entry.udid)?.version && `iOS ${this.info.get(entry.udid)?.version}` };
      if (typeof battery.BatteryCurrentCapacity === 'number') {
        info.battery = battery.BatteryCurrentCapacity;
        info.charging = battery.BatteryIsCharging === true;
      }
      if (typeof disk.TotalDataCapacity === 'number') {
        info.storageTotal = disk.TotalDataCapacity;
        info.storageFree = (disk.TotalDataAvailable ?? disk.AmountDataAvailable) as number | undefined;
      }
      this.details.set(entry.udid, { at: Date.now(), info });
    }).catch((error) => this.output.debug(`iOS ${entry.udid} details: ${(error as Error).message}`));
  }

  private muxDevice(udid: string): MuxDevice {
    const device = this.mux.get(udid);
    if (!device) {
      throw vscode.FileSystemError.Unavailable(`The iOS device ${udid} is not connected.`);
    }
    return device;
  }

  /** A connected AFC client for the domain, reused until the connection drops. */
  afc(udid: string, domain: AfcDomain): Promise<AfcClient> {
    const key = domainKey(udid, domain);
    const cached = this.afcClients.get(key);
    if (cached) {
      return cached.then(
        (client) => (client.closed ? this.openAfc(key, udid, domain) : client),
        () => this.openAfc(key, udid, domain)
      );
    }
    return this.openAfc(key, udid, domain);
  }

  private openAfc(key: string, udid: string, domain: AfcDomain): Promise<AfcClient> {
    const client = withLockdown(this.muxDevice(udid), async (lockdown) => {
      if (domain.kind === 'media') {
        return new AfcClient((await lockdown.startService('com.apple.afc')).socket);
      }
      const channel = new PlistChannel((await lockdown.startService('com.apple.mobile.house_arrest')).socket);
      const response = await channel.request({ Command: 'VendDocuments', Identifier: domain.bundleId });
      if (response.Error) {
        channel.close();
        throw new Error(response.Error === 'ApplicationLookupFailed' ? `${domain.bundleId} is not installed or does not share files.` : `house_arrest: ${String(response.Error)}`);
      }
      // After the vend reply the same connection speaks AFC.
      return new AfcClient(channel.reader.detach());
    });
    this.afcClients.set(key, client);
    client.catch(() => this.afcClients.delete(key));
    return client;
  }

  /** Apps that share files with the computer (UIFileSharingEnabled), as listed in Finder → Files. */
  listApps(udid: string): Promise<IosApp[]> {
    const cached = this.apps.get(udid);
    if (cached && Date.now() - cached.at < APPS_TTL) {
      return cached.apps;
    }
    const apps = withLockdown(this.muxDevice(udid), (lockdown) => browseApps(lockdown));
    this.apps.set(udid, { at: Date.now(), apps });
    apps.catch(() => this.apps.delete(udid));
    return apps;
  }

  async appName(udid: string, bundleId: string): Promise<string | undefined> {
    return (await this.listApps(udid).catch(() => [])).find((a) => a.bundleId === bundleId)?.name;
  }

  /** Lets the device be reached over Wi-Fi, like "Show this iPhone when on Wi-Fi" in Finder. */
  async enableWifi(udid: string): Promise<void> {
    await withLockdown(this.muxDevice(udid), (lockdown) => lockdown.setValue('EnableWifiConnections', true, 'com.apple.mobile.wireless_lockdown'));
  }

  forget(udid: string): void {
    this.info.delete(udid);
    this.apps.delete(udid);
    this.details.delete(udid);
  }

  /**
   * Installs an .ipa the way Finder and Xcode do: upload to PublicStaging over AFC, then installation_proxy.
   * The package must be signed for this device (development, ad hoc or enterprise).
   */
  async installIpa(udid: string, ipa: Uint8Array, onProgress: (percent: number, status: string) => void): Promise<void> {
    const staged = `${STAGING_DIR}/mobile-device-manager-${randomUUID()}.ipa`;
    await withLockdown(this.muxDevice(udid), async (lockdown) => {
      const afc = new AfcClient((await lockdown.startService('com.apple.afc')).socket);
      try {
        await afc.mkdir(STAGING_DIR).catch((error) => {
          if (!(error instanceof AfcError && error.status === AfcStatus.ObjectExists)) {
            throw error;
          }
        });
        onProgress(0, 'Uploading');
        await afc.writeFile(staged, ipa);
        const channel = new PlistChannel((await lockdown.startService('com.apple.mobile.installation_proxy')).socket);
        try {
          channel.send({ Command: 'Install', PackagePath: staged, ClientOptions: {} });
          for (;;) {
            const response = await channel.receive();
            if (response.Error) {
              throw new Error(`${String(response.Error)}${response.ErrorDescription ? `: ${String(response.ErrorDescription)}` : ''}`);
            }
            if (typeof response.PercentComplete === 'number') {
              onProgress(response.PercentComplete, String(response.Status ?? 'Installing'));
            }
            if (response.Status === 'Complete') {
              break;
            }
            if (!Object.keys(response).length) {
              throw new Error('The device closed the installation without finishing it.');
            }
          }
        } finally {
          channel.close();
        }
      } finally {
        await afc.remove(staged).catch(() => undefined);
        afc.close();
      }
    });
    this.apps.delete(udid);
  }

  /** The raw syslog stream (com.apple.syslog_relay): lines end with "\n\0". The caller closes the socket. */
  openSyslog(udid: string): Promise<Socket> {
    return withLockdown(this.muxDevice(udid), async (lockdown) => (await lockdown.startService('com.apple.syslog_relay')).socket);
  }
}

async function browseApps(lockdown: Lockdown): Promise<IosApp[]> {
  const channel = new PlistChannel((await lockdown.startService('com.apple.mobile.installation_proxy')).socket);
  try {
    channel.send({
      Command: 'Browse',
      ClientOptions: { ApplicationType: 'User', ReturnAttributes: ['CFBundleIdentifier', 'CFBundleDisplayName', 'CFBundleName', 'UIFileSharingEnabled'] }
    });
    const apps: IosApp[] = [];
    for (;;) {
      const response = await channel.receive();
      if (response.Error) {
        throw new Error(`installation_proxy: ${String(response.Error)}`);
      }
      for (const app of (response.CurrentList ?? []) as PlistDict[]) {
        if (app.UIFileSharingEnabled === true) {
          const bundleId = app.CFBundleIdentifier as string;
          apps.push({ bundleId, name: (app.CFBundleDisplayName ?? app.CFBundleName ?? bundleId) as string });
        }
      }
      if (response.Status === 'Complete' || !Object.keys(response).length) {
        break;
      }
    }
    return apps.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    channel.close();
  }
}
