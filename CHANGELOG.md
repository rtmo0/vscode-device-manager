# Changelog

## 0.2.0

- Pair with QR Code (Android 11+): scan the code from Wireless debugging, as in Android Studio.
- Install App: `.apk` on Android, `.ipa` on iOS (installation_proxy), also by dropping files on a device.
- Take Screenshot for Android devices.
- Show Device Log: `logcat` for Android, the iOS system log (syslog_relay) colored by level with a text filter.
- Device details: OS version and battery in the Devices view, free storage in the tooltip.
- Recently used Android devices reconnect automatically when they come back on the network (`mobile-device-manager.android.autoReconnect`).

## 0.1.1

- Manifest uses plain ASCII hyphens: the Marketplace rejected the non-breaking hyphen in "Wi-Fi" as suspicious content.

## 0.1.0

- Devices view in the Activity Bar: Android devices known to adb and iOS devices known to usbmuxd, with their connection (Wi-Fi, USB, emulator) and state, refreshed while the view is visible.
- iOS without extra software: usbmuxd, lockdown (TLS session with the pair record), AFC and house_arrest implemented in TypeScript.
- iOS: Enable Wi-Fi Connection, Media (DCIM, Downloads…) and the Documents of apps that share files, as `ios://` folders.
- Download Android Platform-Tools: when adb is missing, one click downloads it from Google into the extension's storage.
- Connect over Wi-Fi: devices found through mDNS, recent addresses, manual `IP:port`.
- Pair with Pairing Code (Android 11+), then connect automatically.
- Switch USB Device to Wi-Fi (`adb tcpip 5555`) for any Android version.
- `android://` and `ios://` file systems: device files open and save in the editor; **Open in Explorer** adds the device storage as a workspace folder.
- File browser in the Devices view: Upload…, Download…, New Folder…, Rename…, Delete…, Copy Path, Open Device Shell.
- Drag and drop: files from the Explorer or the OS onto a device folder upload them; items dragged inside the view move on the device or copy between devices.
