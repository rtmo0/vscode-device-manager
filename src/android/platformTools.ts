import { get } from 'node:https';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { readZip } from '../unzip';

const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
const DOWNLOAD_URL = `https://dl.google.com/android/repository/platform-tools-latest-${PLATFORM}.zip`;
const LICENSE_URL = 'https://developer.android.com/studio/terms';
const MAX_REDIRECTS = 5;

/** adb inside the copy of Platform-Tools downloaded into the extension's storage. */
export function bundledAdbPath(storage: vscode.Uri): string {
  return join(storage.fsPath, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
}

function download(url: string, token: vscode.CancellationToken, onProgress: (received: number, total: number) => void, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const { statusCode = 0, headers } = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects < MAX_REDIRECTS) {
        response.resume();
        resolve(download(new URL(headers.location, url).toString(), token, onProgress, redirects + 1));
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Downloading Platform-Tools failed: HTTP ${statusCode}`));
        return;
      }
      const total = Number(headers['content-length'] ?? 0);
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        onProgress(received, total);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('error', reject);
    token.onCancellationRequested(() => {
      request.destroy();
      reject(new vscode.CancellationError());
    });
  });
}

/**
 * Downloads Google's Android SDK Platform-Tools into the extension's global storage, so adb works
 * without installing anything. The user accepts the SDK license first.
 */
export async function installPlatformTools(storage: vscode.Uri): Promise<string | undefined> {
  const choice = await vscode.window.showInformationMessage(
    'Download Android SDK Platform-Tools (adb) from Google?',
    {
      modal: true,
      detail: `About 15 MB from ${DOWNLOAD_URL}\n\nIt is stored inside VS Code for this extension only. By downloading you accept the Android Software Development Kit License Agreement.`
    },
    'Download',
    'View License'
  );
  if (choice === 'View License') {
    await vscode.env.openExternal(vscode.Uri.parse(LICENSE_URL));
    return undefined;
  }
  if (choice !== 'Download') {
    return undefined;
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Downloading Android Platform-Tools', cancellable: true },
    async (progress, token) => {
      let reported = 0;
      const archive = await download(DOWNLOAD_URL, token, (received, total) => {
        if (total) {
          const percent = Math.floor((received / total) * 100);
          progress.report({ increment: percent - reported, message: `${(received / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB` });
          reported = percent;
        }
      });
      progress.report({ message: 'Unpacking…' });
      const target = join(storage.fsPath, 'platform-tools');
      const staging = `${target}.partial`;
      await rm(staging, { recursive: true, force: true });
      for (const entry of readZip(archive)) {
        // The archive holds a single platform-tools/ folder.
        const path = join(staging, entry.name.replace(/^platform-tools\//, ''));
        if (entry.isDirectory) {
          await mkdir(path, { recursive: true });
          continue;
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, entry.read());
        if (entry.mode && process.platform !== 'win32') {
          await chmod(path, entry.mode);
        }
      }
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      const adb = bundledAdbPath(storage);
      if (process.platform !== 'win32') {
        await chmod(adb, 0o755);
      }
      return adb;
    }
  );
}
