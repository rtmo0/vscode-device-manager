/* Property lists as Apple's device services speak them: XML out, XML or binary (bplist00) in. */

export type PlistValue = string | number | bigint | boolean | Buffer | Date | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function encodeValue(value: PlistValue, out: string[]): void {
  if (typeof value === 'string') {
    out.push(`<string>${escapeXml(value)}</string>`);
  } else if (typeof value === 'boolean') {
    out.push(value ? '<true/>' : '<false/>');
  } else if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) {
    out.push(`<integer>${value}</integer>`);
  } else if (typeof value === 'number') {
    out.push(`<real>${value}</real>`);
  } else if (Buffer.isBuffer(value)) {
    out.push(`<data>${value.toString('base64')}</data>`);
  } else if (value instanceof Date) {
    out.push(`<date>${value.toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>`);
  } else if (Array.isArray(value)) {
    out.push('<array>');
    value.forEach((item) => encodeValue(item, out));
    out.push('</array>');
  } else {
    out.push('<dict>');
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        out.push(`<key>${escapeXml(key)}</key>`);
        encodeValue(item, out);
      }
    }
    out.push('</dict>');
  }
}

export function encodePlist(value: PlistValue): Buffer {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">'];
  encodeValue(value, out);
  out.push('</plist>\n');
  return Buffer.from(out.join(''), 'utf8');
}

export function decodePlist(data: Buffer): PlistValue {
  return data.subarray(0, 8).toString('latin1') === 'bplist00' ? decodeBinary(data) : decodeXml(data.toString('utf8'));
}

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, entity: string) => {
    switch (entity) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
    }
  });
}

function decodeXml(xml: string): PlistValue {
  // Tags with their text; comments, the XML declaration and the DOCTYPE are dropped.
  const tokens = [...xml.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g, '').matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>|([^<]+)/g)];
  let pos = 0;
  const next = () => tokens[pos++];

  const readText = (tag: string): string => {
    let text = '';
    for (let token = next(); token; token = next()) {
      if (token[4] !== undefined) {
        text += token[4];
      } else if (token[1] === '/' && token[2] === tag) {
        return unescapeXml(text);
      }
    }
    throw new Error(`Unterminated <${tag}> in plist`);
  };

  const readValue = (token: RegExpMatchArray): PlistValue => {
    const [, , tag, selfClosing] = token;
    switch (tag) {
      case 'dict': {
        const dict: PlistDict = {};
        if (selfClosing) {
          return dict;
        }
        for (let t = nextTag(); !(t[1] === '/' && t[2] === 'dict'); t = nextTag()) {
          if (t[2] !== 'key') {
            throw new Error(`Expected <key> in plist dict, got <${t[2]}>`);
          }
          const key = t[3] ? '' : readText('key');
          dict[key] = readValue(nextTag());
        }
        return dict;
      }
      case 'array': {
        const array: PlistValue[] = [];
        if (selfClosing) {
          return array;
        }
        for (let t = nextTag(); !(t[1] === '/' && t[2] === 'array'); t = nextTag()) {
          array.push(readValue(t));
        }
        return array;
      }
      case 'string':
        return selfClosing ? '' : readText('string');
      case 'integer': {
        const text = readText('integer').trim();
        const n = Number(text);
        return Number.isSafeInteger(n) ? n : BigInt(text);
      }
      case 'real':
        return Number(readText('real').trim());
      case 'true':
        return true;
      case 'false':
        return false;
      case 'data':
        return selfClosing ? Buffer.alloc(0) : Buffer.from(readText('data').replace(/\s+/g, ''), 'base64');
      case 'date':
        return new Date(readText('date').trim());
      default:
        throw new Error(`Unsupported plist element <${tag}>`);
    }
  };

  const nextTag = (): RegExpMatchArray => {
    for (let token = next(); token; token = next()) {
      if (token[2] !== undefined) {
        return token;
      }
    }
    throw new Error('Unexpected end of plist');
  };

  let root = nextTag();
  if (root[2] === 'plist') {
    root = nextTag();
  }
  return readValue(root);
}

const APPLE_EPOCH = Date.UTC(2001, 0, 1);

function decodeBinary(data: Buffer): PlistValue {
  const trailer = data.subarray(data.length - 32);
  const offsetSize = trailer[6];
  const refSize = trailer[7];
  const count = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const tableOffset = Number(trailer.readBigUInt64BE(24));

  const readUInt = (offset: number, size: number): number => {
    let value = 0;
    for (let i = 0; i < size; i++) {
      value = value * 256 + data[offset + i];
    }
    return value;
  };
  const offsets = Array.from({ length: count }, (_, i) => readUInt(tableOffset + i * offsetSize, offsetSize));

  const readObject = (ref: number, depth: number): PlistValue => {
    if (depth > 512) {
      throw new Error('Binary plist nests too deeply');
    }
    const offset = offsets[ref];
    const marker = data[offset];
    const type = marker >> 4;
    const info = marker & 0x0f;
    // Collections and strings store their length in the low nibble, or in a following integer when it is 0xF.
    const length = (): [number, number] => {
      if (info !== 0x0f) {
        return [info, offset + 1];
      }
      const size = 1 << (data[offset + 1] & 0x0f);
      return [readUInt(offset + 2, size), offset + 2 + size];
    };
    switch (type) {
      case 0x0:
        return info === 0x09;
      case 0x1: {
        const size = 1 << info;
        if (size === 8) {
          const value = data.readBigInt64BE(offset + 1);
          return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
        }
        return size === 16 ? data.readBigUInt64BE(offset + 9) : readUInt(offset + 1, size);
      }
      case 0x2:
        return info === 2 ? data.readFloatBE(offset + 1) : data.readDoubleBE(offset + 1);
      case 0x3:
        return new Date(APPLE_EPOCH + data.readDoubleBE(offset + 1) * 1000);
      case 0x4: {
        const [len, start] = length();
        return Buffer.from(data.subarray(start, start + len));
      }
      case 0x5: {
        const [len, start] = length();
        return data.subarray(start, start + len).toString('latin1');
      }
      case 0x6: {
        const [len, start] = length();
        const utf16 = Buffer.from(data.subarray(start, start + len * 2));
        return utf16.swap16().toString('utf16le');
      }
      case 0x8:
        return readUInt(offset + 1, info + 1);
      case 0xa: {
        const [len, start] = length();
        return Array.from({ length: len }, (_, i) => readObject(readUInt(start + i * refSize, refSize), depth + 1));
      }
      case 0xd: {
        const [len, start] = length();
        const dict: PlistDict = {};
        for (let i = 0; i < len; i++) {
          const key = readObject(readUInt(start + i * refSize, refSize), depth + 1);
          dict[String(key)] = readObject(readUInt(start + (len + i) * refSize, refSize), depth + 1);
        }
        return dict;
      }
      default:
        throw new Error(`Unsupported binary plist object 0x${marker.toString(16)}`);
    }
  };
  return readObject(top, 0);
}
