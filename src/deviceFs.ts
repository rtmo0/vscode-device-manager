import * as vscode from 'vscode';

/** A directory entry as the Devices view shows it; shared by the Android and iOS file systems. */
export interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: number;
  /** Shown instead of the name, e.g. the app name for an iOS app folder. */
  label?: string;
  description?: string;
  /** `root`: can receive files but not be renamed or deleted; `virtual`: a fixed folder. */
  readonly?: 'root' | 'virtual';
}

export interface DeviceFileSystem extends vscode.FileSystemProvider {
  list(uri: vscode.Uri): Promise<DirEntry[]>;
  notify(type: vscode.FileChangeType, ...uris: vscode.Uri[]): void;
}
