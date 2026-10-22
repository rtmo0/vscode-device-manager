import { connect as netConnect, Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket } from 'node:tls';
import { decodePlist, encodePlist, PlistDict } from './plist';

export class ConnectionClosedError extends Error {
  constructor() {
    super('The connection to the device was closed.');
  }
}

/** Buffers a socket's data so protocol code can await exact byte counts. */
export class StreamReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private waiter: { size: number; resolve: (data: Buffer) => void; reject: (error: Error) => void } | undefined;
  private error: Error | undefined;
  private readonly onData = (chunk: Buffer) => {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.flush();
  };
  private readonly onEnd = (error?: Error) => {
    this.error ??= error instanceof Error ? error : new ConnectionClosedError();
    this.waiter?.reject(this.error);
    this.waiter = undefined;
  };

  constructor(readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.on('error', this.onEnd);
    socket.on('close', () => this.onEnd());
  }

  get closed(): boolean {
    return this.error !== undefined;
  }

  read(size: number): Promise<Buffer> {
    if (this.waiter) {
      return Promise.reject(new Error('Concurrent reads on one device connection'));
    }
    return new Promise((resolve, reject) => {
      this.waiter = { size, resolve, reject };
      this.flush();
      if (this.waiter && this.error) {
        this.waiter = undefined;
        reject(this.error);
      }
    });
  }

  private flush(): void {
    if (!this.waiter || this.buffered < this.waiter.size) {
      return;
    }
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const { size, resolve } = this.waiter;
    this.waiter = undefined;
    const rest = all.subarray(size);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    resolve(all.subarray(0, size));
  }

  /** Stops reading so the socket can be handed over, e.g. to TLS. Nothing must be buffered at this point. */
  detach(): Socket {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onEnd);
    if (this.buffered) {
      throw new Error('Unexpected data from the device before the protocol switch');
    }
    return this.socket;
  }
}

export function connectUsbmuxd(): Promise<Socket> {
  const address = process.env.USBMUXD_SOCKET_ADDRESS;
  return new Promise((resolve, reject) => {
    let socket: Socket;
    if (address?.includes(':') && !address.startsWith('/')) {
      const [host, port] = [address.slice(0, address.lastIndexOf(':')), Number(address.slice(address.lastIndexOf(':') + 1))];
      socket = netConnect({ host, port });
    } else if (process.platform === 'win32') {
      // Apple Mobile Device Service (Apple Devices app or iTunes) listens on this port.
      socket = netConnect({ host: '127.0.0.1', port: 27015 });
    } else {
      socket = netConnect({ path: address || '/var/run/usbmuxd' });
    }
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

export interface PairRecord {
  HostCertificate: Buffer;
  HostPrivateKey: Buffer;
  HostID: string;
  SystemBUID: string;
  EscrowBag?: Buffer;
}

/** Wraps a device connection in TLS with the host certificate from the pair record. Devices use self-signed certificates. */
export function startTls(socket: Socket, record: PairRecord): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({
      socket,
      cert: record.HostCertificate,
      key: record.HostPrivateKey,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      // Pair records of older devices carry SHA-1 certificates and 1024-bit keys.
      ciphers: 'ALL:!aNULL:!eNULL:@SECLEVEL=0'
    });
    tls.once('secureConnect', () => {
      tls.off('error', reject);
      resolve(tls);
    });
    tls.once('error', reject);
  });
}

/** Services that exchange plists framed by a 32-bit big-endian length (lockdownd, house_arrest, installation_proxy). */
export class PlistChannel {
  readonly reader: StreamReader;

  constructor(readonly socket: Socket) {
    this.reader = new StreamReader(socket);
  }

  send(message: PlistDict): void {
    const body = encodePlist(message);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  async receive(): Promise<PlistDict> {
    const size = (await this.reader.read(4)).readUInt32BE(0);
    return decodePlist(await this.reader.read(size)) as PlistDict;
  }

  async request(message: PlistDict): Promise<PlistDict> {
    this.send(message);
    return this.receive();
  }

  close(): void {
    this.socket.destroy();
  }
}
