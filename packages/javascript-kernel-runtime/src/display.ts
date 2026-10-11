// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { IMimeBundle } from '@jupyterlab/nbformat';

import { inspect } from './inspect';
import { setDoc } from './introspection';
import { bytesToBase64, toBytes } from './utils';

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
}

/**
 * Options of the image helpers.
 */
export interface IImageOptions extends IDisplayOptions {
  width?: number | string;
  height?: number | string;
}

/**
 * What display() needs from the kernel.
 */
export interface IDisplayHost {
  /**
   * Publish a display_data message, or an update_display_data message.
   */
  publish(
    data: IMimeBundle,
    metadata: Record<string, unknown>,
    transient: { display_id?: string },
    update: boolean
  ): void;

  /**
   * Clear the outputs of the cell.
   */
  clear(wait: boolean): void;

  /**
   * The MIME bundle of a value.
   */
  mimeBundle(value: unknown): IMimeBundle;

  /**
   * Read a file, for display.image(path). The helper is only available when
   * the kernel can read files.
   */
  readFile?(path: string): Uint8Array;
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
  constructor(
    host: IDisplayHost,
    id: string,
    mimeType?: string,
    placeholder?: string
  ) {
    this.id = id;
    // Not enumerable, so that the handle shows only its id
    Object.defineProperties(this, {
      _host: { value: host },
      _mimeType: { value: mimeType },
      _placeholder: { value: placeholder }
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
    let data: IMimeBundle;
    if (options.raw) {
      data = normalizeBundle(value);
    } else if (this._mimeType && typeof value === 'string') {
      data = {
        [this._mimeType]: value,
        'text/plain': this._placeholder || value
      };
    } else {
      data = this._host.mimeBundle(value);
    }
    this._host.publish(
      data,
      options.metadata ?? {},
      { display_id: this.id },
      update
    );
  }

  private _host!: IDisplayHost;
  private _mimeType?: string;
  private _placeholder?: string;
}

/**
 * Create the display() function of a kernel.
 */
export function createDisplay(host: IDisplayHost): IDisplay {
  const show = (
    value: unknown,
    options: IDisplayOptions & { mimeType?: string; placeholder?: string } = {}
  ): DisplayHandle | undefined => {
    let id: string | undefined;
    if (options.id === true) {
      id = newDisplayId();
    } else if (options.id !== undefined && options.id !== false) {
      id = String(options.id);
    }
    const data = options.raw ? normalizeBundle(value) : host.mimeBundle(value);
    host.publish(
      data,
      options.metadata ?? {},
      id ? { display_id: id } : {},
      false
    );
    return id
      ? new DisplayHandle(host, id, options.mimeType, options.placeholder)
      : undefined;
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
      const { text, options } = templateContent(content, rest);
      const placeholder =
        mimeType === 'text/plain' ? undefined : `<${description}>`;
      const data: Record<string, string> = { [mimeType]: text };
      if (placeholder) {
        data['text/plain'] = placeholder;
      }
      return show(data, { ...options, raw: true, mimeType, placeholder });
    };

  const imageHelper =
    (mimeType: string) =>
    (
      content: unknown,
      options: IImageOptions = {}
    ): DisplayHandle | undefined => {
      const bytes = toBytes(content);
      const data = bytes !== null ? bytesToBase64(bytes) : String(content);
      const metadata: Record<string, unknown> = { ...options.metadata };
      if (options.width || options.height) {
        const size: Record<string, unknown> = {};
        if (options.width) {
          size.width = options.width;
        }
        if (options.height) {
          size.height = options.height;
        }
        metadata[mimeType] = size;
      }
      return show(
        { [mimeType]: data, 'text/plain': `<${mimeType} image>` },
        { ...options, raw: true, metadata }
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
        { 'application/json': content, 'text/plain': inspect(content) },
        { ...options, raw: true }
      ),
    'Displays JSON data as an interactive tree.\n\ndisplay.json(value, options?)'
  );
  display.png = setDoc(
    imageHelper('image/png'),
    'Displays a PNG image from its bytes (Uint8Array, ArrayBuffer) or base64 data.\n\n' +
      'display.png(data, { width?, height? })'
  );
  display.jpeg = setDoc(
    imageHelper('image/jpeg'),
    'Displays a JPEG image from its bytes (Uint8Array, ArrayBuffer) or base64 data.\n\n' +
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
          return display.svg(new TextDecoder().decode(bytes), options);
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
      'display(value, { id?, metadata? })\n\n' +
      'Objects can define _toHtml(), _toMarkdown(), _toSvg(), _toPng(), _toJpeg(), _toLatex(),\n' +
      '_toJson() or _toMime() methods, or a [Symbol.for("Jupyter.display")]() method returning\n' +
      'a MIME bundle. With { id: true } (or a string), returns a handle to update the output:\n\n' +
      '    const handle = display("Loading...", { id: true });\n' +
      '    handle.update("Done!");\n\n' +
      'See also display.html, display.markdown, display.svg, display.png, display.latex,\n' +
      'display.json, display.mime and display.clear.'
  );
}
