// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget } from './widget';

/**
 * An image, from its bytes.
 */
export class Image extends DOMWidget {
  static override modelName = 'ImageModel';
  static override viewName = 'ImageView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: new Uint8Array(0),
      format: 'png',
      width: '',
      height: ''
    };
  }

  /**
   * The bytes of the image.
   */
  get value(): Uint8Array {
    return this.get('value') as Uint8Array;
  }
  set value(v: Uint8Array | ArrayBuffer) {
    this.set('value', v);
  }

  /**
   * The format of the image, like png, jpeg or svg+xml.
   */
  get format(): string {
    return this.get('format') as string;
  }
  set format(v: string) {
    this.set('format', v);
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
