import { Socket } from 'node:net';
import { decodePlist, encodePlist, PlistDict } from './plist';
import { connectUsbmuxd, PairRecord, StreamReader } from './socket';

const VERSION_PLIST = 1;
const MESSAGE_PLIST = 8;
const HEADER_SIZE = 16;

export interface MuxDevice {
  deviceId: number;
  udid: string;
  connection: 'USB' | 'Network';
}

const RESULT_MESSAGES: Record<number, string> = {
  1: 'usbmuxd rejected the request',
  2: 'The device is not available',
  3: 'The device refused the connection',
  6: 'usbmuxd does not support this request'
};

export class UsbmuxError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** One request/response conversation with usbmuxd (built into macOS; Apple Devices on Windows; usbmuxd on Linux). */
export class Usbmux {
  private tag = 1;
  private readonly reader: StreamReader;

  private constructor(private readonly socket: Socket) {
    this.reader = new StreamReader(socket);
  }

  static async open(): Promise<Usbmux> {
    return new Usbmux(await connectUsbmuxd());
  }

  close(): void {
    this.socket.destroy();
  }

  private async request(message: PlistDict): Promise<PlistDict> {
    const body = encodePlist({ ClientVersionString: 'mobile-device-manager', ProgName: 'mobile-device-manager', kLibUSBMuxVersion: 3, ...message });
    const tag = this.tag++;
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(HEADER_SIZE + body.length, 0);
    header.writeUInt32LE(VERSION_PLIST, 4);
    header.writeUInt32LE(MESSAGE_PLIST, 8);
    header.writeUInt32LE(tag, 12);
    this.socket.write(Buffer.concat([header, body]));
    for (;;) {
      const head = await this.reader.read(HEADER_SIZE);
      const payload = await this.reader.read(head.readUInt32LE(0) - HEADER_SIZE);
      // Device attach notifications carry tag 0; only a Listen connection receives them.
      if (head.readUInt32LE(12) === tag) {
        return decodePlist(payload) as PlistDict;
      }
    }
  }

  private async command(message: PlistDict): Promise<void> {
    const response = await this.request(message);
    const code = response.Number as number;
    if (response.MessageType !== 'Result' || code !== 0) {
      throw new UsbmuxError(`${RESULT_MESSAGES[code] ?? 'usbmuxd error'} (${message.MessageType}, code ${code})`, code);
    }
  }

  async listDevices(): Promise<MuxDevice[]> {
    const response = await this.request({ MessageType: 'ListDevices' });
    const list = (response.DeviceList ?? []) as PlistDict[];
    return list.map((item) => {
      const props = item.Properties as PlistDict;
      return { deviceId: item.DeviceID as number, udid: props.SerialNumber as string, connection: props.ConnectionType === 'Network' ? 'Network' : 'USB' };
    });
  }

  /** The pairing usbmuxd keeps for this computer; created by Finder / Apple Devices when the user taps Trust. */
  async readPairRecord(udid: string): Promise<PairRecord | undefined> {
    const response = await this.request({ MessageType: 'ReadPairRecord', PairRecordID: udid });
    const data = response.PairRecordData;
    return Buffer.isBuffer(data) ? (decodePlist(data) as unknown as PairRecord) : undefined;
  }

  /** Turns this connection into a raw tunnel to a TCP port on the device. */
  async connect(deviceId: number, port: number): Promise<Socket> {
    // usbmuxd expects the port in network byte order.
    const swapped = ((port & 0xff) << 8) | ((port >> 8) & 0xff);
    await this.command({ MessageType: 'Connect', DeviceID: deviceId, PortNumber: swapped });
    return this.reader.detach();
  }
}

export async function listMuxDevices(): Promise<MuxDevice[]> {
  const mux = await Usbmux.open();
  try {
    return await mux.listDevices();
  } finally {
    mux.close();
  }
}

export async function readPairRecord(udid: string): Promise<PairRecord | undefined> {
  const mux = await Usbmux.open();
  try {
    return await mux.readPairRecord(udid);
  } finally {
    mux.close();
  }
}

export async function connectToDevice(deviceId: number, port: number): Promise<Socket> {
  const mux = await Usbmux.open();
  try {
    return await mux.connect(deviceId, port);
  } catch (error) {
    mux.close();
    throw error;
  }
}
