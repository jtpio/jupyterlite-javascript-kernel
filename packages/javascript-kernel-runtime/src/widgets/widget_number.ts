// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget } from './widget_dom';
import { DescriptionStyle, ProgressStyle, SliderStyle } from './widget_style';

/**
 * A number of the state of a numeric widget, like the `CInt` and `CFloat`
 * traits of ipywidgets: a number, a bigint or a numeric string, rounded for
 * the integer widgets.
 *
 * @internal
 */
export function _toNumber(
  name: string,
  value: unknown,
  integer: boolean
): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint' ||
          (typeof value === 'string' && value.trim() !== '')
        ? Number(value)
        : NaN;
  if (Number.isNaN(number) || (integer && !Number.isFinite(number))) {
    throw new TypeError(
      `The ${name} of the widget must be ${integer ? 'an integer' : 'a number'}`
    );
  }
  return integer ? Math.round(number) : number;
}

/**
 * Validate the bounds and the value of a bounded numeric widget, like
 * ipywidgets: throw a RangeError when min > max, and clamp the value to the
 * bounds, also when they change.
 *
 * @param bounds - The bounds of the value from min and max, like the powers
 * of the base of a log slider.
 *
 * @internal
 */
export function _validateBounded(
  state: Record<string, unknown>,
  names: ReadonlySet<string>,
  integer: boolean,
  bounds: (min: number, max: number) => [number, number] = (min, max) => [
    min,
    max
  ]
): void {
  const [min, max] = validateMinMax(state, names, integer);
  const [lower, upper] = bounds(min, max);
  const value = _toNumber('value', state.value, integer);
  state.value = Math.min(Math.max(value, lower), upper);
}

/**
 * Validate the bounds and the value of a range slider, like ipywidgets:
 * throw a RangeError when min > max or lower > upper, and clamp the lower
 * and upper values to the bounds.
 *
 * @internal
 */
export function _validateRange(
  state: Record<string, unknown>,
  names: ReadonlySet<string>,
  integer: boolean
): void {
  const [min, max] = validateMinMax(state, names, integer);
  const value = state.value;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(
      'The value of a range slider must be a pair [lower, upper]'
    );
  }
  const [lower, upper] = value.map(item => _toNumber('value', item, integer));
  if (lower > upper) {
    throw new RangeError(`setting lower > upper (${lower} > ${upper})`);
  }
  const clamp = (item: number) => Math.min(Math.max(item, min), max);
  // Keep the same array when it does not change, to not sync it again
  if (clamp(lower) !== value[0] || clamp(upper) !== value[1]) {
    state.value = [clamp(lower), clamp(upper)];
  }
}

/**
 * Coerce the step of a numeric widget, which can be null.
 */
function validateStep(state: Record<string, unknown>, integer: boolean): void {
  if (state.step !== null && state.step !== undefined) {
    state.step = _toNumber('step', state.step, integer);
  }
}

/**
 * Coerce the min and the max of a numeric widget, and throw a RangeError
 * when min > max.
 */
function validateMinMax(
  state: Record<string, unknown>,
  names: ReadonlySet<string>,
  integer: boolean
): [number, number] {
  const min = _toNumber('min', state.min, integer);
  const max = _toNumber('max', state.max, integer);
  if (min > max) {
    throw new RangeError(
      names.has('max') && !names.has('min')
        ? `setting max < min (${max} < ${min})`
        : `setting min > max (${min} > ${max})`
    );
  }
  state.min = min;
  state.max = max;
  validateStep(state, integer);
  return [min, max];
}

export class _SliderBase extends DOMWidget {
  static override styleClass = SliderStyle;

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      orientation: 'horizontal',
      readout: true,
      continuous_update: true,
      behavior: 'drag-tap'
    };
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    _validateBounded(state, names, this._integer, (min, max) =>
      this._valueBounds(min, max, state)
    );
    super._validate(state, names);
  }

  /**
   * Whether the values of the widget are integers.
   */
  protected get _integer(): boolean {
    return false;
  }

  /**
   * The bounds of the value, from min and max.
   */
  protected _valueBounds(
    min: number,
    max: number,
    _state: Record<string, unknown>
  ): [number, number] {
    return [min, max];
  }

  get value(): number {
    return this.get('value') as number;
  }
  set value(v: number) {
    this.set('value', v);
  }
  get min(): number {
    return this.get('min') as number;
  }
  set min(v: number) {
    this.set('min', v);
  }
  get max(): number {
    return this.get('max') as number;
  }
  set max(v: number) {
    this.set('max', v);
  }
  get step(): number {
    return this.get('step') as number;
  }
  set step(v: number) {
    this.set('step', v);
  }
  get orientation(): string {
    return this.get('orientation') as string;
  }
  set orientation(v: string) {
    this.set('orientation', v);
  }
  get readout(): boolean {
    return this.get('readout') as boolean;
  }
  set readout(v: boolean) {
    this.set('readout', v);
  }
  get continuous_update(): boolean {
    return this.get('continuous_update') as boolean;
  }
  set continuous_update(v: boolean) {
    this.set('continuous_update', v);
  }
  get behavior(): string {
    return this.get('behavior') as string;
  }
  set behavior(v: string) {
    this.set('behavior', v);
  }
}

export class _RangeSliderBase extends DOMWidget {
  static override styleClass = SliderStyle;

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: [0, 1],
      min: 0,
      max: 100,
      step: 1,
      orientation: 'horizontal',
      readout: true,
      continuous_update: true,
      behavior: 'drag-tap'
    };
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    _validateRange(state, names, this._integer);
    super._validate(state, names);
  }

  /**
   * Whether the values of the widget are integers.
   */
  protected get _integer(): boolean {
    return false;
  }

  get value(): [number, number] {
    return this.get('value') as [number, number];
  }
  set value(v: [number, number]) {
    this.set('value', v);
  }
  get lower(): number {
    return this.value[0];
  }
  set lower(v: number) {
    this.value = [v, this.value[1]];
  }
  get upper(): number {
    return this.value[1];
  }
  set upper(v: number) {
    this.value = [this.value[0], v];
  }
  get min(): number {
    return this.get('min') as number;
  }
  set min(v: number) {
    this.set('min', v);
  }
  get max(): number {
    return this.get('max') as number;
  }
  set max(v: number) {
    this.set('max', v);
  }
  get step(): number {
    return this.get('step') as number;
  }
  set step(v: number) {
    this.set('step', v);
  }
  get orientation(): string {
    return this.get('orientation') as string;
  }
  set orientation(v: string) {
    this.set('orientation', v);
  }
  get readout(): boolean {
    return this.get('readout') as boolean;
  }
  set readout(v: boolean) {
    this.set('readout', v);
  }
  get continuous_update(): boolean {
    return this.get('continuous_update') as boolean;
  }
  set continuous_update(v: boolean) {
    this.set('continuous_update', v);
  }
  get behavior(): string {
    return this.get('behavior') as string;
  }
  set behavior(v: string) {
    this.set('behavior', v);
  }
}

export class _ProgressBase extends DOMWidget {
  static override styleClass = ProgressStyle;

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      min: 0,
      max: 100,
      bar_style: '',
      orientation: 'horizontal'
    };
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    _validateBounded(state, names, this._integer);
    super._validate(state, names);
  }

  /**
   * Whether the values of the widget are integers.
   */
  protected get _integer(): boolean {
    return false;
  }

  get value(): number {
    return this.get('value') as number;
  }
  set value(v: number) {
    this.set('value', v);
  }
  get min(): number {
    return this.get('min') as number;
  }
  set min(v: number) {
    this.set('min', v);
  }
  get max(): number {
    return this.get('max') as number;
  }
  set max(v: number) {
    this.set('max', v);
  }
  get bar_style(): string {
    return this.get('bar_style') as string;
  }
  set bar_style(v: string) {
    this.set('bar_style', v);
  }
  get orientation(): string {
    return this.get('orientation') as string;
  }
  set orientation(v: string) {
    this.set('orientation', v);
  }
}

export class _NumericTextBase extends DOMWidget {
  static override styleClass = DescriptionStyle;

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      step: 1,
      continuous_update: false
    };
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    state.value = _toNumber('value', state.value, this._integer);
    validateStep(state, this._integer);
    super._validate(state, names);
  }

  /**
   * Whether the values of the widget are integers.
   */
  protected get _integer(): boolean {
    return false;
  }

  get value(): number {
    return this.get('value') as number;
  }
  set value(v: number) {
    this.set('value', v);
  }
  get step(): number {
    return this.get('step') as number;
  }
  set step(v: number) {
    this.set('step', v);
  }
  get continuous_update(): boolean {
    return this.get('continuous_update') as boolean;
  }
  set continuous_update(v: boolean) {
    this.set('continuous_update', v);
  }
}
