// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { isPlainObject } from '../utils';

import type { WidgetStateChange } from './widget';
import { DOMWidget } from './widget_dom';
import {
  DescriptionStyle,
  SliderStyle,
  ToggleButtonsStyle
} from './widget_style';

/**
 * The options of a selection widget: values, labelled with their string,
 * `[label, value]` pairs, or an object of the values by label.
 */
export type SelectionOptions = Iterable<unknown> | Record<string, unknown>;

/**
 * The options of a selection widget, as given, with their labels and their
 * values.
 */
interface IOptions {
  given: SelectionOptions;
  labels: string[];
  values: unknown[];
}

/**
 * The labels and the values of the options of a selection widget, like
 * ipywidgets.
 */
function normalizeOptions(options: unknown): IOptions {
  let items: unknown[];
  let given: SelectionOptions;
  if (isPlainObject(options)) {
    given = options as Record<string, unknown>;
    items = Object.entries(given);
  } else if (
    typeof options === 'object' &&
    options !== null &&
    Symbol.iterator in options
  ) {
    items = Array.from(options as Iterable<unknown>);
    given = items;
  } else {
    throw new TypeError(
      'The options of a selection widget must be an array of values or [label, value] pairs, or an object of the values by label'
    );
  }

  const labels: string[] = [];
  const values: unknown[] = [];
  for (const item of items) {
    const pair = Array.isArray(item) && item.length === 2;
    labels.push(String(pair ? item[0] : item));
    values.push(pair ? item[1] : item);
  }
  return { given, labels, values };
}

/**
 * The index of a value in a list, compared like `Array.includes()`, or -1.
 */
function findValue(list: readonly unknown[], value: unknown): number {
  return list.findIndex(
    item => item === value || (Number.isNaN(item) && Number.isNaN(value))
  );
}

/**
 * The index of a value or a label of the options, which must be there.
 */
function lookup(
  list: readonly unknown[],
  value: unknown,
  name: string
): number {
  const index = findValue(list, value);
  if (index === -1) {
    throw new RangeError(`Invalid selection: ${name} not found`);
  }
  return index;
}

/**
 * Check that an index selects one of the options.
 */
function checkIndex(index: unknown, count: number): void {
  if (
    typeof index !== 'number' ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count
  ) {
    throw new RangeError('Invalid selection: index out of bounds');
  }
}

/**
 * Whether two values or lists of values are the same.
 */
function sameSelection(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  }
  return Object.is(a, b);
}

/**
 * The base of the selection widgets.
 *
 * Like ipywidgets, the frontend shows the labels of the options and syncs
 * the index of the selection, from which the value and the label are
 * derived: they are not synced, and their observers are called when the
 * index or the options change.
 */
abstract class _OptionsBase extends DOMWidget {
  static override styleClass = DescriptionStyle;

  constructor(
    state?: Record<string, unknown> & { options?: SelectionOptions }
  ) {
    super(state);
    this._selected = [this._selectedValue(), this._selectedLabel()];
  }

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), _options_labels: [] };
  }

  /**
   * The options, as given: values, `[label, value]` pairs or an object of
   * the values by label. The selected value is kept when it is still one of
   * the new options.
   */
  get options(): SelectionOptions {
    return this._options;
  }
  set options(v: SelectionOptions) {
    this.set('options', v);
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    const initializing = this._values === undefined;
    const labels = state._options_labels as string[];
    let options: IOptions = initializing
      ? { given: [...labels], labels, values: [...labels] }
      : { given: this._options, labels, values: this._values };
    if (names.has('options')) {
      options = normalizeOptions(state.options);
    }
    const index = this._selectIndex(state, names, options, initializing);
    delete state.options;
    delete state.value;
    delete state.label;
    super._validate(state, names);

    state.index = index;
    state._options_labels = options.labels;
    this._options = options.given;
    this._values = options.values;
  }

  /**
   * Notify the changes of the value and the label after the ones of the
   * index or the options.
   */
  protected override _notify(changes: WidgetStateChange[]): void {
    const value = this._selectedValue();
    const label = this._selectedLabel();
    const [oldValue, oldLabel] = this._selected;
    this._selected = [value, label];
    const derived: WidgetStateChange[] = [];
    if (!sameSelection(value, oldValue)) {
      derived.push(['value', value, oldValue]);
    }
    if (!sameSelection(label, oldLabel)) {
      derived.push(['label', label, oldLabel]);
    }
    super._notify([...changes, ...derived]);
  }

  /**
   * The index of the new selection: the one of the given value, label or
   * index, the first option for a new widget, or the one of the selected
   * value when the options change.
   */
  protected abstract _selectIndex(
    state: Record<string, unknown>,
    names: ReadonlySet<string>,
    options: IOptions,
    initializing: boolean
  ): unknown;

  protected abstract _selectedValue(): unknown;

  protected abstract _selectedLabel(): unknown;

  // Set by `_validate()`, which runs in the constructor of `Widget`: they
  // are declared without a field, which would reset them after `super()`
  /**
   * The values of the options, by index.
   */
  declare protected _values: unknown[];
  declare private _options: SelectionOptions;
  private _selected: [unknown, unknown];
}

class _SelectionBase extends _OptionsBase {
  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), index: null };
  }

  /**
   * The index of the selected option, or null.
   */
  get index(): number | null {
    return this.get('index') as number | null;
  }
  set index(v: number | null) {
    this.set('index', v);
  }

  /**
   * The value of the selected option, or null.
   */
  get value(): unknown {
    return this._selectedValue();
  }
  set value(v: unknown) {
    this.set('value', v);
  }

  /**
   * The label of the selected option, or null.
   */
  get label(): string | null {
    return this._selectedLabel();
  }
  set label(v: string | null) {
    this.set('label', v);
  }

  /**
   * The label of the currently selected option, or null if none.
   */
  get selectedLabel(): string | null {
    return this._selectedLabel();
  }

  protected _selectIndex(
    state: Record<string, unknown>,
    names: ReadonlySet<string>,
    options: IOptions,
    initializing: boolean
  ): number | null {
    const { labels, values } = options;
    let index: unknown;
    if (names.has('value')) {
      index =
        state.value === null ? null : lookup(values, state.value, 'value');
    } else if (names.has('label')) {
      index =
        state.label === null
          ? null
          : lookup(labels, String(state.label), 'label');
    } else if (names.has('index')) {
      index = state.index ?? null;
    } else if (initializing) {
      index = labels.length > 0 ? 0 : null;
    } else if (names.has('options')) {
      // Keep the selected value when it is still an option
      const kept = this.index === null ? -1 : findValue(values, this.value);
      index =
        kept !== -1 ? kept : this.index === null || !labels.length ? null : 0;
    } else {
      index = state.index;
    }
    if (index !== null) {
      checkIndex(index, labels.length);
    }
    return index as number | null;
  }

  protected _selectedValue(): unknown {
    const index = this.index;
    return index === null || index === undefined ? null : this._values[index];
  }

  protected _selectedLabel(): string | null {
    const index = this.index;
    if (index === null || index === undefined) {
      return null;
    }
    return (this.get('_options_labels') as string[])[index] ?? null;
  }
}

class _MultipleSelectionBase extends _OptionsBase {
  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), index: [] };
  }

  /**
   * The indices of the selected options.
   */
  get index(): number[] {
    return [...((this.get('index') as number[]) ?? [])];
  }
  set index(v: number[]) {
    this.set('index', [...v]);
  }

  /**
   * The values of the selected options.
   */
  get value(): unknown[] {
    return this._selectedValue();
  }
  set value(v: Iterable<unknown>) {
    this.set('value', v);
  }

  /**
   * The labels of the selected options.
   */
  get label(): string[] {
    return this._selectedLabel();
  }
  set label(v: Iterable<string>) {
    this.set('label', v);
  }

  get selectedLabels(): string[] {
    return this._selectedLabel();
  }

  /**
   * The selection of a new widget, without index.
   */
  protected _defaultIndex(_count: number): number[] {
    return [];
  }

  /**
   * The selection when the options change, from the new indices of the
   * selected values, -1 for the ones which are not options anymore.
   */
  protected _keepIndex(indices: number[], _count: number): number[] {
    return indices.filter(index => index !== -1);
  }

  protected _selectIndex(
    state: Record<string, unknown>,
    names: ReadonlySet<string>,
    options: IOptions,
    initializing: boolean
  ): number[] {
    const { labels, values } = options;
    let index: unknown;
    if (names.has('value')) {
      index = Array.from(state.value as Iterable<unknown>, value =>
        lookup(values, value, 'value')
      );
    } else if (names.has('label')) {
      index = Array.from(state.label as Iterable<unknown>, label =>
        lookup(labels, String(label), 'label')
      );
    } else if (names.has('index')) {
      // Keep the array of the frontend, to not send it back
      index = Array.isArray(state.index)
        ? state.index
        : Array.from((state.index ?? []) as Iterable<unknown>);
    } else if (initializing) {
      index = this._defaultIndex(labels.length);
    } else if (names.has('options')) {
      // Keep the selected values which are still options
      const indices = this.value.map(value => findValue(values, value));
      index = this._keepIndex(indices, labels.length);
    } else {
      index = state.index;
    }
    for (const item of index as unknown[]) {
      checkIndex(item, labels.length);
    }
    return index as number[];
  }

  protected _selectedValue(): unknown[] {
    return this.index.map(index => this._values[index]);
  }

  protected _selectedLabel(): string[] {
    const labels = this.get('_options_labels') as string[];
    return this.index.map(index => labels[index]);
  }
}

export class Dropdown extends _SelectionBase {
  static override modelName = 'DropdownModel';
  static override viewName = 'DropdownView';
}

export class RadioButtons extends _SelectionBase {
  static override modelName = 'RadioButtonsModel';
  static override viewName = 'RadioButtonsView';
}

export class Select extends _SelectionBase {
  static override modelName = 'SelectModel';
  static override viewName = 'SelectView';

  protected override _defaults() {
    return { ...super._defaults(), rows: 5 };
  }

  get rows(): number {
    return this.get('rows') as number;
  }
  set rows(v: number) {
    this.set('rows', v);
  }
}

export class SelectMultiple extends _MultipleSelectionBase {
  static override modelName = 'SelectMultipleModel';
  static override viewName = 'SelectMultipleView';

  protected override _defaults() {
    return { ...super._defaults(), rows: 5 };
  }

  get rows(): number {
    return this.get('rows') as number;
  }
  set rows(v: number) {
    this.set('rows', v);
  }
}

export class ToggleButtons extends _SelectionBase {
  static override modelName = 'ToggleButtonsModel';
  static override viewName = 'ToggleButtonsView';
  static override styleClass = ToggleButtonsStyle;

  protected override _defaults() {
    return { ...super._defaults(), tooltips: [], button_style: '', icons: [] };
  }

  get tooltips(): string[] {
    return this.get('tooltips') as string[];
  }
  set tooltips(v: string[]) {
    this.set('tooltips', v);
  }
  get button_style(): string {
    return this.get('button_style') as string;
  }
  set button_style(v: string) {
    this.set('button_style', v);
  }
  get icons(): string[] {
    return this.get('icons') as string[];
  }
  set icons(v: string[]) {
    this.set('icons', v);
  }
}

export class SelectionSlider extends _SelectionBase {
  static override modelName = 'SelectionSliderModel';
  static override viewName = 'SelectionSliderView';
  static override styleClass = SliderStyle;

  protected override _defaults() {
    return {
      ...super._defaults(),
      orientation: 'horizontal',
      readout: true,
      continuous_update: true,
      behavior: 'drag-tap'
    };
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

export class SelectionRangeSlider extends _MultipleSelectionBase {
  static override modelName = 'SelectionRangeSliderModel';
  static override viewName = 'SelectionRangeSliderView';
  static override styleClass = SliderStyle;

  protected override _defaults(): Record<string, unknown> {
    return {
      ...super._defaults(),
      index: [0, 0],
      orientation: 'horizontal',
      readout: true,
      continuous_update: true,
      behavior: 'drag-tap'
    };
  }

  /**
   * The first option for a new range slider.
   */
  protected override _defaultIndex(count: number): number[] {
    return count > 0 ? [0, 0] : [];
  }

  /**
   * The same range when its values are still options, in the order of the
   * new options, or the first option.
   */
  protected override _keepIndex(indices: number[], count: number): number[] {
    if (indices.length !== 2 || indices.includes(-1)) {
      return this._defaultIndex(count);
    }
    return indices[0] > indices[1] ? [indices[1], indices[0]] : indices;
  }

  /**
   * Check that the range has a lower and an upper option, like ipywidgets,
   * and that the lower one comes first, like the numeric range sliders.
   */
  protected override _selectIndex(
    state: Record<string, unknown>,
    names: ReadonlySet<string>,
    options: IOptions,
    initializing: boolean
  ): number[] {
    const index = super._selectIndex(state, names, options, initializing);
    if (options.labels.length > 0 && index.length !== 2) {
      throw new RangeError(
        'Invalid selection: index must have two values, the lower and the upper one'
      );
    }
    if (index[0] > index[1]) {
      throw new RangeError(
        `Invalid selection: lower > upper (index ${index[0]} > ${index[1]})`
      );
    }
    return index;
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
