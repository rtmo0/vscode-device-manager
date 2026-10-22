import { Socket } from 'node:net';
import { PlistDict, PlistValue } from './plist';
import { PairRecord, PlistChannel, startTls } from './socket';
import { connectToDevice, MuxDevice, readPairRecord } from './usbmux';

const LOCKDOWN_PORT = 62078;
const LABEL = 'mobile-device-manager';

export class LockdownError extends Error {
  constructor(
    readonly request: string,
    readonly code: string
  ) {
    super(LockdownError.describe(request, code));
  }

  private static describe(request: string, code: string): string {
    switch (code) {
      case 'PasswordProtected':
        return 'The device is locked. Unlock it and try again.';
      case 'InvalidHostID':
      case 'InvalidPairRecord':
        return 'This computer is no longer trusted by the device. Connect it by USB, unlock it and tap Trust.';
      case 'UserDeniedPairing':
        return 'Trust was denied on the device.';
      default:
        return `${request} failed: ${code}`;
    }
  }
}

export class NotPairedError extends Error {
  constructor() {
    super('This computer is not trusted by the device yet. Connect it by USB, unlock it and tap Trust (open Finder on macOS or Apple Devices on Windows if the dialog does not appear).');
  }
}

export interface ServiceConnection {
  socket: Socket;
  record: PairRecord;
}

/** A lockdownd session: device values and the doorway to every other service. */
export class Lockdown {
  private constructor(
    private channel: PlistChannel,
    private readonly device: MuxDevice,
    readonly record: PairRecord
  ) {}

  static async open(device: MuxDevice): Promise<Lockdown> {
    const record = await readPairRecord(device.udid);
    if (!record) {
      throw new NotPairedError();
    }
    const lockdown = new Lockdown(new PlistChannel(await connectToDevice(device.deviceId, LOCKDOWN_PORT)), device, record);
    try {
      await lockdown.startSession();
    } catch (error) {
      lockdown.close();
      throw error;
    }
    return lockdown;
  }

  close(): void {
    this.channel.close();
  }

  private async request(request: string, fields: PlistDict = {}): Promise<PlistDict> {
    const response = await this.channel.request({ Label: LABEL, Request: request, ...fields });
    if (typeof response.Error === 'string') {
      throw new LockdownError(request, response.Error);
    }
    return response;
  }

  private async startSession(): Promise<void> {
    const response = await this.request('StartSession', { HostID: this.record.HostID, SystemBUID: this.record.SystemBUID });
    if (response.EnableSessionSSL) {
      const socket = this.channel.reader.detach();
      this.channel = new PlistChannel(await startTls(socket, this.record));
    }
  }

  async getValue(key?: string, domain?: string): Promise<PlistValue | undefined> {
    const fields: PlistDict = {};
    if (key) {
      fields.Key = key;
    }
    if (domain) {
      fields.Domain = domain;
    }
    return (await this.request('GetValue', fields)).Value;
  }

  async setValue(key: string, value: PlistValue, domain?: string): Promise<void> {
    await this.request('SetValue', domain ? { Key: key, Value: value, Domain: domain } : { Key: key, Value: value });
  }

  /** Starts a service and opens a connection to it, in TLS when the service asks for it. */
  async startService(name: string): Promise<ServiceConnection> {
    const response = await this.request('StartService', { Service: name });
    const socket = await connectToDevice(this.device.deviceId, response.Port as number);
    return { socket: response.EnableServiceSSL ? await startTls(socket, this.record) : socket, record: this.record };
  }
}

/** Opens a session, runs `action` and closes the session. */
export async function withLockdown<T>(device: MuxDevice, action: (lockdown: Lockdown) => Promise<T>): Promise<T> {
  const lockdown = await Lockdown.open(device);
  try {
    return await action(lockdown);
  } finally {
    lockdown.close();
  }
}
