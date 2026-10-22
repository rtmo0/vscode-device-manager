import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  basename,
  dirname,
  joinPath,
  parseConnectResult,
  parseDevices,
  parseMdnsServices,
  parsePairResult,
  parseStat,
  parseWifiAddress,
  shellQuote,
  transportOf
} from '../src/android/parse';

test('parseDevices reads states, transports and models', () => {
  const output = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    '192.168.1.23:41783     device product:panther model:Pixel_7 device:panther transport_id:3',
    'adb-28131FDH2000AB-xYz1Q2._adb-tls-connect._tcp device product:husky model:Pixel_8_Pro device:husky transport_id:4',
    'R5CT1234ABC            unauthorized usb:1-1 transport_id:1',
    'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2',
    '0123456789ABCDEF       no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:3-2 transport_id:5',
    ''
  ].join('\n');
  assert.deepEqual(parseDevices(output), [
    { serial: '192.168.1.23:41783', state: 'device', transport: 'wifi', model: 'Pixel 7', product: 'panther' },
    { serial: 'adb-28131FDH2000AB-xYz1Q2._adb-tls-connect._tcp', state: 'device', transport: 'wifi', model: 'Pixel 8 Pro', product: 'husky' },
    { serial: 'R5CT1234ABC', state: 'unauthorized', transport: 'usb', model: undefined, product: undefined },
    { serial: 'emulator-5554', state: 'device', transport: 'emulator', model: 'sdk gphone64 arm64', product: 'sdk_gphone64_arm64' },
    { serial: '0123456789ABCDEF', state: 'no permissions', transport: 'usb', model: undefined, product: undefined }
  ]);
  assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
});

test('transportOf recognises Wi-Fi serials', () => {
  assert.equal(transportOf('10.0.0.5:5555'), 'wifi');
  assert.equal(transportOf('[fe80::1]:5555'), 'wifi');
  assert.equal(transportOf('adb-X-Y._adb-tls-connect._tcp.'), 'wifi');
  assert.equal(transportOf('emulator-5556'), 'emulator');
  assert.equal(transportOf('ZY22K5BX7Q'), 'usb');
});

test('parseMdnsServices reads connect and pairing services', () => {
  const output = [
    'List of discovered mdns services',
    'adb-28131FDH2000AB-xYz1Q2\t_adb-tls-connect._tcp\t192.168.1.23:41783',
    'adb-28131FDH2000AB-xYz1Q2\t_adb-tls-pairing._tcp.\t192.168.1.23:37099',
    'adb-OTHER\t_adb._tcp\t192.168.1.40:5555'
  ].join('\n');
  assert.deepEqual(parseMdnsServices(output), [
    { name: 'adb-28131FDH2000AB-xYz1Q2', kind: 'connect', address: '192.168.1.23:41783' },
    { name: 'adb-28131FDH2000AB-xYz1Q2', kind: 'pairing', address: '192.168.1.23:37099' }
  ]);
});

test('parseConnectResult decides success from the output', () => {
  assert.deepEqual(parseConnectResult('connected to 192.168.1.23:5555\n'), { ok: true, message: 'connected to 192.168.1.23:5555' });
  assert.equal(parseConnectResult('already connected to 192.168.1.23:5555\n').ok, true);
  assert.deepEqual(parseConnectResult("failed to connect to '192.168.1.23:5555': Connection refused\n"), {
    ok: false,
    message: "failed to connect to '192.168.1.23:5555': Connection refused"
  });
  assert.equal(parseConnectResult('failed to authenticate to 192.168.1.23:41783\n').ok, false);
});

test('parsePairResult reads the guid', () => {
  assert.deepEqual(parsePairResult('Successfully paired to 192.168.1.23:37099 [guid=adb-28131FDH2000AB-xYz1Q2]\n'), {
    ok: true,
    guid: 'adb-28131FDH2000AB-xYz1Q2',
    message: 'Successfully paired to 192.168.1.23:37099 [guid=adb-28131FDH2000AB-xYz1Q2]'
  });
  assert.equal(parsePairResult('Failed: Wrong password or connection was dropped.\n').ok, false);
});

test('parseWifiAddress reads ip addr and ip route output', () => {
  assert.equal(parseWifiAddress('47: wlan0    inet 192.168.1.23/24 brd 192.168.1.255 scope global wlan0\\       valid_lft forever'), '192.168.1.23');
  assert.equal(parseWifiAddress('192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.23'), '192.168.1.23');
  assert.equal(parseWifiAddress('Device "wlan0" does not exist.'), undefined);
});

test('parseStat reads types, sizes, dates and names with separators', () => {
  const output = ['41f9|3452|1700000000|.', '41f9|3452|1700000000|..', '41f9|3452|1700000100|DCIM', '81b0|1048576|1700000200|a|b c.txt', 'a1ff|9|1700000300|link', ''].join('\n');
  assert.deepEqual(parseStat(output), [
    { type: 'directory', size: 3452, mtime: 1700000100000, name: 'DCIM' },
    { type: 'file', size: 1048576, mtime: 1700000200000, name: 'a|b c.txt' },
    { type: 'symlink', size: 9, mtime: 1700000300000, name: 'link' }
  ]);
});

test('shellQuote survives quotes and spaces', () => {
  assert.equal(shellQuote("/sdcard/it's here"), `'/sdcard/it'\\''s here'`);
});

test('path helpers', () => {
  assert.equal(joinPath('/', 'sdcard'), '/sdcard');
  assert.equal(joinPath('/sdcard', 'DCIM'), '/sdcard/DCIM');
  assert.equal(dirname('/sdcard/DCIM'), '/sdcard');
  assert.equal(dirname('/sdcard'), '/');
  assert.equal(basename('/sdcard/DCIM/'), 'DCIM');
  assert.equal(basename('/'), '/');
});
