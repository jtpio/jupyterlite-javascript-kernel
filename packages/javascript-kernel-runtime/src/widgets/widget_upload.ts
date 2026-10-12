// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { isDate } from '../inspect';
import { isPlainObject } from '../utils';

import { DOMWidget } from './widget_dom';
import { ButtonStyle } from './widget_style';

/**
 * A file picked with a `FileUpload`.
 */
export interface IUploadedFile {
  /**
   * The name of the file, like `data.csv`.
   */
  name: string;

  /**
   * The MIME type of the file, like `text/csv`, or an empty string when the
   * browser does not know it.
   */
  type: string;

  /**
   * The size of the file, in bytes.
   */
  size: number;

  /**
   * The date of the last change of the file.
   */
  last_modified: Date;

  /**
   * The bytes of the file.
   */
  content: Uint8Array;
}

/**
 * A button picking files, whose names and contents are sent to the kernel,
 * like `new FileUpload({ accept: '.csv' })`: its value is the list of the
 * picked files, with their bytes in `content`.
 */
export class FileUpload extends DOMWidget {
  static override modelName = 'FileUploadModel';
  static override viewName = 'FileUploadView';
  static override styleClass = ButtonStyle;

  protected override _defaults() {
    return {
      ...super._defaults(),
      description: 'Upload',
      accept: '',
      multiple: false,
      icon: 'upload',
      button_style: '',
      error: '',
      value: []
    };
  }

  /**
   * The picked files: the last ones picked in the page, or set from the
   * kernel, like `[]` to forget them.
   */
  get value(): IUploadedFile[] {
    return this.get('value') as IUploadedFile[];
  }
  set value(v: Array<Partial<IUploadedFile>>) {
    this.set('value', v);
  }

  /**
   * The types of the files to pick, like `.csv,.txt` or `image/*`, or an
   * empty string for all the files.
   */
  get accept(): string {
    return this.get('accept') as string;
  }
  set accept(v: string) {
    this.set('accept', v);
  }

  /**
   * Whether several files can be picked at once.
   */
  get multiple(): boolean {
    return this.get('multiple') as boolean;
  }
  set multiple(v: boolean) {
    this.set('multiple', v);
  }

  get icon(): string {
    return this.get('icon') as string;
  }
  set icon(v: string) {
    this.set('icon', v);
  }
  get button_style(): string {
    return this.get('button_style') as string;
  }
  set button_style(v: string) {
    this.set('button_style', v);
  }

  /**
   * The error of the last upload, if any.
   */
  get error(): string {
    return this.get('error') as string;
  }
  set error(v: string) {
    this.set('error', v);
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    super._validate(state, names);
    const value = state.value;
    if (!Array.isArray(value)) {
      throw new TypeError('The value of a FileUpload must be a list of files');
    }
    const files = value.map(file => this._toFile(file));
    // Keep the same list when it does not change, to not sync it again
    if (files.some((file, i) => file !== value[i])) {
      state.value = files;
    }
  }

  protected override _serializeProperty(name: string, value: unknown): unknown {
    if (name === 'value' && Array.isArray(value)) {
      // The contents are sent as buffers, at ['value', i, 'content']
      return (value as IUploadedFile[]).map(file => ({
        name: file.name,
        type: file.type,
        size: file.size,
        content: file.content,
        last_modified: file.last_modified.getTime()
      }));
    }
    return super._serializeProperty(name, value);
  }

  protected override _deserializeProperty(
    name: string,
    value: unknown
  ): unknown {
    if (name === 'value' && Array.isArray(value)) {
      const RealmDate = this._manager.realmConstructor('Date');
      return value.map(file =>
        isPlainObject(file)
          ? {
              name: file.name,
              type: file.type,
              size: file.size,
              last_modified: new RealmDate(Number(file.last_modified)),
              content: file.content
            }
          : file
      );
    }
    return super._deserializeProperty(name, value);
  }

  /**
   * A file of the value, with all its properties: the file itself when it
   * has them, or a new one.
   */
  private _toFile(file: unknown): IUploadedFile {
    if (!isPlainObject(file)) {
      throw new TypeError(
        'The files of a FileUpload must be objects, like { name, type, size, last_modified, content }'
      );
    }
    const given = file as Record<string, unknown>;
    const content = this._toBytes(given.content ?? new Uint8Array(0));
    if (content === null) {
      throw new TypeError(
        'The content of a file of a FileUpload must be bytes: a Uint8Array, an ArrayBuffer or a typed array'
      );
    }
    const lastModified = given.last_modified ?? Date.now();
    const RealmDate = this._manager.realmConstructor('Date');
    const normalized: IUploadedFile = {
      name: String(given.name ?? ''),
      type: String(given.type ?? ''),
      size: Number(given.size ?? content.byteLength),
      last_modified: isDate(lastModified)
        ? lastModified
        : new RealmDate(lastModified as number | string),
      content
    };
    const unchanged = (
      Object.keys(normalized) as Array<keyof IUploadedFile>
    ).every(key => normalized[key] === given[key]);
    return unchanged ? (given as unknown as IUploadedFile) : normalized;
  }
}
