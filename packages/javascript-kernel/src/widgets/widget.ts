// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { CommManager, IComm } from '../comm';

import {
  CONTROLS_MODULE,
  CONTROLS_MODULE_VERSION,
  WIDGET_PROTOCOL_VERSION
} from './version';

import type { Layout } from './widget_layout';
import type { Style } from './widget_style';

export type WidgetEventCallback = (...args: any[]) => void;

export interface IWidgetChange {
  name: string;
  new: unknown;
  old: unknown;
  owner: Widget;
  type: 'change';
}

export type WidgetObserveCallback = (change: IWidgetChange) => void;

export type WidgetTraitPair = [Widget, string];

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

  protected _serializeProperty(_name: string, value: unknown): unknown {
    return value;
  }

  protected _deserializeProperty(_name: string, value: unknown): unknown {
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

export function _serializeWidgetReference(
  widget: Widget | null
): string | null {
  return widget ? `IPY_MODEL_${widget.commId}` : null;
}

export function _deserializeWidgetReference(
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

export function _serializeWidgetPair(
  pair: WidgetTraitPair | null
): [string, string] | null {
  if (!pair) {
    return null;
  }
  return [`IPY_MODEL_${pair[0].commId}`, pair[1]];
}

export function _deserializeWidgetPair(
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
