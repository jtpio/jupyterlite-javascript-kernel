// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget } from './widget_dom';
import { _toNumber } from './widget_number';
import { DescriptionStyle } from './widget_style';

/**
 * The base class of the inputs of a list of tags, typed in the page and
 * removed with their close button.
 */
export class _TagsInputBase<T> extends DOMWidget {
  static override styleClass = DescriptionStyle;

  protected override _defaults(): Record<string, unknown> {
    return {
      ...super._defaults(),
      value: [],
      placeholder: '\u200b',
      allowed_tags: [],
      allow_duplicates: true
    };
  }

  /**
   * The tags.
   */
  get value(): T[] {
    return this.get('value') as T[];
  }
  set value(v: T[]) {
    this.set('value', v);
  }

  get placeholder(): string {
    return this.get('placeholder') as string;
  }
  set placeholder(v: string) {
    this.set('placeholder', v);
  }

  /**
   * The tags which can be added, suggested while typing, or an empty list
   * for any tag.
   */
  get allowed_tags(): T[] {
    return this.get('allowed_tags') as T[];
  }
  set allowed_tags(v: T[]) {
    this.set('allowed_tags', v);
  }

  /**
   * Whether a tag can be added several times.
   */
  get allow_duplicates(): boolean {
    return this.get('allow_duplicates') as boolean;
  }
  set allow_duplicates(v: boolean) {
    this.set('allow_duplicates', v);
  }

  /**
   * Coerce a tag, or throw: the tag itself when it is valid.
   */
  protected _coerceTag(tag: unknown): T {
    if (typeof tag !== 'string') {
      throw new TypeError('The tags of a tags input must be strings');
    }
    if (tag === '') {
      throw new TypeError(
        'The value of a tags input cannot contain blank strings'
      );
    }
    return tag as T;
  }

  /**
   * Validate the tags, like ipywidgets, when the value is set: they must be
   * allowed, when there are allowed tags.
   */
  protected _validateTags(tags: T[], state: Record<string, unknown>): void {
    const allowed = state.allowed_tags as unknown[];
    if (allowed.length === 0) {
      return;
    }
    for (const tag of tags) {
      if (!allowed.includes(tag)) {
        throw new RangeError(
          `Tag value ${String(tag)} is not allowed, allowed tags are ${allowed.join(', ')}`
        );
      }
    }
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    super._validate(state, names);
    for (const name of ['allowed_tags', 'value']) {
      if (!Array.isArray(state[name])) {
        throw new TypeError(`The ${name} of a tags input must be a list`);
      }
    }
    if (!names.has('value')) {
      return;
    }
    const value = state.value as unknown[];
    const tags = value.map(tag => this._coerceTag(tag));
    this._validateTags(tags, state);
    // Keep the same list when it does not change, to not sync it again
    if (tags.some((tag, i) => tag !== value[i])) {
      state.value = tags;
    }
  }
}

/**
 * An input of a list of strings, like `new TagsInput({ value: ['red'] })`.
 */
export class TagsInput extends _TagsInputBase<string> {
  static override modelName = 'TagsInputModel';
  static override viewName = 'TagsInputView';

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), tag_style: '' };
  }

  /**
   * The style of the tags: 'primary', 'success', 'info', 'warning',
   * 'danger' or ''.
   */
  get tag_style(): string {
    return this.get('tag_style') as string;
  }
  set tag_style(v: string) {
    this.set('tag_style', v);
  }
}

/**
 * An input of a list of colors, shown with their color.
 */
export class ColorsInput extends _TagsInputBase<string> {
  static override modelName = 'ColorsInputModel';
  static override viewName = 'ColorsInputView';
}

/**
 * The base class of the inputs of a list of numbers, between `min` and
 * `max`, shown with their `format`.
 */
class _NumbersInputBase extends _TagsInputBase<number> {
  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), tag_style: '', min: null, max: null };
  }

  get tag_style(): string {
    return this.get('tag_style') as string;
  }
  set tag_style(v: string) {
    this.set('tag_style', v);
  }

  /**
   * The lowest number, or null for no bound.
   */
  get min(): number | null {
    return this.get('min') as number | null;
  }
  set min(v: number | null) {
    this.set('min', v);
  }

  /**
   * The highest number, or null for no bound.
   */
  get max(): number | null {
    return this.get('max') as number | null;
  }
  set max(v: number | null) {
    this.set('max', v);
  }

  /**
   * The format of the numbers, in the format of d3-format, like '.1f'.
   */
  get format(): string {
    return this.get('format') as string;
  }
  set format(v: string) {
    this.set('format', v);
  }

  /**
   * Whether the numbers are integers.
   */
  protected _isInteger(): boolean {
    return false;
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    for (const name of ['min', 'max']) {
      if (state[name] !== null) {
        state[name] = _toNumber(name, state[name], this._isInteger());
      }
    }
    super._validate(state, names);
  }

  protected override _coerceTag(tag: unknown): number {
    return _toNumber('tags', tag, this._isInteger());
  }

  protected override _validateTags(
    tags: number[],
    state: Record<string, unknown>
  ): void {
    super._validateTags(tags, state);
    const min = state.min as number | null;
    const max = state.max as number | null;
    for (const tag of tags) {
      if (min !== null && tag < min) {
        throw new RangeError(`Tag value ${tag} should be >= ${min}`);
      }
      if (max !== null && tag > max) {
        throw new RangeError(`Tag value ${tag} should be <= ${max}`);
      }
    }
  }
}

/**
 * An input of a list of floats.
 */
export class FloatsInput extends _NumbersInputBase {
  static override modelName = 'FloatsInputModel';
  static override viewName = 'FloatsInputView';

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), format: '.1f' };
  }
}

/**
 * An input of a list of integers.
 */
export class IntsInput extends _NumbersInputBase {
  static override modelName = 'IntsInputModel';
  static override viewName = 'IntsInputView';
  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), format: 'd' };
  }

  protected override _isInteger(): boolean {
    return true;
  }
}
