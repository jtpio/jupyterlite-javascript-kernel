// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { isDate } from '../inspect';
import { isPlainObject } from '../utils';

import { DOMWidget } from './widget_dom';
import { _toNumber } from './widget_number';
import { DescriptionStyle } from './widget_style';

/**
 * The base class of the date and time pickers: their `value`, `min` and
 * `max` are null or a value of the picker, kept in the bounds like
 * ipywidgets, and sent to the frontend as the fields of a date or a time.
 */
export class _PickerBase<T> extends DOMWidget {
  static override styleClass = DescriptionStyle;

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), value: null, min: null, max: null };
  }

  /**
   * The picked value, or null when nothing is picked.
   */
  get value(): T | null {
    return this.get('value') as T | null;
  }
  set value(v: T | string | number | null) {
    this.set('value', v);
  }

  /**
   * The lowest value which can be picked, or null for no bound.
   */
  get min(): T | null {
    return this.get('min') as T | null;
  }
  set min(v: T | string | number | null) {
    this.set('min', v);
  }

  /**
   * The highest value which can be picked, or null for no bound.
   */
  get max(): T | null {
    return this.get('max') as T | null;
  }
  set max(v: T | string | number | null) {
    this.set('max', v);
  }

  /**
   * Coerce a value of the picker, which is not null, or throw a TypeError:
   * the value itself when it is valid, so that it does not sync again.
   */
  protected _coerce(_name: string, value: unknown): T {
    return value as T;
  }

  /**
   * The number ordering a value of the picker, like the time of a date.
   */
  protected _order(_value: T): number {
    return 0;
  }

  /**
   * A copy of a value of the picker, like a bound becoming the value.
   */
  protected _copy(value: T): T {
    return value;
  }

  /**
   * The fields of a value of the picker for the frontend.
   */
  protected _toFields(_value: T): Record<string, number> {
    return {};
  }

  /**
   * A value of the picker from the fields of the frontend.
   */
  protected _fromFields(_fields: Record<string, number>): T {
    throw new Error('Not implemented');
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    super._validate(state, names);
    const [value, min, max] = (['value', 'min', 'max'] as const).map(name =>
      state[name] === null ? null : this._coerce(name, state[name])
    );
    // Like ipywidgets: the bounds must be in order, and the value between them
    if (min !== null && max !== null && this._order(min) > this._order(max)) {
      throw new RangeError(
        names.has('max') && !names.has('min')
          ? 'setting max < min'
          : 'setting min > max'
      );
    }
    let clamped = value;
    if (clamped !== null && min !== null) {
      if (this._order(clamped) < this._order(min)) {
        clamped = this._copy(min);
      }
    }
    if (clamped !== null && max !== null) {
      if (this._order(clamped) > this._order(max)) {
        clamped = this._copy(max);
      }
    }
    state.value = clamped;
    state.min = min;
    state.max = max;
  }

  protected override _serializeProperty(name: string, value: unknown): unknown {
    if (name === 'value' || name === 'min' || name === 'max') {
      return value === null ? null : this._toFields(value as T);
    }
    return super._serializeProperty(name, value);
  }

  protected override _deserializeProperty(
    name: string,
    value: unknown
  ): unknown {
    if (name === 'value' || name === 'min' || name === 'max') {
      return isPlainObject(value)
        ? this._fromFields(value as Record<string, number>)
        : null;
    }
    return super._deserializeProperty(name, value);
  }
}

/**
 * The base class of the pickers of dates.
 */
class _DateBase extends _PickerBase<Date> {
  protected override _coerce(name: string, value: unknown): Date {
    const date = isDate(value)
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new (this._manager.realmConstructor('Date'))(value)
        : null;
    if (date === null || Number.isNaN(date.getTime())) {
      throw new TypeError(
        `The ${name} of a date picker must be a date, like new Date('2024-05-01'), or null`
      );
    }
    return date;
  }

  protected override _order(value: Date): number {
    return value.getTime();
  }

  protected override _copy(value: Date): Date {
    return this._newDate(value.getTime());
  }

  /**
   * A new date of the realm of the cells, so that `instanceof Date` holds
   * there.
   */
  protected _newDate(time: number): Date {
    return new (this._manager.realmConstructor('Date'))(time);
  }
}

/**
 * A picker of a date, without the time, like ipywidgets: its value is the
 * date at midnight UTC, like `new Date('2024-05-01')`, so that
 * `picker.value.toISOString().slice(0, 10)` is the picked date. Another date
 * gives the date of its day in the time zone of the browser, like
 * `new Date()` for today.
 */
export class DatePicker extends _DateBase {
  static override modelName = 'DatePickerModel';
  static override viewName = 'DatePickerView';

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), step: 1 };
  }

  /**
   * The step of the picker, in days, or 'any'.
   */
  get step(): number | 'any' {
    return this.get('step') as number | 'any';
  }
  set step(v: number | 'any') {
    this.set('step', v);
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    state.step = validateStep(state.step, true);
    super._validate(state, names);
  }

  protected override _coerce(name: string, value: unknown): Date {
    const date = super._coerce(name, value);
    if (
      date.getUTCHours() === 0 &&
      date.getUTCMinutes() === 0 &&
      date.getUTCSeconds() === 0 &&
      date.getUTCMilliseconds() === 0
    ) {
      return date;
    }
    const day = this._newDate(0);
    day.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
    return day;
  }

  protected override _toFields(value: Date): Record<string, number> {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth(),
      date: value.getUTCDate()
    };
  }

  protected override _fromFields(fields: Record<string, number>): Date {
    const date = this._newDate(0);
    date.setUTCFullYear(fields.year, fields.month, fields.date);
    return date;
  }
}

/**
 * A picker of a date and a time, in the time zone of the browser.
 */
export class DatetimePicker extends _DateBase {
  static override modelName = 'DatetimeModel';
  static override viewName = 'DatetimeView';

  protected override _toFields(value: Date): Record<string, number> {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth(),
      date: value.getUTCDate(),
      hours: value.getUTCHours(),
      minutes: value.getUTCMinutes(),
      seconds: value.getUTCSeconds(),
      milliseconds: value.getUTCMilliseconds()
    };
  }

  protected override _fromFields(fields: Record<string, number>): Date {
    const date = this._newDate(0);
    date.setUTCFullYear(fields.year, fields.month, fields.date);
    date.setUTCHours(
      fields.hours,
      fields.minutes,
      fields.seconds,
      fields.milliseconds
    );
    return date;
  }
}

/**
 * A picker of a date and a time, sent to the frontend without a time zone,
 * like the naive datetimes of Python: its fields are the ones of the time
 * zone of the browser.
 */
export class NaiveDatetimePicker extends DatetimePicker {
  static override modelName = 'NaiveDatetimeModel';

  protected override _toFields(value: Date): Record<string, number> {
    return {
      year: value.getFullYear(),
      month: value.getMonth(),
      date: value.getDate(),
      hours: value.getHours(),
      minutes: value.getMinutes(),
      seconds: value.getSeconds(),
      milliseconds: value.getMilliseconds()
    };
  }

  protected override _fromFields(fields: Record<string, number>): Date {
    const date = this._newDate(0);
    date.setFullYear(fields.year, fields.month, fields.date);
    date.setHours(
      fields.hours,
      fields.minutes,
      fields.seconds,
      fields.milliseconds
    );
    return date;
  }
}

/**
 * A time of the day, like `'09:30'`, `'09:30:15'` or `'09:30:15.250'`.
 */
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/**
 * A picker of a time of the day: its value is a string, like `'09:30'`,
 * with the seconds and the milliseconds when they are not zero, like the
 * value of the time inputs of the browsers.
 */
export class TimePicker extends _PickerBase<string> {
  static override modelName = 'TimeModel';
  static override viewName = 'TimeView';

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), step: 60 };
  }

  /**
   * The step of the picker, in seconds, or 'any'.
   */
  get step(): number | 'any' {
    return this.get('step') as number | 'any';
  }
  set step(v: number | 'any') {
    this.set('step', v);
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    state.step = validateStep(state.step, false);
    super._validate(state, names);
  }

  protected override _coerce(name: string, value: unknown): string {
    const match = typeof value === 'string' ? TIME.exec(value.trim()) : null;
    const fields = match && {
      hours: Number(match[1]),
      minutes: Number(match[2]),
      seconds: Number(match[3] ?? 0),
      milliseconds: Number((match[4] ?? '').padEnd(3, '0'))
    };
    if (
      !fields ||
      fields.hours > 23 ||
      fields.minutes > 59 ||
      fields.seconds > 59
    ) {
      throw new TypeError(
        `The ${name} of a time picker must be a time like '09:30' or '09:30:15', or null`
      );
    }
    return formatTime(fields);
  }

  protected override _order(value: string): number {
    const fields = this._toFields(value);
    return (
      ((fields.hours * 60 + fields.minutes) * 60 + fields.seconds) * 1000 +
      fields.milliseconds
    );
  }

  protected override _toFields(value: string): Record<string, number> {
    const match = TIME.exec(value)!;
    return {
      hours: Number(match[1]),
      minutes: Number(match[2]),
      seconds: Number(match[3] ?? 0),
      milliseconds: Number((match[4] ?? '').padEnd(3, '0'))
    };
  }

  protected override _fromFields(fields: Record<string, number>): string {
    return formatTime(fields);
  }
}

/**
 * A time of the day, like the frontend shows it: the seconds and the
 * milliseconds are left out when they are zero.
 */
function formatTime(fields: Record<string, number>): string {
  const pad = (number: number, length = 2) =>
    String(Math.floor(number)).padStart(length, '0');
  let time = `${pad(fields.hours)}:${pad(fields.minutes)}`;
  if (fields.seconds > 0 || fields.milliseconds > 0) {
    time += `:${pad(fields.seconds)}`;
    if (fields.milliseconds > 0) {
      time += `.${pad(fields.milliseconds, 3)}`;
    }
  }
  return time;
}

/**
 * The step of a picker: a number, an integer for the dates, or 'any'.
 */
function validateStep(step: unknown, integer: boolean): number | 'any' {
  if (typeof step === 'string' && step.toLowerCase() === 'any') {
    return 'any';
  }
  return _toNumber('step', step, integer);
}
