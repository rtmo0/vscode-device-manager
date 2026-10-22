# Roadmap

Goal: a device manager in VS Code for phones and tablets on the same Wi-Fi network — connect without a cable, browse storage, move files both ways — for Android and iOS.

## Architecture

- **Nothing to install.** Android goes through `adb` (`src/android/adb.ts`), downloaded from Google on demand when it is missing. iOS speaks Apple's protocols directly in TypeScript (`src/ios/`): usbmuxd (system service), lockdown with TLS from the usbmuxd pair record, AFC, house_arrest, installation_proxy. No libimobiledevice or Python.
- Parsers and protocol encoders are pure functions covered by unit tests.
- **One file system provider per platform.** `android://<serial>/path` and `ios://<udid>/Media/…`, `ios://<udid>/Apps/<bundle id>/…`. Editors, the Explorer, search and copy/paste work on top of it; the Devices view only adds what the Explorer cannot do (connection, bulk upload/download with native `adb push/pull` speed).
- **Native UI only:** TreeView, QuickPick, InputBox, notifications. A webview only for things like the pairing QR code or screen mirroring.

## Milestones

### 1. Android over Wi-Fi — 0.1.0
- Device list with transport and state, polling while visible.
- mDNS discovery, pairing code, `adb connect`, `adb tcpip` from USB, recent addresses.
- `android://` FileSystemProvider; Open in Explorer; upload, download, new folder, rename, delete, drag and drop.

### 2. Android polish
- Pair with QR code (`WIFI:T:ADB;S:<name>;P:<password>;;` shown in a webview, then `adb pair` to the advertised service).
- Reconnect automatically to recent devices when they appear on the network.
- Transfer progress with bytes and speed (parse `adb push/pull` progress), cancellation per file.
- Storage roots per device: internal storage, SD card (`/storage/XXXX-XXXX`), `/data/local/tmp`; app data through `run-as` for debuggable apps.
- Install APK (drop an `.apk` on a device), screenshot and screen recording into the workspace, logcat in an output channel.

### 3. iOS — 0.1.0
- Devices from usbmuxd (USB and Wi-Fi), name and iOS version from lockdown; states for not trusted and locked devices.
- Enable Wi-Fi Connection (`EnableWifiConnections` in `com.apple.mobile.wireless_lockdown`).
- `ios://` FileSystemProvider over AFC: Media and the Documents of file-sharing apps (house_arrest `VendDocuments`), with pipelined requests.

### 3a. iOS next
- Pairing from the extension (Trust dialog) without Finder / Apple Devices: needs certificate generation for the pair record.
- Photos: HEIC preview, export to JPEG.
- Install `.ipa` (installation_proxy), screenshots, syslog.
- Developer services on iOS 17+ (RemoteXPC tunnel) — only if needed; files do not require them.

### 4. Ideas
- Port forwarding (`adb forward/reverse`), open a device web page in the Simple Browser.
- Device info panel: battery, storage, OS version.
- Run a shell command on several devices at once.
