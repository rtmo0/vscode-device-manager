import { Socket } from 'node:net';
import { StreamReader } from './socket';

/* Apple File Conduit: the file protocol of com.apple.afc (media) and house_arrest (app documents). */

const MAGIC = Buffer.from('CFA6LPAA', 'latin1');
export const AFC_HEADER_SIZE = 40;
const CHUNK_SIZE = 4 * 1024 * 1024;
const OPERATION_TIMEOUT = 60000;

export enum AfcOp {
  Status = 0x01,
  Data = 0x02,
  ReadDir = 0x03,
  RemovePath = 0x08,
  MakeDir = 0x09,
  GetFileInfo = 0x0a,
  GetDeviceInfo = 0x0b,
  FileOpen = 0x0d,
  FileOpenResult = 0x0e,
  FileRead = 0x0f,
  FileWrite = 0x10,
  FileClose = 0x14,
  RenamePath = 0x18,
  RemovePathAndContents = 0x22
}

export enum AfcMode {
  ReadOnly = 1,
  /** O_WRONLY | O_CREAT | O_TRUNC */
  WriteTruncate = 3
}

export const AfcStatus = {
  Success: 0,
  ReadError: 4,
  UnknownPacketType: 6,
  ObjectNotFound: 8,
  ObjectIsDir: 9,
  PermDenied: 10,
  OpNotSupported: 15,
  ObjectExists: 16,
  NoSpaceLeft: 18,
  DirNotEmpty: 33
} as const;

const STATUS_NAMES: Record<number, string> = {
  1: 'unknown error',
  2: 'invalid header',
  3: 'no resources',
  4: 'read error',
  5: 'write error',
  6: 'unknown packet type',
  7: 'invalid argument',
  8: 'no such file or directory',
  9: 'is a directory',
  10: 'permission denied',
  11: 'service not connected',
  12: 'timeout',
  13: 'too much data',
  14: 'end of data',
  15: 'not supported',
  16: 'already exists',
  17: 'busy',
  18: 'no space left on the device',
  19: 'would block',
  20: 'I/O error',
  21: 'interrupted',
  22: 'in progress',
  23: 'internal error',
  30: 'mux error',
  31: 'out of memory',
  32: 'not enough data',
  33: 'directory not empty'
};

export class AfcError extends Error {
  constructor(
    readonly status: number,
    readonly path?: string
  ) {
    super(`${path ? `${path}: ` : ''}${STATUS_NAMES[status] ?? `AFC error ${status}`}`);
  }
}

export interface AfcPacket {
  op: number;
  packet: number;
  /** Everything after the header. */
  data: Buffer;
}

/** `headerData` goes into this_length; `payload` follows it (only file writes use a payload). */
export function encodePacket(op: number, packet: number, headerData: Buffer, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(AFC_HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeBigUInt64LE(BigInt(AFC_HEADER_SIZE + headerData.length + payload.length), 8);
  header.writeBigUInt64LE(BigInt(AFC_HEADER_SIZE + headerData.length), 16);
  header.writeBigUInt64LE(BigInt(packet), 24);
  header.writeBigUInt64LE(BigInt(op), 32);
  return Buffer.concat([header, headerData, payload]);
}

export function decodeHeader(header: Buffer): { length: number; packet: number; op: number } {
  if (!header.subarray(0, 8).equals(MAGIC)) {
    throw new Error('Invalid AFC packet from the device');
  }
  return { length: Number(header.readBigUInt64LE(8)), packet: Number(header.readBigUInt64LE(24)), op: Number(header.readBigUInt64LE(32)) };
}

export function cString(...values: string[]): Buffer {
  return Buffer.concat(values.map((v) => Buffer.from(`${v}\0`, 'utf8')));
}

/** NUL-separated strings, as READ_DIR returns. */
export function parseStrings(data: Buffer): string[] {
  const text = data.toString('utf8');
  const parts = text.split('\0');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

/** NUL-separated key/value pairs, as GET_FILE_INFO and GET_DEVINFO return. */
export function parseKeyValues(data: Buffer): Record<string, string> {
  const parts = parseStrings(data);
  const result: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    result[parts[i]] = parts[i + 1];
  }
  return result;
}

export interface AfcStat {
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
  ctime: number;
}

export function parseFileInfo(info: Record<string, string>): AfcStat {
  const type = info.st_ifmt === 'S_IFDIR' ? 'directory' : info.st_ifmt === 'S_IFREG' ? 'file' : info.st_ifmt === 'S_IFLNK' ? 'symlink' : 'other';
  // Times are nanoseconds; Number keeps millisecond precision for any realistic date.
  const ms = (ns?: string) => (ns ? Number(BigInt(ns) / 1000000n) : 0);
  return { type, size: Number(info.st_size ?? 0), mtime: ms(info.st_mtime), ctime: ms(info.st_birthtime ?? info.st_mtime) };
}

/**
 * AFC client. Requests are pipelined: each carries a packet number and the device answers them in order,
 * so listing a folder of thousands of photos does not pay one round trip per file.
 */
export class AfcClient {
  private nextPacket = 0;
  private readonly pending = new Map<number, { resolve: (p: AfcPacket) => void; reject: (e: Error) => void }>();
  private readonly reader: StreamReader;
  private failure: Error | undefined;

  constructor(private readonly socket: Socket) {
    this.reader = new StreamReader(socket);
    void this.readLoop();
  }

  get closed(): boolean {
    return this.failure !== undefined || this.reader.closed;
  }

  close(): void {
    this.socket.destroy();
  }

  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        const header = decodeHeader(await this.reader.read(AFC_HEADER_SIZE));
        const data = header.length > AFC_HEADER_SIZE ? await this.reader.read(header.length - AFC_HEADER_SIZE) : Buffer.alloc(0);
        const waiter = this.pending.get(header.packet);
        this.pending.delete(header.packet);
        waiter?.resolve({ op: header.op, packet: header.packet, data });
      }
    } catch (error) {
      this.failure = error as Error;
      for (const waiter of this.pending.values()) {
        waiter.reject(this.failure);
      }
      this.pending.clear();
    }
  }

  /** Sends one request and returns the data of the reply; a STATUS reply other than success throws. */
  async operation(op: AfcOp, headerData: Buffer, path?: string, payload?: Buffer): Promise<AfcPacket> {
    if (this.failure) {
      throw this.failure;
    }
    const packet = this.nextPacket++;
    const reply = new Promise<AfcPacket>((resolve, reject) => this.pending.set(packet, { resolve, reject }));
    // A Wi-Fi connection can die without a reset; drop it so the next request reconnects.
    const timer = setTimeout(() => this.socket.destroy(new Error('The device stopped responding.')), OPERATION_TIMEOUT);
    this.socket.write(encodePacket(op, packet, headerData, payload));
    const result = await reply.finally(() => clearTimeout(timer));
    if (result.op === AfcOp.Status) {
      const status = Number(result.data.readBigUInt64LE(0));
      if (status !== AfcStatus.Success) {
        throw new AfcError(status, path);
      }
    }
    return result;
  }

  async readDir(path: string): Promise<string[]> {
    const reply = await this.operation(AfcOp.ReadDir, cString(path), path);
    return parseStrings(reply.data).filter((name) => name !== '.' && name !== '..');
  }

  async stat(path: string): Promise<AfcStat> {
    try {
      return parseFileInfo(parseKeyValues((await this.operation(AfcOp.GetFileInfo, cString(path), path)).data));
    } catch (error) {
      // GET_FILE_INFO reports a missing path as a read error.
      if (error instanceof AfcError && error.status === AfcStatus.ReadError) {
        throw new AfcError(AfcStatus.ObjectNotFound, path);
      }
      throw error;
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.operation(AfcOp.MakeDir, cString(path), path);
  }

  async remove(path: string): Promise<void> {
    await this.operation(AfcOp.RemovePath, cString(path), path);
  }

  async removeAll(path: string): Promise<void> {
    try {
      await this.operation(AfcOp.RemovePathAndContents, cString(path), path);
    } catch (error) {
      // Very old devices lack REMOVE_PATH_AND_CONTENTS; walk the tree instead.
      if (!(error instanceof AfcError) || (error.status !== AfcStatus.UnknownPacketType && error.status !== AfcStatus.OpNotSupported)) {
        throw error;
      }
      if ((await this.stat(path)).type === 'directory') {
        for (const name of await this.readDir(path)) {
          await this.removeAll(`${path}/${name}`);
        }
      }
      await this.remove(path);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.operation(AfcOp.RenamePath, cString(from, to), from);
  }

  private async open(path: string, mode: AfcMode): Promise<Buffer> {
    const header = Buffer.alloc(8);
    header.writeBigUInt64LE(BigInt(mode));
    const reply = await this.operation(AfcOp.FileOpen, Buffer.concat([header, cString(path)]), path);
    return reply.data.subarray(0, 8);
  }

  private async closeHandle(handle: Buffer): Promise<void> {
    await this.operation(AfcOp.FileClose, handle);
  }

  async readFile(path: string): Promise<Buffer> {
    const handle = await this.open(path, AfcMode.ReadOnly);
    try {
      const chunks: Buffer[] = [];
      for (;;) {
        const size = Buffer.alloc(8);
        size.writeBigUInt64LE(BigInt(CHUNK_SIZE));
        const reply = await this.operation(AfcOp.FileRead, Buffer.concat([handle, size]), path);
        if (reply.op === AfcOp.Status || reply.data.length === 0) {
          break;
        }
        chunks.push(reply.data);
        if (reply.data.length < CHUNK_SIZE) {
          break;
        }
      }
      return Buffer.concat(chunks);
    } finally {
      await this.closeHandle(handle).catch(() => undefined);
    }
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const handle = await this.open(path, AfcMode.WriteTruncate);
    try {
      const data = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
      for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
        await this.operation(AfcOp.FileWrite, handle, path, data.subarray(offset, offset + CHUNK_SIZE));
      }
    } finally {
      await this.closeHandle(handle);
    }
  }
}
