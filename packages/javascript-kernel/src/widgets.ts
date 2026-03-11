// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { CommManager, IComm } from './comm';

const WIDGET_PROTOCOL_VERSION = '2.1.0';
const BASE_MODULE = '@jupyter-widgets/base';
const BASE_MODULE_VERSION = '2.0.0';
const CONTROLS_MODULE = '@jupyter-widgets/controls';
const CONTROLS_MODULE_VERSION = '2.0.0';
const OUTPUT_MODULE = '@jupyter-widgets/output';
const OUTPUT_MODULE_VERSION = '1.0.0';

type WidgetEventCallback = (...args: any[]) => void;

export interface IWidgetChange {
  name: string;
  new: unknown;
  old: unknown;
  owner: Widget;
  type: 'change';
}

export type WidgetObserveCallback = (change: IWidgetChange) => void;

export type WidgetTraitPair = [Widget, string];

export interface IOutputCaptureOptions {
  clearOutput?: boolean;
  wait?: boolean;
}

/**
 * Base class for Jupyter widgets.
 *
 * Wraps the low-level comm protocol so user code can work with
 * familiar property access and change events instead of raw messages.
 */
export class Widget {
  static modelName = '';
  static viewName: string | null = '';
  static modelModule = CONTROLS_MODULE;
  static modelModuleVersion = CONTROLS_MODULE_VERSION;
  static viewModule = CONTROLS_MODULE;
  static viewModuleVersion = CONTROLS_MODULE_VERSION;

  protected static _defaultManager: CommManager | null = null;

  /**
   * Set the default CommManager used by all Widget instances.
   */
  static setDefaultManager(manager: CommManager | null): void {
    this._defaultManager = manager;
  }

  constructor(state?: Record<string, unknown>) {
    const ctor = this.constructor as typeof Widget;
    const manager = ctor._defaultManager;
    if (!manager) {
      throw new Error(
        'Widget manager not initialized. Widgets can only be created inside the kernel runtime.'
      );
    }

    this._manager = manager;
    this._state = {
      ...this._defaults(),
      ...state,
      ...this._modelState(ctor)
    };
    this._listeners = new Map();
    this._observerWrappers = new Map();

    this._comm = manager.open(
      'jupyter.widget',
      { state: this._serializeState(this._state), buffer_paths: [] },
      { version: WIDGET_PROTOCOL_VERSION }
    );

    this._comm.onMsg = (data, buffers) => {
      this._handleMsg(data, buffers);
    };
    this._comm.onClose = data => {
      this._manager.unregisterWidget(this.commId);
      this._trigger('close', data);
    };
    this._manager.registerWidget(this.commId, this);
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
      typeof nameOrState === 'string' ? { [nameOrState]: value } : nameOrState;

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
        state: this._serializeState(updates),
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
   * - `'change:propName'` - property changed `(newValue, oldValue)`
   * - `'change'` - any property changed `(changes)`
   * - `'close'` - comm closed
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
   * Observe changes using an ipywidgets-style callback payload.
   */
  observe(callback: WidgetObserveCallback, names?: string | string[]): this {
    for (const name of this._normalizeObserveNames(names)) {
      const eventName = name === '*' ? 'change' : `change:${name}`;
      const wrapper = this._observerWrapper(callback, name);
      this.on(eventName, wrapper);
    }
    return this;
  }

  /**
   * Remove an observe callback.
   */
  unobserve(callback: WidgetObserveCallback, names?: string | string[]): this {
    const wrappers = this._observerWrappers.get(callback);
    if (!wrappers) {
      return this;
    }

    const keys = names
      ? this._normalizeObserveNames(names)
      : [...wrappers.keys()];
    for (const name of keys) {
      const wrapper = wrappers.get(name);
      if (!wrapper) {
        continue;
      }
      const eventName = name === '*' ? 'change' : `change:${name}`;
      this.off(eventName, wrapper);
      wrappers.delete(name);
    }

    if (wrappers.size === 0) {
      this._observerWrappers.delete(callback);
    }

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
        const next = this._deserializeProperty(key, val);
        const old = this._state[key];
        if (old !== next) {
          this._state[key] = next;
          changes.push([key, next, old]);
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
        state: this._serializeState(this._state),
        buffer_paths: []
      });
    }
  }

  protected _serializeState(
    state: Record<string, unknown>
  ): Record<string, unknown> {
    const serialized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state)) {
      serialized[key] = this._serializeProperty(key, value);
    }
    return serialized;
  }

  protected _serializeProperty(name: string, value: unknown): unknown {
    return value;
  }

  protected _deserializeProperty(name: string, value: unknown): unknown {
    return value;
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

  private _modelState(ctor: typeof Widget): Record<string, unknown> {
    const state: Record<string, unknown> = {
      _model_name: ctor.modelName,
      _model_module: ctor.modelModule,
      _model_module_version: ctor.modelModuleVersion
    };

    if (ctor.viewName !== null) {
      state._view_name = ctor.viewName;
      state._view_module = ctor.viewModule;
      state._view_module_version = ctor.viewModuleVersion;
    }

    return state;
  }

  private _normalizeObserveNames(names?: string | string[]): string[] {
    if (names === undefined) {
      return ['*'];
    }
    return Array.isArray(names) ? names : [names];
  }

  private _observerWrapper(
    callback: WidgetObserveCallback,
    name: string
  ): WidgetEventCallback {
    let wrappers = this._observerWrappers.get(callback);
    if (!wrappers) {
      wrappers = new Map();
      this._observerWrappers.set(callback, wrappers);
    }

    const existing = wrappers.get(name);
    if (existing) {
      return existing;
    }

    const wrapper: WidgetEventCallback =
      name === '*'
        ? (changes: Array<[string, unknown, unknown]>) => {
            for (const [changeName, next, old] of changes) {
              callback({
                name: changeName,
                new: next,
                old,
                owner: this,
                type: 'change'
              });
            }
          }
        : (next: unknown, old: unknown) => {
            callback({
              name,
              new: next,
              old,
              owner: this,
              type: 'change'
            });
          };

    wrappers.set(name, wrapper);
    return wrapper;
  }

  protected _comm: IComm;
  protected _manager: CommManager;
  protected _state: Record<string, unknown>;
  private _listeners: Map<string, Set<WidgetEventCallback>>;
  private _observerWrappers: Map<
    WidgetObserveCallback,
    Map<string, WidgetEventCallback>
  >;
}

/**
 * A widget with layout/style support.
 */
export class DOMWidget extends Widget {
  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), layout: null, style: null };
  }

  get layout(): Layout | null {
    return (this.get('layout') as Layout | null) ?? null;
  }
  set layout(v: Layout | null) {
    this.set('layout', v);
  }

  get style(): Style | null {
    return (this.get('style') as Style | null) ?? null;
  }
  set style(v: Style | null) {
    this.set('style', v);
  }

  protected override _serializeProperty(name: string, value: unknown): unknown {
    if (
      (name === 'layout' || name === 'style') &&
      (value instanceof Widget || value === null)
    ) {
      return _serializeWidgetReference(value);
    }
    return super._serializeProperty(name, value);
  }

  protected override _deserializeProperty(
    name: string,
    value: unknown
  ): unknown {
    if (name === 'layout' || name === 'style') {
      return _deserializeWidgetReference(this._manager, value);
    }
    return super._deserializeProperty(name, value);
  }
}

// ---------------------------------------------------------------------------
//  Layout and style models
// ---------------------------------------------------------------------------

export class Layout extends Widget {
  static override modelName = 'LayoutModel';
  static override viewName = 'LayoutView';
  static override modelModule = BASE_MODULE;
  static override modelModuleVersion = BASE_MODULE_VERSION;
  static override viewModule = BASE_MODULE;
  static override viewModuleVersion = BASE_MODULE_VERSION;

  protected override _defaults(): Record<string, unknown> {
    return {};
  }
}

export class Style extends Widget {
  static override modelName = 'StyleModel';
  static override viewName = 'StyleView';
  static override modelModule = BASE_MODULE;
  static override modelModuleVersion = BASE_MODULE_VERSION;
  static override viewModule = BASE_MODULE;
  static override viewModuleVersion = BASE_MODULE_VERSION;

  protected override _defaults(): Record<string, unknown> {
    return {};
  }
}

export class DescriptionStyle extends Style {
  static override modelName = 'DescriptionStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;
}

export class SliderStyle extends DescriptionStyle {
  static override modelName = 'SliderStyleModel';
}

export class ProgressStyle extends DescriptionStyle {
  static override modelName = 'ProgressStyleModel';
}

export class ButtonStyle extends Style {
  static override modelName = 'ButtonStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;
}

export class CheckboxStyle extends DescriptionStyle {
  static override modelName = 'CheckboxStyleModel';
}

export class ToggleButtonStyle extends DescriptionStyle {
  static override modelName = 'ToggleButtonStyleModel';
}

export class ToggleButtonsStyle extends DescriptionStyle {
  static override modelName = 'ToggleButtonsStyleModel';
}

export class TextStyle extends DescriptionStyle {
  static override modelName = 'TextStyleModel';
}

export class HTMLStyle extends Style {
  static override modelName = 'HTMLStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;
}

export class HTMLMathStyle extends Style {
  static override modelName = 'HTMLMathStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;
}

export class LabelStyle extends Style {
  static override modelName = 'LabelStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;
}

// ---------------------------------------------------------------------------
//  Numeric - sliders
// ---------------------------------------------------------------------------

class _SliderBase extends DOMWidget {
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

export class IntSlider extends _SliderBase {
  static override modelName = 'IntSliderModel';
  static override viewName = 'IntSliderView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      readout_format: 'd'
    };
  }

  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

export class FloatSlider extends _SliderBase {
  static override modelName = 'FloatSliderModel';
  static override viewName = 'FloatSliderView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      max: 10.0,
      step: 0.1,
      readout_format: '.2f'
    };
  }

  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

export class FloatLogSlider extends _SliderBase {
  static override modelName = 'FloatLogSliderModel';
  static override viewName = 'FloatLogSliderView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      min: 0.0,
      max: 4.0,
      base: 10.0,
      value: 1.0,
      step: 0.1,
      readout_format: '.3g'
    };
  }

  get base(): number {
    return this.get('base') as number;
  }
  set base(v: number) {
    this.set('base', v);
  }
  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

class _RangeSliderBase extends DOMWidget {
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

export class IntRangeSlider extends _RangeSliderBase {
  static override modelName = 'IntRangeSliderModel';
  static override viewName = 'IntRangeSliderView';

  protected override _defaults() {
    return { ...super._defaults(), readout_format: 'd' };
  }

  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

export class FloatRangeSlider extends _RangeSliderBase {
  static override modelName = 'FloatRangeSliderModel';
  static override viewName = 'FloatRangeSliderView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: [0.0, 1.0],
      step: 0.1,
      readout_format: '.2f'
    };
  }

  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

export class Play extends DOMWidget {
  static override modelName = 'PlayModel';
  static override viewName = 'PlayView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      repeat: false,
      playing: false,
      show_repeat: true,
      interval: 100
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
  get repeat(): boolean {
    return this.get('repeat') as boolean;
  }
  set repeat(v: boolean) {
    this.set('repeat', v);
  }
  get playing(): boolean {
    return this.get('playing') as boolean;
  }
  set playing(v: boolean) {
    this.set('playing', v);
  }
  get show_repeat(): boolean {
    return this.get('show_repeat') as boolean;
  }
  set show_repeat(v: boolean) {
    this.set('show_repeat', v);
  }
  get interval(): number {
    return this.get('interval') as number;
  }
  set interval(v: number) {
    this.set('interval', v);
  }
}

// ---------------------------------------------------------------------------
//  Numeric - progress
// ---------------------------------------------------------------------------

class _ProgressBase extends DOMWidget {
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
//  Numeric - text inputs
// ---------------------------------------------------------------------------

class _NumericTextBase extends DOMWidget {
  protected override _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      step: 1,
      continuous_update: false
    };
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
    return {
      ...super._defaults(),
      value: 0.0,
      step: 0.1,
      min: 0.0,
      max: 100.0
    };
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

export class Checkbox extends DOMWidget {
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

export class ToggleButton extends DOMWidget {
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

export class Valid extends DOMWidget {
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

class _SelectionBase extends DOMWidget {
  constructor(state?: Record<string, unknown> & { options?: string[] }) {
    const { options, ...rest } = state ?? {};
    if (options !== undefined) {
      (rest as Record<string, unknown>)._options_labels = options;
      if (rest.index === undefined) {
        (rest as Record<string, unknown>).index = options.length > 0 ? 0 : null;
      }
    }
    super(rest as Record<string, unknown>);
  }

  protected override _defaults(): Record<string, unknown> {
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
  get value(): string | null {
    return this.selectedLabel;
  }
  set value(v: string | null) {
    if (v === null) {
      this.index = null;
      return;
    }
    const idx = this.options.indexOf(v);
    this.index = idx === -1 ? null : idx;
  }
  get label(): string | null {
    return this.selectedLabel;
  }
  set label(v: string | null) {
    this.value = v;
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

class _MultipleSelectionBase extends DOMWidget {
  constructor(state?: Record<string, unknown> & { options?: string[] }) {
    const { options, ...rest } = state ?? {};
    if (options !== undefined) {
      (rest as Record<string, unknown>)._options_labels = options;
      if (rest.index === undefined) {
        (rest as Record<string, unknown>).index = [];
      }
    }
    super(rest as Record<string, unknown>);
  }

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), _options_labels: [], index: [] };
  }

  get options(): string[] {
    return this.get('_options_labels') as string[];
  }
  set options(v: string[]) {
    this.set({ _options_labels: v, index: [] });
  }
  get index(): number[] {
    return [...((this.get('index') as number[]) ?? [])];
  }
  set index(v: number[]) {
    this.set('index', [...v]);
  }
  get value(): string[] {
    return this.selectedLabels;
  }
  set value(v: string[]) {
    this.index = v
      .map(label => this.options.indexOf(label))
      .filter(idx => idx >= 0);
  }
  get label(): string[] {
    return this.selectedLabels;
  }
  set label(v: string[]) {
    this.value = v;
  }

  get selectedLabels(): string[] {
    return this.index.map(idx => this.options[idx]).filter(Boolean);
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

  constructor(state?: Record<string, unknown> & { options?: string[] }) {
    const next = { ...(state ?? {}) };
    const options = next.options as string[] | undefined;
    if (options && next.index === undefined) {
      next.index = options.length > 0 ? [0, 0] : [];
    }
    super(next as Record<string, unknown> & { options?: string[] });
  }

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

// ---------------------------------------------------------------------------
//  String / text
// ---------------------------------------------------------------------------

class _TextBase extends DOMWidget {
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

class _DisplayBase extends DOMWidget {
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

export class Output extends DOMWidget {
  static override modelName = 'OutputModel';
  static override viewName = 'OutputView';
  static override modelModule = OUTPUT_MODULE;
  static override modelModuleVersion = OUTPUT_MODULE_VERSION;
  static override viewModule = OUTPUT_MODULE;
  static override viewModuleVersion = OUTPUT_MODULE_VERSION;

  protected override _defaults() {
    return {
      ...super._defaults(),
      msg_id: '',
      outputs: []
    };
  }

  get msg_id(): string {
    return this.get('msg_id') as string;
  }
  set msg_id(v: string) {
    this.set('msg_id', v);
  }

  get outputs(): Array<Record<string, unknown>> {
    return [...((this.get('outputs') as Array<Record<string, unknown>>) ?? [])];
  }
  set outputs(v: Array<Record<string, unknown>>) {
    this.set('outputs', [...v]);
  }

  get currentMessageId(): string | null {
    return this._manager.getCurrentMessageId();
  }

  clearOutput(_options: { wait?: boolean } = {}): void {
    this.outputs = [];
  }

  appendStdout(text: string): void {
    this._appendOutput({ output_type: 'stream', name: 'stdout', text });
  }

  appendStderr(text: string): void {
    this._appendOutput({ output_type: 'stream', name: 'stderr', text });
  }

  appendDisplayData(
    data: Record<string, unknown>,
    metadata: Record<string, unknown> = {}
  ): void {
    this._appendOutput({
      output_type: 'display_data',
      data,
      metadata
    });
  }

  capture<T extends (...args: any[]) => any>(callback: T): T;
  capture<T extends (...args: any[]) => any>(
    callback: T,
    options: IOutputCaptureOptions
  ): T;
  capture(
    options?: IOutputCaptureOptions
  ): <T extends (...args: any[]) => any>(callback: T) => T;
  capture<T extends (...args: any[]) => any>(
    callbackOrOptions?: T | IOutputCaptureOptions,
    options: IOutputCaptureOptions = {}
  ): T | ((callback: T) => T) {
    if (typeof callbackOrOptions === 'function') {
      return this._captureWrapper(callbackOrOptions, options);
    }

    const captureOptions = callbackOrOptions ?? {};
    return (callback: T) => this._captureWrapper(callback, captureOptions);
  }

  private _appendOutput(output: Record<string, unknown>): void {
    this.outputs = [...this.outputs, output];
  }

  private _captureWrapper<T extends (...args: any[]) => any>(
    callback: T,
    options: IOutputCaptureOptions
  ): T {
    return _wrapCapturedOutputCallback(this, callback, options);
  }

  _captureDepth = 0;
}

// ---------------------------------------------------------------------------
//  Button
// ---------------------------------------------------------------------------

export class Button extends DOMWidget {
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

export class ColorPicker extends DOMWidget {
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

export class Box extends DOMWidget {
  static override modelName = 'BoxModel';
  static override viewName = 'BoxView';

  constructor(state?: Record<string, unknown> & { children?: Widget[] }) {
    const { children, ...rest } = state ?? {};
    super({ ...rest, children: children ?? [] });
  }

  protected override _defaults() {
    return { ...super._defaults(), children: [], box_style: '' };
  }

  get children(): Widget[] {
    return [...((this.get('children') as Widget[]) ?? [])];
  }
  set children(v: Widget[]) {
    this.set('children', [...v]);
  }

  get box_style(): string {
    return this.get('box_style') as string;
  }
  set box_style(v: string) {
    this.set('box_style', v);
  }

  protected override _serializeProperty(name: string, value: unknown): unknown {
    if (name === 'children') {
      return _serializeChildren(
        Array.isArray(value) ? (value as Widget[]) : []
      );
    }
    return super._serializeProperty(name, value);
  }

  protected override _deserializeProperty(
    name: string,
    value: unknown
  ): unknown {
    if (name === 'children') {
      return _deserializeChildren(this._manager, value);
    }
    return super._deserializeProperty(name, value);
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
    const next = { ...(state ?? {}) };
    const childCount = (next.children as Widget[] | undefined)?.length ?? 0;
    const titles = (next.titles as string[] | undefined) ?? [];
    const padded = [...titles];
    while (padded.length < childCount) {
      padded.push('');
    }
    next.titles = padded;
    super(next as Record<string, unknown> & { children?: Widget[] });
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
    const next = [...this.titles];
    while (next.length <= index) {
      next.push('');
    }
    next[index] = title;
    this.titles = next;
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
    const next = { ...(state ?? {}) };
    const children = (next.children as Widget[] | undefined) ?? [];
    if (children.length > 0 && next.selected_index === undefined) {
      next.selected_index = 0;
    }
    super(
      next as Record<string, unknown> & {
        children?: Widget[];
        titles?: string[];
      }
    );
  }
}

export class Stack extends _SelectionContainer {
  static override modelName = 'StackModel';
  static override viewName = 'StackView';
}

// ---------------------------------------------------------------------------
//  Frontend-only link helpers
// ---------------------------------------------------------------------------

export class DirectionalLink extends Widget {
  static override modelName = 'DirectionalLinkModel';
  static override viewName = null;

  protected override _defaults() {
    return {
      source: null,
      target: null
    };
  }

  constructor(
    state?: Record<string, unknown> & {
      source?: WidgetTraitPair;
      target?: WidgetTraitPair;
    }
  ) {
    super(state as Record<string, unknown>);
  }

  get source(): WidgetTraitPair | null {
    return (this.get('source') as WidgetTraitPair | null) ?? null;
  }
  set source(v: WidgetTraitPair | null) {
    this.set('source', v);
  }

  get target(): WidgetTraitPair | null {
    return (this.get('target') as WidgetTraitPair | null) ?? null;
  }
  set target(v: WidgetTraitPair | null) {
    this.set('target', v);
  }

  unlink(): void {
    this.close();
  }

  protected override _serializeProperty(name: string, value: unknown): unknown {
    if ((name === 'source' || name === 'target') && value !== undefined) {
      return _serializeWidgetPair(value as WidgetTraitPair | null);
    }
    return super._serializeProperty(name, value);
  }

  protected override _deserializeProperty(
    name: string,
    value: unknown
  ): unknown {
    if (name === 'source' || name === 'target') {
      return _deserializeWidgetPair(this._manager, value);
    }
    return super._deserializeProperty(name, value);
  }
}

export class Link extends DirectionalLink {
  static override modelName = 'LinkModel';
}

export function jslink(source: WidgetTraitPair, target: WidgetTraitPair): Link {
  return new Link({ source, target });
}

export function jsdlink(
  source: WidgetTraitPair,
  target: WidgetTraitPair
): DirectionalLink {
  return new DirectionalLink({ source, target });
}

// ---------------------------------------------------------------------------
//  Convenience map of all exported widget classes
// ---------------------------------------------------------------------------

/**
 * All widget classes, keyed by class name.
 */
export const widgetClasses: Record<string, typeof Widget> = {
  Widget,
  DOMWidget,
  Layout,
  Style,
  DescriptionStyle,
  SliderStyle,
  ProgressStyle,
  ButtonStyle,
  CheckboxStyle,
  ToggleButtonStyle,
  ToggleButtonsStyle,
  TextStyle,
  HTMLStyle,
  HTMLMathStyle,
  LabelStyle,
  IntSlider,
  FloatSlider,
  FloatLogSlider,
  IntRangeSlider,
  FloatRangeSlider,
  Play,
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
  SelectMultiple,
  ToggleButtons,
  SelectionSlider,
  SelectionRangeSlider,
  Text,
  Textarea,
  Password,
  Combobox,
  Label,
  HTML,
  HTMLMath,
  Output,
  Button,
  ColorPicker,
  Box,
  HBox,
  VBox,
  GridBox,
  Accordion,
  Tab,
  Stack,
  Link,
  DirectionalLink
};

/**
 * Create runtime-local widget classes bound to a specific comm manager.
 */
export function createWidgetClasses(
  manager: CommManager
): Record<string, unknown> {
  const classes: Record<string, unknown> = {};

  for (const [name, cls] of Object.entries(widgetClasses)) {
    const BoundWidgetClass = class extends cls {};
    Object.defineProperty(BoundWidgetClass, 'name', { value: name });
    BoundWidgetClass.setDefaultManager(manager);
    classes[name] = BoundWidgetClass;
  }

  const LinkClass = classes.Link as typeof Link;
  const DirectionalLinkClass =
    classes.DirectionalLink as typeof DirectionalLink;

  classes.jslink = (source: WidgetTraitPair, target: WidgetTraitPair) =>
    new LinkClass({ source, target });
  classes.jsdlink = (source: WidgetTraitPair, target: WidgetTraitPair) =>
    new DirectionalLinkClass({ source, target });

  return classes;
}

/**
 * Resolve serialized `IPY_MODEL_<id>` references back to known widget instances.
 */
function _deserializeChildren(
  manager: CommManager,
  children: unknown
): Widget[] {
  if (!Array.isArray(children)) {
    return [];
  }

  return children
    .map(child => _deserializeWidgetReference(manager, child))
    .filter((child): child is Widget => child instanceof Widget);
}

function _serializeWidgetReference(widget: Widget | null): string | null {
  return widget ? `IPY_MODEL_${widget.commId}` : null;
}

function _deserializeWidgetReference(
  manager: CommManager,
  value: unknown
): Widget | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !value.startsWith('IPY_MODEL_')) {
    return null;
  }
  return manager.getWidget<Widget>(value.slice('IPY_MODEL_'.length)) ?? null;
}

function _serializeWidgetPair(
  pair: WidgetTraitPair | null
): [string, string] | null {
  if (!pair) {
    return null;
  }
  return [`IPY_MODEL_${pair[0].commId}`, pair[1]];
}

function _deserializeWidgetPair(
  manager: CommManager,
  value: unknown
): WidgetTraitPair | null {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }

  const widget = _deserializeWidgetReference(manager, value[0]);
  const name = value[1];
  if (!(widget instanceof Widget) || typeof name !== 'string') {
    return null;
  }

  return [widget, name];
}

function _wrapCapturedOutputCallback<T extends (...args: any[]) => any>(
  output: Output,
  callback: T,
  options: IOutputCaptureOptions
): T {
  return function (this: unknown, ...args: any[]): any {
    const shouldClear = options.clearOutput ?? false;
    if (shouldClear) {
      output.clearOutput({ wait: options.wait });
    }

    const messageId = output.currentMessageId;
    if (messageId) {
      if (output._captureDepth === 0) {
        output.msg_id = messageId;
      }
      output._captureDepth += 1;
    }

    const finish = (): void => {
      if (!messageId) {
        return;
      }
      output._captureDepth = Math.max(0, output._captureDepth - 1);
      if (output._captureDepth === 0 && output.msg_id === messageId) {
        output.msg_id = '';
      }
    };

    try {
      const result = callback.apply(this, args);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return Promise.resolve(result).finally(finish);
      }
      finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  } as T;
}
