// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { PathExt } from '@jupyterlab/coreutils';

import {
  DIR_MODE,
  DRIVE_SEPARATOR,
  type TDriveMethod,
  type TDriveRequest,
  type TDriveResponse
} from '@jupyterlite/services';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

type TStoredFile = NonNullable<TDriveResponse<'get'>>;

/**
 * Callback used by runtime helpers to proxy drive requests to the host.
 */
export type DriveRequestHandler = <T extends TDriveMethod>(
  request: TDriveRequest<T>
) => Promise<TDriveResponse<T>>;

/**
 * File metadata exposed through `jupyterlite.contents.stat()`.
 */
export interface IJupyterLiteContentsStat {
  path: string;
  name: string;
  type: 'directory' | 'file';
  size: number;
  created: string;
  lastModified: string;
}

/**
 * Browser-native contents helper exposed inside the JavaScript runtime.
 */
export interface IJupyterLiteContents {
  cwd(): string;
  chdir(path: string): Promise<string>;
  resolve(path?: string): string;
  exists(path: string): Promise<boolean>;
  listdir(path?: string): Promise<string[]>;
  stat(path: string): Promise<IJupyterLiteContentsStat>;
  readFile(path: string): Promise<unknown>;
  readText(path: string): Promise<string>;
  readJSON<T = any>(path: string): Promise<T>;
  readBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, value: unknown): Promise<string>;
  writeText(path: string, text: string): Promise<string>;
  writeJSON(path: string, value: unknown): Promise<string>;
  writeBytes(
    path: string,
    value: Blob | ArrayBuffer | ArrayBufferView
  ): Promise<string>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string>;
  remove(path: string): Promise<void>;
  rename(path: string, newPath: string): Promise<string>;
}

/**
 * Top-level runtime API exposed on `globalThis.jupyterlite`.
 */
export interface IJupyterLiteBrowserAPI {
  contents: IJupyterLiteContents;
}

/**
 * Options used to configure the runtime browser API.
 */
export interface IJupyterLiteBrowserAPIOptions {
  location: string;
  request: DriveRequestHandler;
}

/**
 * Handle returned after installing the runtime browser API.
 */
export interface IInstalledJupyterLiteBrowserAPI {
  api: IJupyterLiteBrowserAPI;
  dispose(): void;
}

interface IDrivePathParts {
  drive: string;
  localPath: string;
}

/**
 * Async browser-oriented contents accessor for JupyterLite kernels.
 */
export class JupyterLiteContentsAccessor implements IJupyterLiteContents {
  /**
   * Instantiate a new contents accessor.
   */
  constructor(options: IJupyterLiteBrowserAPIOptions) {
    this._request = options.request;
    this._cwd = normalizeDrivePath(options.location);
  }

  /**
   * Return the current working directory.
   */
  cwd = (): string => {
    return this._cwd;
  };

  /**
   * Resolve a path relative to the current working directory.
   */
  resolve = (path = '.'): string => {
    return resolveDrivePath(this._cwd, path);
  };

  /**
   * Change the current working directory.
   */
  chdir = async (path: string): Promise<string> => {
    const resolved = this.resolve(path);
    await this._assertDirectory(resolved);
    this._cwd = resolved;
    return this._cwd;
  };

  /**
   * Check whether a path exists.
   */
  exists = async (path: string): Promise<boolean> => {
    const resolved = this.resolve(path);
    const result = await this._request({
      method: 'lookup',
      path: resolved
    });
    return result.ok;
  };

  /**
   * List directory entries.
   */
  listdir = async (path = '.'): Promise<string[]> => {
    const resolved = this.resolve(path);
    await this._assertDirectory(resolved);
    return this._request({
      method: 'readdir',
      path: resolved
    });
  };

  /**
   * Fetch lightweight metadata about a path.
   */
  stat = async (path: string): Promise<IJupyterLiteContentsStat> => {
    const resolved = this.resolve(path);
    const lookup = await this._request({
      method: 'lookup',
      path: resolved
    });

    if (!lookup.ok) {
      throw new Error(`Path does not exist: ${resolved}`);
    }

    const [mode, stats] = await Promise.all([
      this._request({
        method: 'getmode',
        path: resolved
      }),
      this._request({
        method: 'getattr',
        path: resolved
      })
    ]);
    const { localPath } = splitDrivePath(resolved);

    return {
      path: resolved,
      name: PathExt.basename(localPath),
      type: mode === DIR_MODE ? 'directory' : 'file',
      size: stats.size,
      created: normalizeTimestamp(stats.ctime),
      lastModified: normalizeTimestamp(stats.mtime)
    };
  };

  /**
   * Read a file and auto-decode it based on the stored format.
   */
  readFile = async (path: string): Promise<unknown> => {
    const file = await this._readStoredFile(path);
    return decodeStoredFile(file);
  };

  /**
   * Read a file as UTF-8 text.
   */
  readText = async (path: string): Promise<string> => {
    const file = await this._readStoredFile(path);
    return decodeFileAsText(file);
  };

  /**
   * Read a file as JSON.
   */
  readJSON = async <T = any>(path: string): Promise<T> => {
    const file = await this._readStoredFile(path);
    return decodeFileAsJSON(file) as T;
  };

  /**
   * Read a file as bytes.
   */
  readBytes = async (path: string): Promise<Uint8Array> => {
    const file = await this._readStoredFile(path);
    return decodeFileAsBytes(file);
  };

  /**
   * Write a file by inferring the correct storage format from the value.
   */
  writeFile = async (path: string, value: unknown): Promise<string> => {
    if (typeof value === 'string') {
      return this.writeText(path, value);
    }

    if (isBlob(value) || isArrayBufferLike(value)) {
      return this.writeBytes(
        path,
        value as Blob | ArrayBuffer | ArrayBufferView
      );
    }

    return this.writeJSON(path, value);
  };

  /**
   * Write a UTF-8 text file.
   */
  writeText = async (path: string, text: string): Promise<string> => {
    const resolved = this.resolve(path);
    this._assertNotDriveRoot(resolved, 'write to');

    await this._request({
      method: 'put',
      path: resolved,
      data: {
        data: text,
        format: 'text'
      }
    });

    return resolved;
  };

  /**
   * Write a JSON file.
   */
  writeJSON = async (path: string, value: unknown): Promise<string> => {
    const resolved = this.resolve(path);
    this._assertNotDriveRoot(resolved, 'write to');

    await this._request({
      method: 'put',
      path: resolved,
      data: {
        data: JSON.stringify(value),
        format: 'json'
      }
    });

    return resolved;
  };

  /**
   * Write a binary file.
   */
  writeBytes = async (
    path: string,
    value: Blob | ArrayBuffer | ArrayBufferView
  ): Promise<string> => {
    const resolved = this.resolve(path);
    this._assertNotDriveRoot(resolved, 'write to');

    const bytes = await toUint8Array(value);

    await this._request({
      method: 'put',
      path: resolved,
      data: {
        data: bytesToBase64(bytes),
        format: 'base64'
      }
    });

    return resolved;
  };

  /**
   * Create a directory.
   */
  mkdir = async (
    path: string,
    options?: { recursive?: boolean }
  ): Promise<string> => {
    const resolved = this.resolve(path);

    if (isDriveRoot(resolved)) {
      return resolved;
    }

    if (options?.recursive) {
      const parts = splitDrivePath(resolved);
      const segments = parts.localPath.split('/').filter(Boolean);
      let currentLocalPath = '';

      for (const segment of segments) {
        currentLocalPath = currentLocalPath
          ? `${currentLocalPath}/${segment}`
          : segment;
        const currentPath = joinDrivePath({
          drive: parts.drive,
          localPath: currentLocalPath
        });
        await this._ensureDirectory(currentPath);
      }

      return resolved;
    }

    if (await this.exists(resolved)) {
      throw new Error(`Path already exists: ${resolved}`);
    }

    await this._request({
      method: 'mknod',
      path: resolved,
      data: {
        mode: DIR_MODE
      }
    });

    return resolved;
  };

  /**
   * Remove a file or directory.
   */
  remove = async (path: string): Promise<void> => {
    const resolved = this.resolve(path);
    this._assertNotDriveRoot(resolved, 'remove');

    await this._request({
      method: 'rmdir',
      path: resolved
    });
  };

  /**
   * Rename a file or directory.
   */
  rename = async (path: string, newPath: string): Promise<string> => {
    const resolved = this.resolve(path);
    const resolvedNewPath = this.resolve(newPath);
    this._assertNotDriveRoot(resolved, 'rename');
    this._assertNotDriveRoot(resolvedNewPath, 'rename to');

    await this._request({
      method: 'rename',
      path: resolved,
      data: {
        newPath: resolvedNewPath
      }
    });

    return resolvedNewPath;
  };

  /**
   * Ensure a path exists and is a directory.
   */
  private async _assertDirectory(path: string): Promise<void> {
    const lookup = await this._request({
      method: 'lookup',
      path
    });

    if (!lookup.ok) {
      throw new Error(`Directory does not exist: ${path}`);
    }

    const mode = await this._request({
      method: 'getmode',
      path
    });

    if (mode !== DIR_MODE) {
      throw new Error(`Path is not a directory: ${path}`);
    }
  }

  /**
   * Ensure a path exists as a directory, creating it when needed.
   */
  private async _ensureDirectory(path: string): Promise<void> {
    if (await this.exists(path)) {
      await this._assertDirectory(path);
      return;
    }

    await this._request({
      method: 'mknod',
      path,
      data: {
        mode: DIR_MODE
      }
    });
  }

  /**
   * Read a raw stored file response and turn common missing-path cases into
   * readable errors.
   */
  private async _readStoredFile(path: string): Promise<TStoredFile> {
    const resolved = this.resolve(path);
    const file = await this._request({
      method: 'get',
      path: resolved
    });

    if (file) {
      return file;
    }

    const lookup = await this._request({
      method: 'lookup',
      path: resolved
    });

    if (!lookup.ok) {
      throw new Error(`Path does not exist: ${resolved}`);
    }

    const mode = await this._request({
      method: 'getmode',
      path: resolved
    });

    if (mode === DIR_MODE) {
      throw new Error(`Path is a directory: ${resolved}`);
    }

    throw new Error(`Unable to read file: ${resolved}`);
  }

  /**
   * Guard operations that should never target the drive root.
   */
  private _assertNotDriveRoot(path: string, action: string): void {
    if (isDriveRoot(path)) {
      throw new Error(`Cannot ${action} the drive root`);
    }
  }

  private _cwd: string;
  private _request: DriveRequestHandler;
}

/**
 * Install the browser-facing JupyterLite API in the runtime global scope.
 */
export function installJupyterLiteBrowserAPI(
  globalScope: Record<string, any>,
  options: IJupyterLiteBrowserAPIOptions
): IInstalledJupyterLiteBrowserAPI {
  const contents = new JupyterLiteContentsAccessor(options);
  const previous = globalScope.jupyterlite;
  const hasExistingObject =
    typeof previous === 'object' && previous !== null && !Array.isArray(previous);

  if (hasExistingObject) {
    const previousContents = previous.contents;
    const hadContents = Object.prototype.hasOwnProperty.call(
      previous,
      'contents'
    );

    previous.contents = contents;

    return {
      api: previous as IJupyterLiteBrowserAPI,
      dispose: () => {
        if (hadContents) {
          previous.contents = previousContents;
          return;
        }

        delete previous.contents;
      }
    };
  }

  const api: IJupyterLiteBrowserAPI = {
    contents
  };

  globalScope.jupyterlite = api;

  return {
    api,
    dispose: () => {
      if (previous === undefined) {
        delete globalScope.jupyterlite;
        return;
      }

      globalScope.jupyterlite = previous;
    }
  };
}

/**
 * Decode a stored file based on its Jupyter contents format.
 */
function decodeStoredFile(file: TStoredFile): unknown {
  switch (file.format) {
    case 'json':
      return decodeFileAsJSON(file);
    case 'base64':
      return decodeFileAsBytes(file);
    case 'text':
    default:
      return decodeFileAsText(file);
  }
}

/**
 * Decode a stored file as text.
 */
function decodeFileAsText(file: TStoredFile): string {
  switch (file.format) {
    case 'base64':
      return TEXT_DECODER.decode(base64ToBytes(String(file.content ?? '')));
    case 'json':
      return String(file.content ?? '');
    case 'text':
    default:
      return String(file.content ?? '');
  }
}

/**
 * Decode a stored file as JSON.
 */
function decodeFileAsJSON(file: TStoredFile): unknown {
  const raw =
    file.format === 'json' ? String(file.content ?? 'null') : decodeFileAsText(file);
  return JSON.parse(raw);
}

/**
 * Decode a stored file as bytes.
 */
function decodeFileAsBytes(file: TStoredFile): Uint8Array {
  switch (file.format) {
    case 'base64':
      return base64ToBytes(String(file.content ?? ''));
    case 'json':
    case 'text':
    default:
      return TEXT_ENCODER.encode(String(file.content ?? ''));
  }
}

/**
 * Normalize a path that may optionally include a drive prefix.
 */
function normalizeDrivePath(path: string): string {
  const { drive, localPath } = splitDrivePath(path);
  return joinDrivePath({
    drive,
    localPath: PathExt.resolve('/', localPath || '')
  });
}

/**
 * Resolve a path against the current working directory while preserving drive
 * prefixes used by JupyterLite contents.
 */
function resolveDrivePath(cwd: string, path: string): string {
  const current = splitDrivePath(cwd);
  const target = splitDrivePath(path);
  const drive = target.drive || current.drive;
  const basePath = target.drive ? '' : current.localPath;

  return joinDrivePath({
    drive,
    localPath: PathExt.resolve('/', basePath || '', target.localPath || '.')
  });
}

/**
 * Split a drive-prefixed path like `drive:dir/file.txt`.
 */
function splitDrivePath(path: string): IDrivePathParts {
  const separatorIndex = path.indexOf(DRIVE_SEPARATOR);

  if (separatorIndex === -1) {
    return {
      drive: '',
      localPath: path
    };
  }

  return {
    drive: path.slice(0, separatorIndex),
    localPath: path.slice(separatorIndex + 1)
  };
}

/**
 * Join a drive prefix and local path back into a JupyterLite path.
 */
function joinDrivePath(parts: IDrivePathParts): string {
  return parts.drive ? `${parts.drive}${DRIVE_SEPARATOR}${parts.localPath}` : parts.localPath;
}

/**
 * Return whether a path targets the root of a drive.
 */
function isDriveRoot(path: string): boolean {
  return splitDrivePath(path).localPath === '';
}

/**
 * Convert a binary value into a byte array.
 */
async function toUint8Array(
  value: Blob | ArrayBuffer | ArrayBufferView
): Promise<Uint8Array> {
  if (isBlob(value)) {
    return new Uint8Array(await value.arrayBuffer());
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Return whether a value is a Blob in the current runtime.
 */
function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

/**
 * Return whether a value can be treated as raw bytes.
 */
function isArrayBufferLike(
  value: unknown
): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * Encode bytes as base64.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const bufferCtor = (globalThis as any).Buffer;
  if (typeof bufferCtor !== 'undefined') {
    return bufferCtor.from(bytes).toString('base64');
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Decode base64 into bytes.
 */
function base64ToBytes(value: string): Uint8Array {
  const bufferCtor = (globalThis as any).Buffer;
  if (typeof bufferCtor !== 'undefined') {
    return Uint8Array.from(bufferCtor.from(value, 'base64'));
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/**
 * Normalize stats timestamps to plain strings.
 */
function normalizeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
