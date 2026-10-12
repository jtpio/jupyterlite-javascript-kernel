// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { safe } from './utils';

/**
 * An image encoded by encodeImage().
 */
export interface IEncodedImage {
  /**
   * The MIME type of the image, like `image/png`.
   */
  mimeType: string;

  /**
   * The bytes of the image.
   */
  bytes: Uint8Array;

  /**
   * A short description of the value, for the plain text of its output,
   * like `<OffscreenCanvas 40x30>`.
   */
  description: string;
}

/**
 * The types of the Blobs shown as images.
 */
export const IMAGE_BLOB_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml'
]);

/**
 * The types an OffscreenCanvas encodes its drawing to, in every browser.
 */
const CANVAS_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * What the runtime uses of a Blob, without the DOM types.
 */
interface IBlobLike {
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * What the runtime uses of an OffscreenCanvas, without the DOM types.
 */
interface IOffscreenCanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): {
    putImageData(data: unknown, x: number, y: number): void;
    drawImage(image: unknown, x: number, y: number): void;
  } | null;
  convertToBlob(options?: { type?: string }): Promise<IBlobLike>;
}

/**
 * The kinds of values encodeImage() encodes.
 */
type ImageKind = 'canvas' | 'bitmap' | 'data' | 'blob';

/**
 * The kind of image of a value, recognized from its tag and its methods,
 * whatever its realm, or null.
 */
function imageKind(value: unknown): ImageKind | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const tag = safe(() => Object.prototype.toString.call(value), '');
  const member = (name: string) => safe(() => (value as any)[name]);
  switch (tag) {
    case '[object Blob]':
    case '[object File]':
      return typeof member('arrayBuffer') === 'function' ? 'blob' : null;
    case '[object ImageBitmap]':
      return 'bitmap';
    case '[object ImageData]':
      return 'data';
    default:
      // An OffscreenCanvas, or a canvas of a library with the same API
      return typeof member('convertToBlob') === 'function' &&
        typeof member('width') === 'number' &&
        typeof member('height') === 'number'
        ? 'canvas'
        : null;
  }
}

/**
 * Whether a value is a Blob, or a File, of any realm.
 */
export function isBlob(value: unknown): boolean {
  return imageKind(value) === 'blob';
}

/**
 * The bytes of a Blob.
 */
export async function blobBytes(blob: unknown): Promise<Uint8Array> {
  return new Uint8Array(await (blob as IBlobLike).arrayBuffer());
}

/**
 * Encode an image which can only be encoded asynchronously: an
 * OffscreenCanvas (with `convertToBlob()`), an ImageBitmap, an ImageData, or
 * a Blob of an image (PNG, JPEG, GIF, WebP or SVG). Returns null for the
 * other values.
 *
 * The drawing is copied when the function is called, so that the image
 * shows the canvas as it is now, even when the code draws on it again. The
 * ImageBitmap and the ImageData are drawn on an OffscreenCanvas of `scope`,
 * the global scope of the realm running the cells: without one, they are
 * not encoded. The values are recognized from their tag and their methods,
 * so this works in any engine, and with the values of another realm.
 *
 * @param scope - The global scope of the realm running the cells.
 * @param type - The MIME type to encode a drawing to, `image/png` by
 * default, and the type of a Blob whose type is not an image type, given to
 * display.png() or display.jpeg(): without it, these Blobs are not encoded.
 * @returns The promise of the image, rejected when the browser can not
 * encode it, like a canvas without pixels.
 */
export function encodeImage(
  value: unknown,
  scope: Record<string, any>,
  type?: string
): Promise<IEncodedImage> | null {
  const kind = imageKind(value);
  if (kind === null) {
    return null;
  }
  const item = value as any;
  if (kind === 'blob') {
    const blobType = safe(() => String(item.type), '');
    // An image keeps its type, like an SVG image given to display.png()
    const mimeType = IMAGE_BLOB_TYPES.has(blobType) ? blobType : type;
    if (!mimeType) {
      return null;
    }
    const size = safe(() => Number(item.size), 0);
    const name = safe(() => item[Symbol.toStringTag], 'Blob');
    return blobBytes(item).then(bytes => ({
      mimeType,
      bytes,
      description: `<${name} ${blobType || 'image'}, ${size} bytes>`
    }));
  }

  const encodedType = type && CANVAS_TYPES.has(type) ? type : 'image/png';
  try {
    const width = Number(item.width);
    const height = Number(item.height);
    const name = {
      canvas: 'OffscreenCanvas',
      bitmap: 'ImageBitmap',
      data: 'ImageData'
    }[kind];
    let canvas: IOffscreenCanvasLike;
    if (kind === 'canvas') {
      canvas = item;
    } else {
      const OffscreenCanvas = safe(() => scope.OffscreenCanvas);
      if (typeof OffscreenCanvas !== 'function') {
        return null;
      }
      canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) {
        return null;
      }
      if (kind === 'data') {
        context.putImageData(item, 0, 0);
      } else {
        context.drawImage(item, 0, 0);
      }
    }
    // The browser copies the pixels now, and encodes them in parallel
    const blob = canvas.convertToBlob({ type: encodedType });
    return Promise.resolve(blob)
      .then(blobBytes)
      .then(bytes => ({
        mimeType: encodedType,
        bytes,
        description: `<${name} ${width}x${height}>`
      }));
  } catch (error) {
    // A closed ImageBitmap, or a canvas whose context was lost
    return Promise.reject(error);
  }
}
