// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { encodeUtf8 } from '../utils';

import { DOMWidget } from './widget_dom';

/**
 * The base class of the media widgets, `Image`, `Video` and `Audio`, shown
 * from their bytes, sent to the frontend as binary buffers.
 */
export class _Media extends DOMWidget {
  /**
   * Create a widget showing the media of a URL, like
   * `Video.fromUrl('https://example.com/movie.mp4')`: its value is the URL,
   * encoded in UTF-8, with the `url` format.
   */
  static fromUrl<T extends _Media>(
    this: new (state?: Record<string, unknown>) => T,
    url: string,
    state?: Record<string, unknown>
  ): T {
    return new this({
      ...state,
      value: encodeUtf8(String(url)),
      format: 'url'
    });
  }

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), value: new Uint8Array(0) };
  }

  /**
   * The bytes of the media, or the URL of the media, in UTF-8, with the
   * `url` format.
   */
  get value(): Uint8Array {
    return this.get('value') as Uint8Array;
  }
  set value(v: Uint8Array | ArrayBuffer | ArrayBufferView) {
    this.set('value', v);
  }

  /**
   * The format of the media, like png, mp4 or mp3, or url.
   */
  get format(): string {
    return this.get('format') as string;
  }
  set format(v: string) {
    this.set('format', v);
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    super._validate(state, names);
    // Like the CByteMemoryView trait of ipywidgets: the bytes of any binary
    // value, as a Uint8Array
    const bytes = this._toBytes(state.value);
    if (bytes === null) {
      throw new TypeError(
        'The value of a media widget must be bytes: a Uint8Array, an ArrayBuffer or a typed array'
      );
    }
    state.value = bytes;
  }
}

/**
 * An image, from its bytes.
 */
export class Image extends _Media {
  static override modelName = 'ImageModel';
  static override viewName = 'ImageView';

  protected override _defaults() {
    return { ...super._defaults(), format: 'png', width: '', height: '' };
  }

  get width(): string {
    return this.get('width') as string;
  }
  set width(v: string) {
    this.set('width', v);
  }

  get height(): string {
    return this.get('height') as string;
  }
  set height(v: string) {
    this.set('height', v);
  }
}

/**
 * A video, from its bytes, played in the page.
 */
export class Video extends _Media {
  static override modelName = 'VideoModel';
  static override viewName = 'VideoView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      format: 'mp4',
      width: '',
      height: '',
      autoplay: true,
      loop: true,
      controls: true
    };
  }

  get width(): string {
    return this.get('width') as string;
  }
  set width(v: string) {
    this.set('width', v);
  }

  get height(): string {
    return this.get('height') as string;
  }
  set height(v: string) {
    this.set('height', v);
  }

  /**
   * Whether the video starts when it is shown.
   */
  get autoplay(): boolean {
    return this.get('autoplay') as boolean;
  }
  set autoplay(v: boolean) {
    this.set('autoplay', v);
  }

  /**
   * Whether the video starts again after its end.
   */
  get loop(): boolean {
    return this.get('loop') as boolean;
  }
  set loop(v: boolean) {
    this.set('loop', v);
  }

  /**
   * Whether the controls of the video, like the play button, are shown.
   */
  get controls(): boolean {
    return this.get('controls') as boolean;
  }
  set controls(v: boolean) {
    this.set('controls', v);
  }
}

/**
 * An audio player, from the bytes of the sound.
 */
export class Audio extends _Media {
  static override modelName = 'AudioModel';
  static override viewName = 'AudioView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      format: 'mp3',
      autoplay: true,
      loop: true,
      controls: true
    };
  }

  /**
   * Whether the sound starts when the player is shown.
   */
  get autoplay(): boolean {
    return this.get('autoplay') as boolean;
  }
  set autoplay(v: boolean) {
    this.set('autoplay', v);
  }

  /**
   * Whether the sound starts again after its end.
   */
  get loop(): boolean {
    return this.get('loop') as boolean;
  }
  set loop(v: boolean) {
    this.set('loop', v);
  }

  /**
   * Whether the controls of the player, like the play button, are shown.
   */
  get controls(): boolean {
    return this.get('controls') as boolean;
  }
  set controls(v: boolean) {
    this.set('controls', v);
  }
}
