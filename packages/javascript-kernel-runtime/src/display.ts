// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { IMimeBundle } from '@jupyterlab/nbformat';

import { decodeUtf8 } from './env';
import type { IEncodedImage } from './images';
import {
  inspect,
  isBoxedPrimitive,
  isDate,
  isDomNode,
  isError,
  isMap,
  isModuleNamespace,
  isRegExp,
  isSet,
  nativeGetterNames
} from './inspect';
import { setDoc } from './introspection';
import {
  bytesToBase64,
  isArrayBuffer,
  isPlainObject,
  safe,
  toBytes
} from './utils';

/**
 * Options of display() and of its helpers.
 */
export interface IDisplayOptions {
  /**
   * The id of the display, to update its outputs later: a string, or true
   * for a new id. display() then returns a handle.
   */
  id?: string | boolean;

  /**
   * The metadata of the output.
   */
  metadata?: Record<string, unknown>;

  /**
   * Whether the value is a MIME bundle to show as is.
   */
  raw?: boolean;

  /**
   * Whether a DOM element is shown live, when the kernel can: the element
   * itself, with its event listeners and its later changes, instead of a
   * snapshot of its HTML. True by default.
   */
  live?: boolean;
}

/**
 * Options of the image helpers.
 */
export interface IImageOptions extends IDisplayOptions {
  width?: number | string;
  height?: number | string;
}

/**
 * The data and the metadata of an output.
 */
export interface IDisplayData {
  data: IMimeBundle;
  metadata: Record<string, unknown>;
}

/**
 * What display() needs from the kernel.
 */
export interface IDisplayHost {
  /**
   * Publish a display_data message, or an update_display_data message.
   *
   * @param ready - The data of the output once it is ready, like the image
   * of an OffscreenCanvas being encoded. The host sends the output with it,
   * in the place of the output: the outputs sent after it wait for it, and
   * it is sent with `data` and `metadata` when the promise rejects. A host
   * which can not wait ignores it.
   */
  publish(
    data: IMimeBundle,
    metadata: Record<string, unknown>,
    transient: { display_id?: string },
    update: boolean,
    ready?: Promise<IDisplayData>
  ): void;

  /**
   * Clear the outputs of the cell.
   */
  clear(wait: boolean): void;

  /**
   * The MIME bundle of a value.
   *
   * @param options.live - Whether a DOM element is shown live, when the
   * host can. False only when the user turns it off.
   */
  mimeBundle(value: unknown, options?: { live?: boolean }): IMimeBundle;

  /**
   * Read a file, for display.image(path). The helper is only available when
   * the kernel can read files.
   */
  readFile?(path: string): Uint8Array;

  /**
   * Encode the images which can only be encoded asynchronously, like an
   * OffscreenCanvas, an ImageBitmap, an ImageData or a Blob of an image, or
   * return null for the other values, with encodeImage(). Without it, these
   * values are shown as text.
   *
   * @param type - The MIME type of the image, for display.png() and
   * display.jpeg().
   */
  encodeImage?(value: unknown, type?: string): Promise<IEncodedImage> | null;
}

/**
 * The display() function, with its helpers.
 */
export interface IDisplay {
  (value: unknown, options?: IDisplayOptions): DisplayHandle | undefined;
  html(
    content: string | TemplateStringsArray,
    ...rest: unknown[]
  ): DisplayHandle | undefined;
  markdown(
    content: string | TemplateStringsArray,
    ...rest: unknown[]
  ): DisplayHandle | undefined;
  svg(
    content: string | TemplateStringsArray,
    ...rest: unknown[]
  ): DisplayHandle | undefined;
  latex(
    content: string | TemplateStringsArray,
    ...rest: unknown[]
  ): DisplayHandle | undefined;
  text(
    content: string | TemplateStringsArray,
    ...rest: unknown[]
  ): DisplayHandle | undefined;
  json(content: unknown, options?: IDisplayOptions): DisplayHandle | undefined;
  vegalite(spec: unknown, options?: IDisplayOptions): DisplayHandle | undefined;
  vega(spec: unknown, options?: IDisplayOptions): DisplayHandle | undefined;
  mermaid(
    content: string | TemplateStringsArray,
    ...rest: unknown[]
  ): DisplayHandle | undefined;
  png(content: unknown, options?: IImageOptions): DisplayHandle | undefined;
  jpeg(content: unknown, options?: IImageOptions): DisplayHandle | undefined;
  image?(
    path: string,
    options?: IImageOptions & { type?: string }
  ): DisplayHandle | undefined;
  mime(
    bundle: Record<string, unknown>,
    options?: IDisplayOptions
  ): DisplayHandle | undefined;
  clear(wait?: boolean): void;
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
};

/**
 * Whether a MIME type holds JSON data.
 */
export function isJsonMimeType(mimeType: string): boolean {
  return mimeType === 'application/json' || /\+json$/.test(mimeType);
}

/**
 * The MIME types of the outputs which JupyterLab renders, besides the
 * vendor types like `text/vnd.mermaid` or `application/vnd.vegalite.v5+json`
 * and the JSON types like `application/geo+json`.
 */
const KNOWN_MIME_TYPES = new Set([
  'text/plain',
  'text/html',
  'text/markdown',
  'text/latex',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
  'application/json',
  'application/javascript',
  'application/pdf'
]);

/**
 * Whether a string is the MIME type of a Jupyter output, like `text/html` or
 * `application/vnd.jupyter.widget-view+json`, rather than a key of some data
 * with a slash, like `2024/01`.
 */
export function isKnownMimeType(mimeType: string): boolean {
  return (
    KNOWN_MIME_TYPES.has(mimeType) ||
    /^(?:(?:text|image|application)\/vnd\.[\w.+-]+|application\/[\w.-]+\+json)$/.test(
      mimeType
    )
  );
}

/**
 * The limits of the JSON trees of the outputs.
 */
export interface IJsonTreeLimits {
  /**
   * The maximum number of values in the tree, besides its arrays and
   * objects, 10,000 by default.
   */
  maxNodes: number;

  /**
   * The maximum length of the JSON text of the tree, about its size in
   * bytes, 1,000,000 by default.
   */
  maxLength: number;
}

/**
 * The default limits of the JSON trees.
 */
export const JSON_TREE_LIMITS: IJsonTreeLimits = {
  maxNodes: 10000,
  maxLength: 1000000
};

/**
 * The maximum nesting of the JSON trees.
 */
const MAX_JSON_DEPTH = 100;

/**
 * Thrown while building a JSON tree, when the value has no faithful one.
 */
const NO_JSON_TREE = Symbol('NoJsonTree');

/**
 * Convert a value to the data of the JSON tree of an output, or undefined
 * when JSON can not show it as it is, so that the output only has its text.
 *
 * Unlike `JSON.parse(JSON.stringify(value))`, which turns NaN, Infinity and
 * undefined into null and drops the functions, the tree is undefined when
 * the value has one of them, or a symbol, a BigInt, a hole in an array, a
 * cycle, an object which is not plain and has no own enumerable keys, like a
 * Blob or a class instance with only private fields, or an object of the
 * host APIs, with native getters, like an Event. It is also
 * undefined when it is larger than the limits, so that a large array is not
 * saved in full in the notebook. Dates are shown as ISO strings, maps with
 * string keys as objects and sets as arrays. The tree is made of new objects
 * and arrays, which can be sent whatever the realm of the value.
 */
export function toJsonTree(
  value: unknown,
  limits: Partial<IJsonTreeLimits> = {}
): unknown {
  const { maxNodes, maxLength } = { ...JSON_TREE_LIMITS, ...limits };
  let nodes = 0;
  let length = 0;
  const ancestors: unknown[] = [];

  const omit = (): never => {
    throw NO_JSON_TREE;
  };
  const count = (size: number, items = 1) => {
    nodes += items;
    length += size;
    if (nodes > maxNodes || length > maxLength) {
      omit();
    }
  };
  const setKey = (object: object, key: string, item: unknown) => {
    // Defined rather than assigned, for keys like __proto__
    Object.defineProperty(object, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true
    });
    count(key.length + 4, 0);
  };

  const walk = (item: any): unknown => {
    switch (typeof item) {
      case 'string':
        count(item.length + 2);
        return item;
      case 'boolean':
        count(5);
        return item;
      case 'number':
        if (!Number.isFinite(item)) {
          omit();
        }
        count(String(item).length);
        return item;
      case 'object':
        break;
      default:
        // undefined, functions, symbols and BigInt
        return omit();
    }
    if (item === null) {
      count(4);
      return null;
    }
    if (ancestors.length >= MAX_JSON_DEPTH || ancestors.includes(item)) {
      omit();
    }
    // The arrays and the objects are not counted as values
    count(2, 0);
    ancestors.push(item);
    try {
      return walkObject(item);
    } finally {
      ancestors.pop();
    }
  };

  const walkObject = (item: any): unknown => {
    if (isDate(item)) {
      const time = Date.prototype.getTime.call(item);
      return Number.isNaN(time)
        ? omit()
        : walk(Date.prototype.toISOString.call(item));
    }
    if (isMap(item)) {
      const result = {};
      for (const [key, entry] of Map.prototype.entries.call(item)) {
        if (typeof key !== 'string') {
          omit();
        }
        setKey(result, key, walk(entry));
      }
      return result;
    }
    if (isSet(item)) {
      return Array.from(Set.prototype.values.call(item), walk);
    }
    if (
      isError(item) ||
      isRegExp(item) ||
      isBoxedPrimitive(item) ||
      ArrayBuffer.isView(item) ||
      isArrayBuffer(item) ||
      isModuleNamespace(item) ||
      isDomNode(item)
    ) {
      omit();
    }
    if (
      Object.getOwnPropertySymbols(item).some(symbol =>
        Object.prototype.propertyIsEnumerable.call(item, symbol)
      )
    ) {
      omit();
    }
    if (Array.isArray(item)) {
      // Check the length first, to not list the keys of a huge array
      if (item.length > maxNodes || Object.keys(item).length !== item.length) {
        // Holes, and other keys like the index of a RegExp match
        omit();
      }
      return Array.from(item, walk);
    }
    const keys = Object.keys(item);
    if (
      !isPlainObject(item) &&
      (keys.length === 0 || nativeGetterNames(item).length > 0)
    ) {
      // A Promise, a Blob, a class instance with private fields, an Event
      // whose state is in its getters...
      omit();
    }
    if (keys.length > maxNodes) {
      omit();
    }
    const result = {};
    for (const key of keys) {
      setKey(result, key, walk(item[key]));
    }
    return result;
  };

  try {
    return walk(value);
  } catch {
    // No faithful tree, or a getter or a proxy which throws
    return undefined;
  }
}

/**
 * Normalize a MIME bundle given by the user: binary data is encoded in
 * base64, and the values of the non-JSON types are converted to strings.
 */
export function normalizeBundle(bundle: unknown): IMimeBundle {
  if (bundle === null || typeof bundle !== 'object') {
    throw new TypeError(
      'A MIME bundle must be an object mapping MIME types to data'
    );
  }
  const data: IMimeBundle = {};
  for (const [mimeType, content] of Object.entries(bundle)) {
    if (content === undefined) {
      continue;
    }
    const bytes = toBytes(content);
    if (bytes !== null) {
      data[mimeType] = bytesToBase64(bytes);
    } else if (isJsonMimeType(mimeType)) {
      data[mimeType] = content as any;
    } else {
      data[mimeType] = String(content);
    }
  }
  return data;
}

/**
 * The MIME type of the Vega 5 charts.
 */
const VEGA_MIME_TYPE = 'application/vnd.vega.v5+json';

/**
 * The MIME type of the Vega-Lite 5 charts.
 */
const VEGA_LITE_MIME_TYPE = 'application/vnd.vegalite.v5+json';

const VEGA_LITE_SCHEMA =
  /^https?:\/\/vega\.github\.io\/schema\/vega-lite\/v(\d+)(?:\.[\w.-]*)?\.json$/;
const VEGA_SCHEMA =
  /^https?:\/\/vega\.github\.io\/schema\/vega\/v(\d+)(?:\.[\w.-]*)?\.json$/;

/**
 * The MIME type of a chart spec, from its `$schema`, like
 * `application/vnd.vegalite.v5+json` for
 * `https://vega.github.io/schema/vega-lite/v5.json`, or null when it is not
 * a version JupyterLab renders: Vega-Lite 3 to 5, and Vega 5.
 */
export function chartMimeType(spec: unknown): string | null {
  if (typeof spec !== 'object' || spec === null) {
    return null;
  }
  const schema = safe(() => (spec as Record<string, unknown>).$schema);
  if (typeof schema !== 'string') {
    return null;
  }
  const lite = VEGA_LITE_SCHEMA.exec(schema);
  if (lite && Number(lite[1]) >= 3 && Number(lite[1]) <= 5) {
    return `application/vnd.vegalite.v${lite[1]}+json`;
  }
  return VEGA_SCHEMA.exec(schema)?.[1] === '5' ? VEGA_MIME_TYPE : null;
}

/**
 * The MIME bundle of a plain object which is a Vega-Lite or a Vega spec,
 * with a `$schema` of a version JupyterLab renders, or null: the result of
 * a cell which is a chart spec shows the chart.
 */
export function chartBundle(spec: unknown): IMimeBundle | null {
  const mimeType = isPlainObject(spec) ? chartMimeType(spec) : null;
  if (!mimeType) {
    return null;
  }
  const data = safe(() => chartJson(spec), undefined);
  return data === undefined
    ? null
    : { [mimeType]: data, 'text/plain': chartText(mimeType) };
}

/**
 * The JSON data of a chart spec, like JSON.stringify() makes it: the dates
 * of the data are ISO strings, which Vega parses.
 */
function chartJson(spec: unknown): any {
  return JSON.parse(JSON.stringify(spec));
}

/**
 * The plain text of a chart.
 */
function chartText(mimeType: string): string {
  return mimeType === VEGA_MIME_TYPE ? '<Vega chart>' : '<Vega-Lite chart>';
}

/**
 * The MIME bundle of an image encoded by encodeImage(): its base64 data,
 * or the source of an SVG image, with a short description as plain text.
 */
export function imageBundle(image: IEncodedImage): IMimeBundle {
  return {
    [image.mimeType]:
      image.mimeType === 'image/svg+xml'
        ? decodeUtf8(image.bytes)
        : bytesToBase64(image.bytes),
    'text/plain': image.description
  };
}

/**
 * The output of a value which the host encodes asynchronously, like an
 * OffscreenCanvas, or undefined.
 */
function encodedOutput(
  host: IDisplayHost,
  value: unknown,
  metadata: Record<string, unknown>
): Promise<IDisplayData> | undefined {
  return (
    host
      .encodeImage?.(value)
      ?.then(image => ({ data: imageBundle(image), metadata })) ?? undefined
  );
}

let displayCount = 0;

function newDisplayId(): string {
  displayCount++;
  const random = Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, '0');
  return `display-${random}-${displayCount}`;
}

/**
 * A handle on the outputs of a display id, to update them.
 */
export class DisplayHandle {
  /**
   * @param format - The MIME bundle of the values given to the handle, like
   * the HTML of a string for display.html(), or undefined to show a value
   * like display() does.
   */
  constructor(
    host: IDisplayHost,
    id: string,
    format?: (value: unknown) => IMimeBundle | undefined
  ) {
    this.id = id;
    // Not enumerable, so that the handle shows only its id
    Object.defineProperties(this, {
      _host: { value: host },
      _format: { value: format }
    });
  }

  /**
   * The display id.
   */
  readonly id: string;

  /**
   * Show a value in a new output, updated with the other outputs of this
   * handle.
   */
  display(value: unknown, options: IDisplayOptions = {}): void {
    this._publish(value, options, false);
  }

  /**
   * Replace the content of the outputs of this handle.
   */
  update(value: unknown, options: IDisplayOptions = {}): void {
    this._publish(value, options, true);
  }

  private _publish(
    value: unknown,
    options: IDisplayOptions,
    update: boolean
  ): void {
    const metadata = options.metadata ?? {};
    let data = options.raw ? normalizeBundle(value) : this._format?.(value);
    let ready: Promise<IDisplayData> | undefined;
    if (!data) {
      data = this._host.mimeBundle(value, { live: options.live });
      ready = encodedOutput(this._host, value, metadata);
    }
    this._host.publish(data, metadata, { display_id: this.id }, update, ready);
  }

  private _host!: IDisplayHost;
  private _format?: (value: unknown) => IMimeBundle | undefined;
}

/**
 * Create the display() function of a kernel.
 */
export function createDisplay(host: IDisplayHost): IDisplay {
  const show = (
    value: unknown,
    options: IDisplayOptions & {
      format?: (value: unknown) => IMimeBundle | undefined;
      ready?: Promise<IDisplayData>;
    } = {}
  ): DisplayHandle | undefined => {
    let id: string | undefined;
    if (options.id === true) {
      id = newDisplayId();
    } else if (options.id !== undefined && options.id !== false) {
      id = String(options.id);
    }
    const metadata = options.metadata ?? {};
    const data = options.raw
      ? normalizeBundle(value)
      : host.mimeBundle(value, { live: options.live });
    const ready = options.raw
      ? options.ready
      : encodedOutput(host, value, metadata);
    host.publish(data, metadata, id ? { display_id: id } : {}, false, ready);
    return id ? new DisplayHandle(host, id, options.format) : undefined;
  };

  const display = ((value: unknown, options: IDisplayOptions = {}) =>
    show(value, options)) as IDisplay;

  // Helpers accepting a string, or a tagged template like display.html`<b>${x}</b>`.
  // Like with String.raw, the backslashes of templates are kept, for LaTeX.
  const templateContent = (
    content: string | TemplateStringsArray,
    values: unknown[]
  ): { text: string; options: IDisplayOptions } => {
    if (Array.isArray(content) && Array.isArray((content as any).raw)) {
      const raw = (content as TemplateStringsArray).raw;
      let text = raw[0];
      for (let i = 0; i < values.length; i++) {
        text += String(values[i]) + raw[i + 1];
      }
      return { text, options: {} };
    }
    return {
      text: String(content),
      options: (values[0] as IDisplayOptions) ?? {}
    };
  };

  const mimeHelper =
    (mimeType: string, description: string) =>
    (
      content: string | TemplateStringsArray,
      ...rest: unknown[]
    ): DisplayHandle | undefined => {
      const format = (value: unknown): IMimeBundle | undefined => {
        if (typeof value !== 'string') {
          return undefined;
        }
        const data: IMimeBundle = { [mimeType]: value };
        if (mimeType !== 'text/plain') {
          data['text/plain'] = `<${description}>`;
        }
        return data;
      };
      const { text, options } = templateContent(content, rest);
      return show(format(text), { ...options, raw: true, format });
    };

  const chartHelper =
    (lite: boolean) =>
    (
      spec: unknown,
      options: IDisplayOptions = {}
    ): DisplayHandle | undefined => {
      const format = (value: unknown): IMimeBundle | undefined => {
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value)
        ) {
          return undefined;
        }
        const detected = chartMimeType(value);
        let mimeType = lite ? VEGA_LITE_MIME_TYPE : VEGA_MIME_TYPE;
        if (lite && detected && detected !== VEGA_MIME_TYPE) {
          // Vega-Lite 3 and 4
          mimeType = detected;
        }
        return {
          [mimeType]: chartJson(value),
          'text/plain': chartText(mimeType)
        };
      };
      const data = format(spec);
      if (!data) {
        throw new TypeError(
          lite
            ? "A Vega-Lite spec must be an object, like { mark: 'bar', data: { values: [...] }, encoding: { ... } }"
            : 'A Vega spec must be an object'
        );
      }
      return show(data, { ...options, raw: true, format });
    };

  const imageHelper =
    (mimeType: string) =>
    (
      content: unknown,
      options: IImageOptions = {}
    ): DisplayHandle | undefined => {
      const withSize = (type: string): Record<string, unknown> => {
        const metadata: Record<string, unknown> = { ...options.metadata };
        if (options.width || options.height) {
          const size: Record<string, unknown> = {};
          if (options.width) {
            size.width = options.width;
          }
          if (options.height) {
            size.height = options.height;
          }
          metadata[type] = size;
        }
        return metadata;
      };
      // A Blob, an OffscreenCanvas, an ImageBitmap or an ImageData
      const encoded = host.encodeImage?.(content, mimeType);
      if (encoded) {
        return show(host.mimeBundle(content), {
          ...options,
          raw: true,
          metadata: withSize(mimeType),
          ready: encoded.then(image => ({
            data: imageBundle(image),
            metadata: withSize(image.mimeType)
          }))
        });
      }
      const bytes = toBytes(content);
      const data = bytes !== null ? bytesToBase64(bytes) : String(content);
      return show(
        { [mimeType]: data, 'text/plain': `<${mimeType} image>` },
        { ...options, raw: true, metadata: withSize(mimeType) }
      );
    };

  display.html = setDoc(
    mimeHelper('text/html', 'HTML'),
    'Displays HTML.\n\ndisplay.html(content, options?) or display.html`<b>${value}</b>`'
  );
  display.markdown = setDoc(
    mimeHelper('text/markdown', 'Markdown'),
    'Displays Markdown.\n\ndisplay.markdown(content, options?) or display.markdown`# ${title}`'
  );
  display.svg = setDoc(
    mimeHelper('image/svg+xml', 'SVG'),
    'Displays an SVG image from its source.\n\ndisplay.svg(content, options?)'
  );
  display.latex = setDoc(
    mimeHelper('text/latex', 'LaTeX'),
    'Displays LaTeX, for example display.latex("$e^{i\\\\pi} + 1 = 0$").'
  );
  display.text = setDoc(
    mimeHelper('text/plain', 'text'),
    'Displays plain text.\n\ndisplay.text(content, options?)'
  );
  display.json = setDoc(
    (content: unknown, options: IDisplayOptions = {}) =>
      show(
        {
          'application/json': toJsonTree(content),
          'text/plain': inspect(content)
        },
        { ...options, raw: true }
      ),
    'Displays JSON data as an interactive tree.\n\ndisplay.json(value, options?)\n\n' +
      'The values JSON can not show as they are, like NaN or undefined, and the large\n' +
      'ones, more than 10,000 values or 1 MB, are shown as text.'
  );
  display.vegalite = setDoc(
    chartHelper(true),
    'Displays a Vega-Lite chart from its spec.\n\n' +
      'display.vegalite(spec, options?)\n\n' +
      '    display.vegalite({\n' +
      "      data: { values: [{ a: 'A', b: 3 }, { a: 'B', b: 5 }] },\n" +
      "      mark: 'bar',\n" +
      "      encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } }\n" +
      '    });\n\n' +
      'A cell whose result is a spec with a Vega-Lite $schema shows the chart too.\n' +
      'See https://vega.github.io/vega-lite/examples/'
  );
  display.vega = setDoc(
    chartHelper(false),
    'Displays a Vega chart from its spec.\n\ndisplay.vega(spec, options?)\n\n' +
      'See https://vega.github.io/vega/examples/'
  );
  display.mermaid = setDoc(
    mimeHelper('text/vnd.mermaid', 'Mermaid diagram'),
    'Displays a Mermaid diagram from its source.\n\n' +
      'display.mermaid(source, options?) or display.mermaid`graph LR; A-->B`\n\n' +
      'See https://mermaid.js.org/intro/'
  );
  display.png = setDoc(
    imageHelper('image/png'),
    'Displays a PNG image from its bytes (Uint8Array, ArrayBuffer), base64 data, a Blob,\n' +
      'an OffscreenCanvas, an ImageBitmap or an ImageData.\n\n' +
      'display.png(data, { width?, height? })'
  );
  display.jpeg = setDoc(
    imageHelper('image/jpeg'),
    'Displays a JPEG image from its bytes (Uint8Array, ArrayBuffer), base64 data, a Blob,\n' +
      'an OffscreenCanvas, an ImageBitmap or an ImageData.\n\n' +
      'display.jpeg(data, { width?, height? })'
  );
  if (host.readFile) {
    const readFile = host.readFile;
    display.image = setDoc(
      (path: string, options: IImageOptions & { type?: string } = {}) => {
        const extension = String(path).split('.').pop()!.toLowerCase();
        const mimeType = options.type || IMAGE_TYPES[extension];
        if (!mimeType) {
          throw new TypeError(
            `Unknown image type for '${path}', pass it with the type option`
          );
        }
        const bytes = readFile(String(path));
        if (mimeType === 'image/svg+xml') {
          return display.svg(decodeUtf8(bytes), options);
        }
        return imageHelper(mimeType)(bytes, options);
      },
      'Displays an image file.\n\ndisplay.image(path, { width?, height?, type? })'
    );
  }
  display.mime = setDoc(
    (bundle: Record<string, unknown>, options: IDisplayOptions = {}) =>
      show(bundle, { ...options, raw: true }),
    'Displays a MIME bundle, an object mapping MIME types to data.\n\n' +
      'display.mime({ "text/html": "<b>Hi</b>", "text/plain": "Hi" }, options?)'
  );
  display.clear = setDoc(
    (wait = false) => host.clear(Boolean(wait)),
    'Clears the outputs of the cell. With wait=true, waits for the next output to clear them.'
  );

  return setDoc(
    display,
    'Displays a value with its richest representation.\n\n' +
      'display(value, { id?, metadata?, live? })\n\n' +
      'A DOM element is shown live in JavaScript (IFrame): it keeps its event listeners\n' +
      'and its later changes. With { live: false }, a snapshot of its HTML is shown.\n\n' +
      'An OffscreenCanvas, an ImageBitmap, an ImageData or a Blob of an image is shown as an\n' +
      'image, and a Vega-Lite spec with a $schema as a chart.\n\n' +
      'Objects can define _toHtml(), _toMarkdown(), _toSvg(), _toPng(), _toJpeg(), _toLatex(),\n' +
      '_toJson() or _toMime() methods, or a [Symbol.for("Jupyter.display")]() method returning\n' +
      'a MIME bundle. With { id: true } (or a string), returns a handle to update the output:\n\n' +
      '    const handle = display("Loading...", { id: true });\n' +
      '    handle.update("Done!");\n\n' +
      'See also display.html, display.markdown, display.svg, display.png, display.latex,\n' +
      'display.json, display.vegalite, display.vega, display.mermaid, display.mime and\n' +
      'display.clear.'
  );
}
