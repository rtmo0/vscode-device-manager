import * as vscode from 'vscode';
import { AdbNotFoundError } from './android/adb';

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // adb prefixes its own errors with "adb: error:".
  return text.replace(/^adb: (error: )?/gm, '').trim();
}

export async function showError(error: unknown, prefix?: string): Promise<void> {
  if (error instanceof AdbNotFoundError) {
    const choice = await vscode.window.showErrorMessage(error.message, 'Download adb', 'Set Path…');
    if (choice === 'Download adb') {
      await vscode.commands.executeCommand('mobile-device-manager.installAdb');
    } else if (choice) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'mobile-device-manager.adbPath');
    }
    return;
  }
  const text = errorMessage(error);
  const choice = await vscode.window.showErrorMessage(prefix ? `${prefix}: ${text}` : text, 'Show Output');
  if (choice) {
    await vscode.commands.executeCommand('mobile-device-manager.showOutput');
  }
}

/** Wraps a command handler so that failures are reported instead of being swallowed. */
export function guarded<A extends unknown[]>(handler: (...args: A) => Promise<unknown> | unknown): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await handler(...args);
    } catch (error) {
      if (!(error instanceof vscode.CancellationError)) {
        await showError(error);
      }
    }
  };
}

export function withProgress<T>(title: string, task: (token: vscode.CancellationToken) => Promise<T>, cancellable = false): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable }, (_progress, token) => task(token));
}

export function notify(text: string): void {
  vscode.window.setStatusBarMessage(text, 5000);
}

export async function confirm(message: string, detail: string | undefined, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
}

export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
