// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { safe } from './utils';

/**
 * The host APIs used by the runtime, with a fallback when they are missing.
 *
 * The runtime runs in any ECMAScript engine (browser windows and workers,
 * or engines without the web APIs), so this is the only module reading the
 * globals of the host: the package compiles without the DOM types.
 */

/**
 * The optional globals of the host used by the runtime.
 */
interface IHostGlobals {
  crypto?: {
    randomUUID?(): string;
    getRandomValues?<T extends ArrayBufferView>(array: T): T;
  };
  TextDecoder?: new (label?: string) => { decode(bytes: Uint8Array): string };
  URL?: new (url: string, base?: string) => { toString(): string };
  console?: Partial<
    Record<'log' | 'error' | 'warn', (...data: unknown[]) => void>
  >;
}

const host = (): IHostGlobals => globalThis as unknown as IHostGlobals;

// @ts-expect-error The runtime must not depend on the DOM types
const noDom: Window | undefined = undefined;
void noDom;

/**
 * A random UUID (version 4), for comm and message ids.
 *
 * crypto.randomUUID only exists in secure contexts, so this falls back to
 * crypto.getRandomValues, and then to Math.random: the ids only need to be
 * unique, do not use them for anything related to security.
 */
export function uuid(): string {
  const crypto = host().crypto;
  if (typeof crypto?.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // Fall back to random bytes
    }
  }
  const bytes = new Uint8Array(16);
  // getRandomValues also exists in insecure contexts
  const filled = safe(() => {
    crypto!.getRandomValues!(bytes);
    return true;
  }, false);
  if (!filled) {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 16)
  ]
    .map(part => part.join(''))
    .join('-');
}

/**
 * Decode UTF-8 bytes, with the TextDecoder of the host when there is one.
 * Invalid sequences become U+FFFD, like with TextDecoder.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  const Decoder = host().TextDecoder;
  if (typeof Decoder === 'function') {
    return new Decoder('utf-8').decode(bytes);
  }
  // The WHATWG decoder: the bounds of the next continuation byte exclude
  // the overlong encodings, the surrogates and the code points after U+10FFFF
  const units: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const first = bytes[i++];
    if (first < 0x80) {
      units.push(first);
      continue;
    }
    const length =
      first >= 0xc2 && first <= 0xdf
        ? 1
        : first >= 0xe0 && first <= 0xef
          ? 2
          : first >= 0xf0 && first <= 0xf4
            ? 3
            : 0;
    let codePoint = first & (0x3f >> length);
    let lower = first === 0xe0 ? 0xa0 : first === 0xf0 ? 0x90 : 0x80;
    let upper = first === 0xed ? 0x9f : first === 0xf4 ? 0x8f : 0xbf;
    let needed = length;
    while (needed > 0) {
      const next = bytes[i];
      if (next === undefined || next < lower || next > upper) {
        break;
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
      lower = 0x80;
      upper = 0xbf;
      needed--;
      i++;
    }
    if (length === 0 || needed > 0) {
      // An invalid sequence: the byte that ended it starts the next one
      units.push(0xfffd);
    } else if (codePoint >= 0x10000) {
      codePoint -= 0x10000;
      units.push(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
    } else {
      units.push(codePoint);
    }
  }
  const chunks: string[] = [];
  for (let start = 0; start < units.length; start += 0x8000) {
    chunks.push(
      String.fromCharCode.apply(null, units.slice(start, start + 0x8000))
    );
  }
  return chunks.join('');
}

/**
 * Resolve a path against a base URL, with the URL class of the host when
 * there is one, or else by joining them.
 */
export function resolveUrl(path: string, base: string): string {
  const Url = host().URL;
  if (typeof Url === 'function') {
    try {
      return new Url(path, base).toString();
    } catch {
      // Fall back to joining them
    }
  }
  return `${base}${path}`;
}

/**
 * The console of the host, if any.
 */
export function hostConsole(): IHostGlobals['console'] {
  return host().console;
}
