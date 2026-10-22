# Changelog

## 0.1.0

- Devices view in the Activity Bar: Android devices known to adb and iOS devices known to usbmuxd, with their connection (Wi‑Fi, USB, emulator) and state, refreshed while the view is visible.
- iOS without extra software: usbmuxd, lockdown (TLS session with the pair record), AFC and house_arrest implemented in TypeScript.
- iOS: Enable Wi‑Fi Connection, Media (DCIM, Downloads…) and the Documents of apps that share files, as `ios://` folders.
- Download Android Platform-Tools: when adb is missing, one click downloads it from Google into the extension's storage.
- Connect over Wi‑Fi: devices found through mDNS, recent addresses, manual `IP:port`.
- Pair with Pairing Code (Android 11+), then connect automatically.
- Switch USB Device to Wi‑Fi (`adb tcpip 5555`) for any Android version.
- `android://` and `ios://` file systems: device files open and save in the editor; **Open in Explorer** adds the device storage as a workspace folder.
- File browser in the Devices view: Upload…, Download…, New Folder…, Rename…, Delete…, Copy Path, Open Device Shell.
- Drag and drop: files from the Explorer or the OS onto a device folder upload them; items dragged inside the view move on the device or copy between devices.
