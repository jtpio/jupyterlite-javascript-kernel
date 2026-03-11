// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { CommManager, IComm } from './comm';

const WIDGET_PROTOCOL_VERSION = '2.1.0';
const CONTROLS_MODULE = '@jupyter-widgets/controls';
const CONTROLS_MODULE_VERSION = '2.0.0';

type WidgetEventCallback = (...args: any[]) => void;

/**
 * Base class for Jupyter widgets.
 *
 * Wraps the low-level comm protocol so user code can work with
 * familiar property access and change events instead of raw messages.
 */
export class Widget {
  static modelName = '';
  static viewName = '';

  private static _defaultManager: CommManager | null = null;

  /**
   * Set the default CommManager used by all Widget instances.
   */
  static setDefaultManager(manager: CommManager | null): void {
    Widget._defaultManager = manager;
  }

  constructor(state?: Record<string, unknown>) {
    const manager = Widget._defaultManager;
    if (!manager) {
      throw new Error(
        'Widget manager not initialized. Widgets can only be created inside the kernel runtime.'
      );
    }

    const ctor = this.constructor as typeof Widget;
    this._state = {
      ...this._defaults(),
      ...state,
      _model_name: ctor.modelName,
      _model_module: CONTROLS_MODULE,
      _model_module_version: CONTROLS_MODULE_VERSION,
      _view_name: ctor.viewName,
      _view_module: CONTROLS_MODULE,
      _view_module_version: CONTROLS_MODULE_VERSION
    };
    this._listeners = new Map();

    this._comm = manager.open(
      'jupyter.widget',
      { state: this._state, buffer_paths: [] },
      { version: WIDGET_PROTOCOL_VERSION }
    );

    this._comm.onMsg = (data, buffers) => {
      this._handleMsg(data, buffers);
    };
    this._comm.onClose = data => {
      this._trigger('close', data);
    };
  }

  /**
   * Close the widget and its comm channel.
   */
  close(): void {
    this._comm.close();
  }

  /**
   * Get a state property.
   */
  get(name: string): unknown {
    return this._state[name];
  }

  /**
   * Set one or more state properties and sync to the frontend.
   */
  set(name: string, value: unknown): void;
  set(state: Record<string, unknown>): void;
  set(nameOrState: string | Record<string, unknown>, value?: unknown): void {
    const updates: Record<string, unknown> =
      typeof nameOrState === 'string'
        ? { [nameOrState]: value }
        : nameOrState;

    const changes: Array<[string, unknown, unknown]> = [];
    for (const [key, val] of Object.entries(updates)) {
      const old = this._state[key];
      if (old !== val) {
        this._state[key] = val;
        changes.push([key, val, old]);
      }
    }

    if (changes.length > 0) {
      this._comm.send({
        method: 'update',
        state: updates,
        buffer_paths: []
      });
      for (const [key, val, old] of changes) {
        this._trigger(`change:${key}`, val, old);
      }
      this._trigger('change', changes);
    }
  }

  /**
   * Listen for widget events.
   *
   * Events:
   * - `'change:propName'` — property changed `(newValue, oldValue)`
   * - `'change'` — any property changed `(changes)`
   * - `'close'` — comm closed
   */
  on(event: string, callback: WidgetEventCallback): this {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(callback);
    return this;
  }

  /**
   * Remove an event listener.
   */
  off(event: string, callback: WidgetEventCallback): this {
    this._listeners.get(event)?.delete(callback);
    return this;
  }

  /**
   * The widget's comm/model ID.
   */
  get commId(): string {
    return this._comm.commId;
  }

  get description(): string {
    return this.get('description') as string;
  }
  set description(v: string) {
    this.set('description', v);
  }

  get disabled(): boolean {
    return this.get('disabled') as boolean;
  }
  set disabled(v: boolean) {
    this.set('disabled', v);
  }

  protected _defaults(): Record<string, unknown> {
    return { description: '', disabled: false };
  }

  protected _handleMsg(
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[]
  ): void {
    if (data.method === 'update' && data.state) {
      const state = data.state as Record<string, unknown>;
      const changes: Array<[string, unknown, unknown]> = [];
      for (const [key, val] of Object.entries(state)) {
        const old = this._state[key];
        if (old !== val) {
          this._state[key] = val;
          changes.push([key, val, old]);
        }
      }
      for (const [key, val, old] of changes) {
        this._trigger(`change:${key}`, val, old);
      }
      if (changes.length > 0) {
        this._trigger('change', changes);
      }
    }

    if (data.method === 'request_state') {
      this._comm.send({
        method: 'update',
        state: this._state,
        buffer_paths: []
      });
    }
  }

  protected _trigger(event: string, ...args: unknown[]): void {
    for (const cb of this._listeners.get(event) ?? []) {
      try {
        cb(...args);
      } catch (e) {
        console.error(`[Widget] Error in '${event}' handler:`, e);
      }
    }
  }

  protected _comm: IComm;
  protected _state: Record<string, unknown>;
  private _listeners: Map<string, Set<WidgetEventCallback>>;
}

// ---------------------------------------------------------------------------
//  Numeric — sliders
// ---------------------------------------------------------------------------

class _SliderBase extends Widget {
  protected _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      orientation: 'horizontal',
      readout: true
    };
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
}

export class IntSlider extends _SliderBase {
  static override modelName = 'IntSliderModel';
  static override viewName = 'IntSliderView';
}

export class FloatSlider extends _SliderBase {
  static override modelName = 'FloatSliderModel';
  static override viewName = 'FloatSliderView';

  protected override _defaults() {
    return { ...super._defaults(), max: 10.0, step: 0.1, readout_format: '.2f' };
  }

  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

// ---------------------------------------------------------------------------
//  Numeric — progress
// ---------------------------------------------------------------------------

class _ProgressBase extends Widget {
  protected _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      min: 0,
      max: 100,
      bar_style: '',
      orientation: 'horizontal'
    };
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

export class IntProgress extends _ProgressBase {
  static override modelName = 'IntProgressModel';
  static override viewName = 'ProgressView';
}

export class FloatProgress extends _ProgressBase {
  static override modelName = 'FloatProgressModel';
  static override viewName = 'ProgressView';

  protected override _defaults() {
    return { ...super._defaults(), max: 10.0 };
  }
}

// ---------------------------------------------------------------------------
//  Numeric — text inputs
// ---------------------------------------------------------------------------

class _NumericTextBase extends Widget {
  protected _defaults() {
    return { ...super._defaults(), value: 0, step: 1 };
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
}

export class IntText extends _NumericTextBase {
  static override modelName = 'IntTextModel';
  static override viewName = 'IntTextView';
}

export class FloatText extends _NumericTextBase {
  static override modelName = 'FloatTextModel';
  static override viewName = 'FloatTextView';

  protected override _defaults() {
    return { ...super._defaults(), value: 0.0, step: 0.1 };
  }
}

export class BoundedIntText extends _NumericTextBase {
  static override modelName = 'BoundedIntTextModel';
  static override viewName = 'IntTextView';

  protected override _defaults() {
    return { ...super._defaults(), min: 0, max: 100 };
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
}

export class BoundedFloatText extends _NumericTextBase {
  static override modelName = 'BoundedFloatTextModel';
  static override viewName = 'FloatTextView';

  protected override _defaults() {
    return { ...super._defaults(), value: 0.0, step: 0.1, min: 0.0, max: 100.0 };
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
}

// ---------------------------------------------------------------------------
//  Boolean
// ---------------------------------------------------------------------------

export class Checkbox extends Widget {
  static override modelName = 'CheckboxModel';
  static override viewName = 'CheckboxView';

  protected override _defaults() {
    return { ...super._defaults(), value: false, indent: true };
  }

  get value(): boolean {
    return this.get('value') as boolean;
  }
  set value(v: boolean) {
    this.set('value', v);
  }
  get indent(): boolean {
    return this.get('indent') as boolean;
  }
  set indent(v: boolean) {
    this.set('indent', v);
  }
}

export class ToggleButton extends Widget {
  static override modelName = 'ToggleButtonModel';
  static override viewName = 'ToggleButtonView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: false,
      tooltip: '',
      icon: '',
      button_style: ''
    };
  }

  get value(): boolean {
    return this.get('value') as boolean;
  }
  set value(v: boolean) {
    this.set('value', v);
  }
  get tooltip(): string {
    return this.get('tooltip') as string;
  }
  set tooltip(v: string) {
    this.set('tooltip', v);
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
}

export class Valid extends Widget {
  static override modelName = 'ValidModel';
  static override viewName = 'ValidView';

  protected override _defaults() {
    return { ...super._defaults(), value: false, readout: 'Invalid' };
  }

  get value(): boolean {
    return this.get('value') as boolean;
  }
  set value(v: boolean) {
    this.set('value', v);
  }
  get readout(): string {
    return this.get('readout') as string;
  }
  set readout(v: string) {
    this.set('readout', v);
  }
}

// ---------------------------------------------------------------------------
//  Selection
// ---------------------------------------------------------------------------

class _SelectionBase extends Widget {
  constructor(state?: Record<string, unknown> & { options?: string[] }) {
    const { options, ...rest } = state ?? {};
    if (options !== undefined) {
      (rest as Record<string, unknown>)._options_labels = options;
      if (rest.index === undefined) {
        (rest as Record<string, unknown>).index =
          options.length > 0 ? 0 : null;
      }
    }
    super(rest as Record<string, unknown>);
  }

  protected override _defaults() {
    return { ...super._defaults(), _options_labels: [], index: null };
  }

  get options(): string[] {
    return this.get('_options_labels') as string[];
  }
  set options(v: string[]) {
    this.set({ _options_labels: v, index: v.length > 0 ? 0 : null });
  }
  get index(): number | null {
    return this.get('index') as number | null;
  }
  set index(v: number | null) {
    this.set('index', v);
  }

  /**
   * The label of the currently selected option, or null if none.
   */
  get selectedLabel(): string | null {
    const idx = this.index;
    if (idx === null || idx === undefined) {
      return null;
    }
    return this.options[idx] ?? null;
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

export class ToggleButtons extends _SelectionBase {
  static override modelName = 'ToggleButtonsModel';
  static override viewName = 'ToggleButtonsView';

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

  protected override _defaults() {
    return { ...super._defaults(), orientation: 'horizontal', readout: true };
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
}

// ---------------------------------------------------------------------------
//  String / text
// ---------------------------------------------------------------------------

class _TextBase extends Widget {
  protected override _defaults() {
    return {
      ...super._defaults(),
      value: '',
      placeholder: '',
      continuous_update: true
    };
  }

  get value(): string {
    return this.get('value') as string;
  }
  set value(v: string) {
    this.set('value', v);
  }
  get placeholder(): string {
    return this.get('placeholder') as string;
  }
  set placeholder(v: string) {
    this.set('placeholder', v);
  }
  get continuous_update(): boolean {
    return this.get('continuous_update') as boolean;
  }
  set continuous_update(v: boolean) {
    this.set('continuous_update', v);
  }
}

export class Text extends _TextBase {
  static override modelName = 'TextModel';
  static override viewName = 'TextView';
}

export class Textarea extends _TextBase {
  static override modelName = 'TextareaModel';
  static override viewName = 'TextareaView';
}

export class Password extends _TextBase {
  static override modelName = 'PasswordModel';
  static override viewName = 'PasswordView';
}

export class Combobox extends _TextBase {
  static override modelName = 'ComboboxModel';
  static override viewName = 'ComboboxView';

  constructor(state?: Record<string, unknown> & { options?: string[] }) {
    const { options, ...rest } = state ?? {};
    if (options !== undefined) {
      (rest as Record<string, unknown>).options = options;
    }
    super(rest as Record<string, unknown>);
  }

  protected override _defaults() {
    return { ...super._defaults(), options: [], ensure_option: false };
  }

  get options(): string[] {
    return this.get('options') as string[];
  }
  set options(v: string[]) {
    this.set('options', v);
  }
  get ensure_option(): boolean {
    return this.get('ensure_option') as boolean;
  }
  set ensure_option(v: boolean) {
    this.set('ensure_option', v);
  }
}

// ---------------------------------------------------------------------------
//  Display / output
// ---------------------------------------------------------------------------

class _DisplayBase extends Widget {
  protected override _defaults() {
    return { ...super._defaults(), value: '' };
  }

  get value(): string {
    return this.get('value') as string;
  }
  set value(v: string) {
    this.set('value', v);
  }
}

export class Label extends _DisplayBase {
  static override modelName = 'LabelModel';
  static override viewName = 'LabelView';
}

export class HTML extends _DisplayBase {
  static override modelName = 'HTMLModel';
  static override viewName = 'HTMLView';
}

export class HTMLMath extends _DisplayBase {
  static override modelName = 'HTMLMathModel';
  static override viewName = 'HTMLMathView';
}

// ---------------------------------------------------------------------------
//  Button
// ---------------------------------------------------------------------------

export class Button extends Widget {
  static override modelName = 'ButtonModel';
  static override viewName = 'ButtonView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      tooltip: '',
      icon: '',
      button_style: ''
    };
  }

  /**
   * Register a click handler.
   */
  onClick(callback: () => void): this {
    return this.on('click', callback);
  }

  get tooltip(): string {
    return this.get('tooltip') as string;
  }
  set tooltip(v: string) {
    this.set('tooltip', v);
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

  protected override _handleMsg(
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[]
  ): void {
    super._handleMsg(data, buffers);
    if (data.method === 'custom') {
      const content = data.content as Record<string, unknown> | undefined;
      if (content?.event === 'click') {
        this._trigger('click');
      }
      this._trigger('custom', content, buffers);
    }
  }
}

// ---------------------------------------------------------------------------
//  Color picker
// ---------------------------------------------------------------------------

export class ColorPicker extends Widget {
  static override modelName = 'ColorPickerModel';
  static override viewName = 'ColorPickerView';

  protected override _defaults() {
    return { ...super._defaults(), value: '#000000', concise: false };
  }

  get value(): string {
    return this.get('value') as string;
  }
  set value(v: string) {
    this.set('value', v);
  }
  get concise(): boolean {
    return this.get('concise') as boolean;
  }
  set concise(v: boolean) {
    this.set('concise', v);
  }
}

// ---------------------------------------------------------------------------
//  Container / layout
// ---------------------------------------------------------------------------

/**
 * Serialize an array of Widget instances to `"IPY_MODEL_<id>"` references
 * as required by the Jupyter widget protocol.
 */
function _serializeChildren(children: Widget[]): string[] {
  return children.map(w => `IPY_MODEL_${w.commId}`);
}

export class Box extends Widget {
  static override modelName = 'BoxModel';
  static override viewName = 'BoxView';

  protected _children: Widget[];

  constructor(state?: Record<string, unknown> & { children?: Widget[] }) {
    const { children, ...rest } = state ?? {};
    const childrenArr = children ?? [];
    super({ ...rest, children: _serializeChildren(childrenArr) });
    this._children = [...childrenArr];
  }

  protected override _defaults() {
    return { children: [], box_style: '' };
  }

  get children(): Widget[] {
    return this._children;
  }
  set children(v: Widget[]) {
    this._children = [...v];
    this.set('children', _serializeChildren(v));
  }

  get box_style(): string {
    return this.get('box_style') as string;
  }
  set box_style(v: string) {
    this.set('box_style', v);
  }
}

export class HBox extends Box {
  static override modelName = 'HBoxModel';
  static override viewName = 'HBoxView';
}

export class VBox extends Box {
  static override modelName = 'VBoxModel';
  static override viewName = 'VBoxView';
}

export class GridBox extends Box {
  static override modelName = 'GridBoxModel';
  static override viewName = 'GridBoxView';
}

// ---------------------------------------------------------------------------
//  Selection containers (Tab, Accordion, Stack)
// ---------------------------------------------------------------------------

class _SelectionContainer extends Box {
  constructor(
    state?: Record<string, unknown> & {
      children?: Widget[];
      titles?: string[];
    }
  ) {
    const s = { ...(state ?? {}) };
    const childCount = (s.children as Widget[] | undefined)?.length ?? 0;
    // Pad titles with empty strings to match children count
    const titles = (s.titles as string[] | undefined) ?? [];
    const padded = [...titles];
    while (padded.length < childCount) {
      padded.push('');
    }
    s.titles = padded;
    super(s as Record<string, unknown> & { children?: Widget[] });
  }

  protected override _defaults() {
    return { ...super._defaults(), titles: [], selected_index: null };
  }

  get titles(): string[] {
    return this.get('titles') as string[];
  }
  set titles(v: string[]) {
    this.set('titles', v);
  }

  get selected_index(): number | null {
    return this.get('selected_index') as number | null;
  }
  set selected_index(v: number | null) {
    this.set('selected_index', v);
  }

  /**
   * Set the title of a container page.
   */
  setTitle(index: number, title: string): void {
    const t = [...this.titles];
    while (t.length <= index) {
      t.push('');
    }
    t[index] = title;
    this.titles = t;
  }

  /**
   * Get the title of a container page.
   */
  getTitle(index: number): string {
    return this.titles[index] ?? '';
  }
}

export class Accordion extends _SelectionContainer {
  static override modelName = 'AccordionModel';
  static override viewName = 'AccordionView';
}

export class Tab extends _SelectionContainer {
  static override modelName = 'TabModel';
  static override viewName = 'TabView';

  constructor(
    state?: Record<string, unknown> & {
      children?: Widget[];
      titles?: string[];
    }
  ) {
    const s = { ...(state ?? {}) };
    const children = (s.children as Widget[] | undefined) ?? [];
    // Default to first tab selected when there are children
    if (children.length > 0 && s.selected_index === undefined) {
      s.selected_index = 0;
    }
    super(s as Record<string, unknown> & { children?: Widget[]; titles?: string[] });
  }
}

export class Stack extends _SelectionContainer {
  static override modelName = 'StackModel';
  static override viewName = 'StackView';
}

// ---------------------------------------------------------------------------
//  Convenience map of all exported widget classes
// ---------------------------------------------------------------------------

/**
 * All widget classes, keyed by class name.
 */
export const widgetClasses: Record<string, typeof Widget> = {
  Widget,
  IntSlider,
  FloatSlider,
  IntProgress,
  FloatProgress,
  IntText,
  FloatText,
  BoundedIntText,
  BoundedFloatText,
  Checkbox,
  ToggleButton,
  Valid,
  Dropdown,
  RadioButtons,
  Select,
  ToggleButtons,
  SelectionSlider,
  Text,
  Textarea,
  Password,
  Combobox,
  Label,
  HTML,
  HTMLMath,
  Button,
  ColorPicker,
  Box,
  HBox,
  VBox,
  GridBox,
  Accordion,
  Tab,
  Stack
};
