import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  /** Unix permission bits when the archive was made on a Unix system. */
  mode: number | undefined;
  isDirectory: boolean;
  read(): Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Reads a (non-Zip64) zip archive held in memory. Entries with absolute or `..` paths are rejected. */
export function readZip(data: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Not a zip archive');
  }
  const count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('Corrupt zip central directory');
    }
    const madeBy = data.readUInt16LE(offset + 4) >> 8;
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const external = data.readUInt32LE(offset + 38);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split(/[\\/]/).includes('..')) {
      throw new Error(`Unsafe path in zip archive: ${name}`);
    }
    const unixMode = madeBy === 3 ? (external >>> 16) & 0o7777 : undefined;
    entries.push({
      name,
      mode: unixMode || undefined,
      isDirectory: name.endsWith('/'),
      read: () => {
        if (data.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
          throw new Error(`Corrupt zip entry: ${name}`);
        }
        const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
        const raw = data.subarray(start, start + compressedSize);
        if (method === 0) {
          return Buffer.from(raw);
        }
        if (method === 8) {
          return inflateRawSync(raw);
        }
        throw new Error(`Unsupported zip compression ${method}: ${name}`);
      }
    });
  }
  return entries;
}
