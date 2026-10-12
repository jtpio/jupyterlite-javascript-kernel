// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * Call a function, and return a fallback value if it throws.
 */
export function safe<T, F>(f: () => T, fallback: F): T | F;
export function safe<T>(f: () => T): T | undefined;
export function safe<T, F>(f: () => T, fallback?: F): T | F | undefined {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/**
 * Whether a value is a plain object, from any realm.
 */
export function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * Whether an object has an own property.
 */
export function hasOwn(object: unknown, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

const ANSI: Record<string, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  underline: [4, 24],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39]
};

/**
 * Color a text with ANSI escape codes, which JupyterLab renders in the
 * text outputs.
 */
export function color(name: string, text: string): string {
  const [open, close] = ANSI[name];
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

/**
 * Remove the ANSI escape codes of a text.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Escape a text for HTML.
 */
export function escapeHtml(text: unknown): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encode bytes in base64, without relying on btoa which is not available in
 * every JavaScript engine.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunks.push(
      BASE64[(n >> 18) & 63] +
        BASE64[(n >> 12) & 63] +
        BASE64[(n >> 6) & 63] +
        BASE64[n & 63]
    );
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    chunks.push(BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + '==');
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    chunks.push(
      BASE64[(n >> 18) & 63] +
        BASE64[(n >> 12) & 63] +
        BASE64[(n >> 6) & 63] +
        '='
    );
  }
  return chunks.join('');
}

/**
 * The bytes of binary data: an ArrayBuffer or a view on one, possibly from
 * another realm. Returns null for other values.
 */
export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (isArrayBuffer(data)) {
    return new Uint8Array(data as ArrayBuffer);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

const typedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag
)!.get!;

/**
 * Whether a value is a Uint8Array, from any realm.
 */
export function isUint8Array(value: unknown): value is Uint8Array {
  return safe(() => typedArrayTag.call(value) === 'Uint8Array', false);
}

/**
 * Encode a string in UTF-8, like TextEncoder: the lone surrogates become
 * U+FFFD.
 */
export function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    let codePoint = char.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }
  return Uint8Array.from(bytes);
}

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
)!.get!;

/**
 * Whether a value is an ArrayBuffer, from any realm.
 */
export function isArrayBuffer(value: unknown): boolean {
  return safe(() => (arrayBufferByteLength.call(value), true), false);
}

/**
 * Whether a value is a thenable, like a promise of any realm.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    safe(
      () => typeof (value as PromiseLike<unknown>).then === 'function',
      false
    )
  );
}
