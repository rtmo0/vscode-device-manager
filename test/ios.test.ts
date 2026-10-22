import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AFC_HEADER_SIZE, AfcOp, cString, decodeHeader, encodePacket, parseFileInfo, parseKeyValues, parseStrings } from '../src/ios/afc';
import { resolveIosPath } from '../src/ios/paths';
import { decodePlist, encodePlist } from '../src/ios/plist';
import { readZip } from '../src/unzip';

// plistlib.dumps(..., fmt=FMT_BINARY) from Python, so the parser is checked against Apple's format, not against itself.
const BINARY_PLIST =
  'YnBsaXN0MDDcAQIDBAUGBwgJCgsMDQ4PEBESGBkaGxwdU0JpZ1VDb3VudFREYXRhWkRldmljZU5hbWVVRW1wdHlUTGlzdFNOZWdSTm9ST2teUHJvZHVjdFZlcnNpb25VUmF0aW9UV2hlbhMAAAEAAAAAABAqQwAB/28QDwQQBD0ENARABDUEOSAZAHMAIABpAFAAaABvAG4AZdCjExQVEAFTdHdv0RYXUWtRdhP/////////+wgJVDE4LjEjP/gAAAAAAAAzQcWh2lKAAAAIISUrMDtBRkpNUF9lanN1eZqbn6GlqKqstba3vMUAAAAAAAABAQAAAAAAAAAeAAAAAAAAAAAAAAAAAAAAzg==';

// zipfile from Python: platform-tools/adb deflated with mode 0755, NOTICE.txt stored without Unix attributes.
const ZIP =
  'UEsDBBQAAAAIAAAAIQAezv7SGgAAAHwBAAASAAAAcGxhdGZvcm0tdG9vbHMvYWRiU1bUT8rM0y/O4EpNzshXSExJ4lIeFaKPEABQSwMEFAAAAAAAAAAhAMJFDUgGAAAABgAAABkAAABwbGF0Zm9ybS10b29scy9OT1RJQ0UudHh0bm90aWNlUEsBAhQDFAAAAAgAAAAhAB7O/tIaAAAAfAEAABIAAAAAAAAAAAAAAO2BAAAAAHBsYXRmb3JtLXRvb2xzL2FkYlBLAQIUABQAAAAAAAAAIQDCRQ1IBgAAAAYAAAAZAAAAAAAAAAAAAACAAUoAAABwbGF0Zm9ybS10b29scy9OT1RJQ0UudHh0UEsFBgAAAAACAAIAhwAAAIcAAAAAAA==';

test('XML plists round-trip every value type', () => {
  const value = {
    MessageType: 'Connect',
    DeviceID: 3,
    PortNumber: 32498,
    Big: 2n ** 60n,
    Ratio: 0.25,
    Flag: true,
    Off: false,
    Data: Buffer.from([0, 1, 2, 255]),
    Text: 'a < b & "c" — Андрей',
    List: ['x', 1, { nested: [] }],
    Empty: {},
    When: new Date('2024-05-06T07:08:09Z')
  };
  assert.deepEqual(decodePlist(encodePlist(value)), value);
});

test('XML plists from devices parse with whitespace, entities and empty elements', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>DeviceList</key>
\t<array>
\t\t<dict>
\t\t\t<key>DeviceID</key>
\t\t\t<integer>12</integer>
\t\t\t<key>Properties</key>
\t\t\t<dict>
\t\t\t\t<key>ConnectionType</key>
\t\t\t\t<string>Network</string>
\t\t\t\t<key>SerialNumber</key>
\t\t\t\t<string>00008110-001A2D3C0E91801E</string>
\t\t\t\t<key>EscapedFullServiceName</key>
\t\t\t\t<string>a&amp;b&#64;c</string>
\t\t\t\t<key>NetworkAddress</key>
\t\t\t\t<data>
\t\t\t\tEAIAAMCoAQ8AAAAAAAAAAA==
\t\t\t\t</data>
\t\t\t\t<key>Empty</key>
\t\t\t\t<string/>
\t\t\t</dict>
\t\t</dict>
\t</array>
</dict>
</plist>`;
  assert.deepEqual(decodePlist(Buffer.from(xml)), {
    DeviceList: [
      {
        DeviceID: 12,
        Properties: {
          ConnectionType: 'Network',
          SerialNumber: '00008110-001A2D3C0E91801E',
          EscapedFullServiceName: 'a&b@c',
          NetworkAddress: Buffer.from('EAIAAMCoAQ8AAAAAAAAAAA==', 'base64'),
          Empty: ''
        }
      }
    ]
  });
});

test('binary plists decode', () => {
  assert.deepEqual(decodePlist(Buffer.from(BINARY_PLIST, 'base64')), {
    Big: 2 ** 40,
    Count: 42,
    Data: Buffer.from([0, 1, 255]),
    DeviceName: 'Андрей’s iPhone',
    Empty: {},
    List: [1, 'two', { k: 'v' }],
    Neg: -5,
    No: false,
    Ok: true,
    ProductVersion: '18.1',
    Ratio: 1.5,
    When: new Date(Date.UTC(2024, 0, 2, 3, 4, 5))
  });
});

test('AFC packets carry lengths, packet number and operation', () => {
  const packet = encodePacket(AfcOp.FileWrite, 7, Buffer.alloc(8, 1), Buffer.from('hello'));
  assert.equal(packet.subarray(0, 8).toString('latin1'), 'CFA6LPAA');
  assert.equal(Number(packet.readBigUInt64LE(8)), AFC_HEADER_SIZE + 8 + 5);
  assert.equal(Number(packet.readBigUInt64LE(16)), AFC_HEADER_SIZE + 8);
  assert.deepEqual(decodeHeader(packet.subarray(0, AFC_HEADER_SIZE)), { length: AFC_HEADER_SIZE + 13, packet: 7, op: AfcOp.FileWrite });
  assert.throws(() => decodeHeader(Buffer.alloc(AFC_HEADER_SIZE)));
});

test('AFC strings, key/value lists and file info', () => {
  assert.deepEqual(cString('/a', '/b'), Buffer.from('/a\0/b\0'));
  assert.deepEqual(parseStrings(Buffer.from('.\0..\0DCIM\0Downloads\0')), ['.', '..', 'DCIM', 'Downloads']);
  const info = parseKeyValues(Buffer.from('st_size\x001234\x00st_blocks\x008\x00st_nlink\x001\x00st_ifmt\x00S_IFREG\x00st_mtime\x001700000000123456789\x00st_birthtime\x001690000000000000000\x00'));
  assert.deepEqual(parseFileInfo(info), { type: 'file', size: 1234, mtime: 1700000000123, ctime: 1690000000000 });
  assert.equal(parseFileInfo({ st_ifmt: 'S_IFDIR', st_size: '96' }).type, 'directory');
});

test('ios:// paths map to the media domain, app documents and virtual folders', () => {
  assert.deepEqual(resolveIosPath('/'), { kind: 'root' });
  assert.deepEqual(resolveIosPath('/Apps'), { kind: 'apps' });
  assert.deepEqual(resolveIosPath('/Media'), { kind: 'afc', domain: { kind: 'media' }, path: '/', isDomainRoot: true });
  assert.deepEqual(resolveIosPath('/Media/DCIM/100APPLE'), { kind: 'afc', domain: { kind: 'media' }, path: '/DCIM/100APPLE', isDomainRoot: false });
  assert.deepEqual(resolveIosPath('/Apps/com.example.notes'), { kind: 'afc', domain: { kind: 'app', bundleId: 'com.example.notes' }, path: '/Documents', isDomainRoot: true });
  assert.deepEqual(resolveIosPath('/Apps/com.example.notes/a/b.txt'), {
    kind: 'afc',
    domain: { kind: 'app', bundleId: 'com.example.notes' },
    path: '/Documents/a/b.txt',
    isDomainRoot: false
  });
  assert.equal(resolveIosPath('/Other'), undefined);
});

test('readZip inflates entries and keeps Unix modes', () => {
  const entries = readZip(Buffer.from(ZIP, 'base64'));
  assert.deepEqual(
    entries.map((e) => [e.name, e.mode, e.isDirectory]),
    [
      ['platform-tools/adb', 0o755, false],
      ['platform-tools/NOTICE.txt', undefined, false]
    ]
  );
  assert.equal(entries[0].read().toString(), '#!/bin/sh\necho adb\n'.repeat(20));
  assert.equal(entries[1].read().toString(), 'notice');
});
