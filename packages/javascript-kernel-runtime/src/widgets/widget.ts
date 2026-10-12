// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { CommManager, IComm } from '../comm';
import type { IParentMessage } from '../output_router';
import { isPlainObject, isUint8Array, toBytes } from '../utils';

import {
  CONTROLS_MODULE,
  CONTROLS_MODULE_VERSION,
  WIDGET_PROTOCOL_VERSION
} from './version';

export type WidgetEventCallback = (...args: any[]) => void;

/**
 * A callback of the custom messages of the frontend, with their content and
 * their binary buffers.
 */
export type WidgetMessageCallback = (
  content: unknown,
  buffers: ArrayBuffer[]
) => void;

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
 * A change of the state of a widget: the name of the property, its new
 * value and its old value.
 */
export type WidgetStateChange = [string, unknown, unknown];

/**
 * A widget class, which creates its widget from its state.
 */
export type WidgetClass<T extends Widget = Widget> = new (
  state?: Record<string, unknown>
) => T;

/**
 * The path of a binary value in the state of a widget: the keys of the
 * objects and the indices of the arrays holding it.
 */
export type BufferPath = Array<string | number>;

/**
 * The serialized state of a widget, as sent to the frontend: its binary
 * values are in `buffers`, with null in their place in `state`, and their
 * paths in `bufferPaths`.
 */
export interface ISerializedState {
  state: Record<string, unknown>;
  buffers: ArrayBuffer[];
  bufferPaths: BufferPath[];
}

/**
 * The manager of the widgets created by `_createWidget()` from a class
 * without a default manager.
 */
let creatingManager: CommManager | null = null;

/**
 * The prototypes which have the accessors of their traits.
 */
const prototypesWithTraits = new WeakSet<object>();

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
   * The classes bound to the default manager of this class, by base class,
   * which `_createWidget()` creates.
   *
   * @internal
   */
  static _boundClasses: ReadonlyMap<WidgetClass, WidgetClass> | null = null;

  /**
   * Set the default CommManager used by all Widget instances.
   */
  static setDefaultManager(manager: CommManager | null): void {
    this._defaultManager = manager;
  }

  /**
   * Create a widget from its state. The properties of `_defaults()` get
   * accessors, like `widget.value`, and the state is validated with
   * `_validate()` before it is sent to the frontend. The properties given
   * as `undefined` keep their default, like the ones left out.
   */
  constructor(state?: Record<string, unknown>) {
    const ctor = this.constructor as typeof Widget;
    const manager = ctor._defaultManager ?? creatingManager;
    if (!manager) {
      throw new Error(
        'Widget manager not initialized. Widgets can only be created inside the kernel runtime.'
      );
    }

    this._manager = manager;
    this._listeners = new Map();
    this._observerWrappers = new Map();
    const defaults = this._defaults();
    defineTraits(Object.getPrototypeOf(this), Object.keys(defaults));
    const given = withoutUndefined(state ?? {});
    const initial = { ...defaults, ...given };
    this._validateState(initial, new Set(Object.keys(given)));
    this._state = { ...initial, ...this._modelState(ctor) };

    const {
      state: serialized,
      buffers,
      bufferPaths
    } = this._serializeStateWithBuffers(this._state);
    this._comm = manager.open(
      'jupyter.widget',
      { state: serialized, buffer_paths: bufferPaths },
      { version: WIDGET_PROTOCOL_VERSION },
      buffers
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
   * Close the widget and its comm channel, and call the 'close' listeners.
   * Closing it again does nothing, and a closed widget sends nothing to the
   * frontend, like in ipywidgets.
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
   * Set one or more state properties and sync to the frontend. The new
   * state is validated first, like a value clamped to the bounds of a
   * slider. The properties set to `undefined` keep their value.
   */
  set(name: string, value: unknown): void;
  set(state: Record<string, unknown>): void;
  set(nameOrState: string | Record<string, unknown>, value?: unknown): void {
    const updates = withoutUndefined(
      typeof nameOrState === 'string' ? { [nameOrState]: value } : nameOrState
    );
    const next = { ...this._state, ...updates };
    this._validateState(next, new Set(Object.keys(updates)));

    const changes = this._applyState(next);
    if (changes.length > 0) {
      this._sendState(Object.fromEntries(changes));
    }
    this._notify(changes);
  }

  /**
   * Send a custom message to the frontend, like the model of a custom
   * widget handles in `model.on('msg:custom', ...)`.
   */
  send(content: unknown, buffers?: Array<ArrayBuffer | ArrayBufferView>): void {
    const bytes = (buffers ?? []).map(buffer => {
      const data = toBytes(buffer);
      if (data === null) {
        throw new TypeError(
          'The buffers of a message must be ArrayBuffers or typed arrays'
        );
      }
      return data.slice().buffer;
    });
    this._comm.send({ method: 'custom', content }, undefined, bytes);
  }

  /**
   * Call a function with the content and the buffers of the custom messages
   * of the frontend, like the clicks of a button.
   */
  onMsg(callback: WidgetMessageCallback): this {
    return this.on('msg:custom', callback);
  }

  /**
   * Remove a callback added with `onMsg()`.
   */
  offMsg(callback: WidgetMessageCallback): this {
    return this.off('msg:custom', callback);
  }

  /**
   * Listen for widget events.
   *
   * Events:
   * - `'change:propName'` - property changed `(newValue, oldValue)`
   * - `'change'` - any property changed `(changes)`
   * - `'msg:custom'` - custom message of the frontend `(content, buffers)`
   * - `'close'` - comm closed
   *
   * When the frontend triggers the event, like when the user moves a slider,
   * the outputs of the callback go to the cell which registered it.
   */
  on(event: string, callback: WidgetEventCallback): this {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Map());
    }
    const listeners = this._listeners.get(event)!;
    if (!listeners.has(callback)) {
      listeners.set(callback, this._manager.router.context());
    }
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

  /**
   * The default state of the widget. Its properties not starting with `_`
   * get accessors, like `widget.value`.
   */
  protected _defaults(): Record<string, unknown> {
    return { description: '', disabled: false };
  }

  /**
   * Validate a new state of the widget before it is applied, like the
   * validators of ipywidgets: coerce its values in place, or throw to reject
   * it. It is called with the whole state, in the constructor, for `set()`
   * and for the updates of the frontend, which get back the values changed
   * here. When it throws, the widgets it created with `_createWidget()`, like
   * a default layout, are closed.
   *
   * @param state - The whole new state, to update in place.
   * @param names - The names of the properties being set: the ones given to
   * the constructor, to `set()`, or sent by the frontend.
   */
  protected _validate(
    _state: Record<string, unknown>,
    _names: ReadonlySet<string>
  ): void {
    // Nothing to validate
  }

  /**
   * Create a widget of another class with the manager of this one, like the
   * default layout of a widget: the class of `Jupyter.widgets` bound to the
   * manager when there is one, so that `instanceof` works with it.
   */
  protected _createWidget<T extends Widget>(
    cls: WidgetClass<T>,
    state?: Record<string, unknown>
  ): T {
    const ctor = this.constructor as typeof Widget;
    const bound = (ctor._boundClasses?.get(cls) ?? cls) as WidgetClass<T>;
    const previous = creatingManager;
    creatingManager = this._manager;
    let widget: T;
    try {
      widget = new bound(state);
    } finally {
      creatingManager = previous;
    }
    this._validationWidgets?.push(widget);
    return widget;
  }

  /**
   * Validate a new state with `_validate()`. When it is rejected, close the
   * widgets created for it, like a default layout, so that they do not stay
   * open in the frontend.
   */
  private _validateState(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    const previous = this._validationWidgets;
    const created: Widget[] = [];
    this._validationWidgets = created;
    try {
      this._validate(state, names);
    } catch (error) {
      for (const widget of created) {
        widget.close();
      }
      throw error;
    } finally {
      this._validationWidgets = previous;
    }
  }

  protected _handleMsg(
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[]
  ): void {
    if (data.method === 'update' && data.state) {
      const state = { ...(data.state as Record<string, unknown>) };
      // Binary values are sent as buffers, with their path in the state
      putBuffers(
        state,
        (data.buffer_paths as BufferPath[] | undefined) ?? [],
        buffers,
        this._manager.realmConstructor('Uint8Array')
      );
      const received: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(state)) {
        received[key] = this._deserializeProperty(key, val);
      }
      const next = { ...this._state, ...received };
      this._validateState(next, new Set(Object.keys(received)));

      // Send back the values changed by the validation, like a clamped value
      const corrected: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(next)) {
        const sent = Object.prototype.hasOwnProperty.call(received, key)
          ? received[key]
          : this._state[key];
        if (sent !== val) {
          corrected[key] = val;
        }
      }
      const changes = this._applyState(next);
      if (Object.keys(corrected).length > 0) {
        this._sendState(corrected);
      }
      this._notify(changes);
    }

    if (data.method === 'request_state') {
      this._sendState(this._state);
    }

    if (data.method === 'custom') {
      this._trigger('msg:custom', data.content, buffers ?? []);
    }
  }

  /**
   * Store a new state, and return its changes.
   */
  private _applyState(next: Record<string, unknown>): WidgetStateChange[] {
    const changes: WidgetStateChange[] = [];
    for (const [key, val] of Object.entries(next)) {
      const old = this._state[key];
      if (old !== val) {
        this._state[key] = val;
        changes.push([key, val, old]);
      }
    }
    return changes;
  }

  /**
   * Call the listeners of some changes of the state: the ones of each
   * property, then the ones of all the changes.
   */
  protected _notify(changes: WidgetStateChange[]): void {
    for (const [key, val, old] of changes) {
      this._trigger(`change:${key}`, val, old);
    }
    if (changes.length > 0) {
      this._trigger('change', changes);
    }
  }

  /**
   * Send some state to the frontend.
   */
  protected _sendState(state: Record<string, unknown>): void {
    const {
      state: serialized,
      buffers,
      bufferPaths
    } = this._serializeStateWithBuffers(state);
    this._comm.send(
      { method: 'update', state: serialized, buffer_paths: bufferPaths },
      undefined,
      buffers
    );
  }

  /**
   * The whole state of the widget, serialized with its binary values in
   * buffers, for a frontend restoring its model, like the widget manager of
   * a notebook reopened on a running kernel.
   *
   * @internal
   */
  _serializeFullState(): ISerializedState {
    return this._serializeStateWithBuffers(this._state);
  }

  /**
   * Serialize some state, with the binary values (ArrayBuffer, typed arrays)
   * in buffers, and their paths in the state. The binary values can be
   * nested in the arrays and plain objects of the state.
   */
  protected _serializeStateWithBuffers(
    state: Record<string, unknown>
  ): ISerializedState {
    const serialized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state)) {
      serialized[key] =
        toBytes(value) !== null ? value : this._serializeProperty(key, value);
    }
    return removeBuffers(serialized);
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

  /**
   * The bytes of a binary value (ArrayBuffer, typed array) as a Uint8Array
   * of the realm of the cells, sharing its memory, or null for another
   * value. A Uint8Array of any realm is kept.
   */
  protected _toBytes(value: unknown): Uint8Array | null {
    if (isUint8Array(value)) {
      return value;
    }
    const bytes = toBytes(value);
    if (bytes === null) {
      return null;
    }
    const RealmUint8Array = this._manager.realmConstructor('Uint8Array');
    return new RealmUint8Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    );
  }

  /**
   * Call the listeners of an event. Their errors, and the rejections of the
   * promises they return, are shown in the outputs.
   */
  protected _trigger(event: string, ...args: unknown[]): void {
    for (const [cb, parent] of this._listeners.get(event) ?? []) {
      this._manager.invokeCallback(() => cb(...args), parent);
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
        ? (changes: WidgetStateChange[]) => {
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
  private _listeners: Map<string, Map<WidgetEventCallback, IParentMessage>>;
  private _observerWrappers: Map<
    WidgetObserveCallback,
    Map<string, WidgetEventCallback>
  >;
  // Set by `_validateState()` while `_validate()` runs, in the constructor:
  // declared without a field, which would reset it after `super()`
  declare private _validationWidgets: Widget[] | undefined;
}

/**
 * The properties of a state which are not `undefined`: like an option left
 * out, an `undefined` property keeps the default or the current value.
 */
function withoutUndefined(
  state: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => value !== undefined)
  );
}

/**
 * Define the accessors of the traits of a widget class on its prototype,
 * like `slider.value`, for the properties of its default state without one.
 */
function defineTraits(prototype: object, names: string[]): void {
  if (prototypesWithTraits.has(prototype)) {
    return;
  }
  prototypesWithTraits.add(prototype);
  for (const name of names) {
    if (name.startsWith('_') || name in prototype) {
      continue;
    }
    Object.defineProperty(prototype, name, {
      get(this: Widget) {
        return this.get(name);
      },
      set(this: Widget, value: unknown) {
        this.set(name, value);
      },
      configurable: true
    });
  }
}

/**
 * The serialized reference to a widget, `IPY_MODEL_<comm id>`.
 *
 * @internal
 */
export function _serializeWidgetReference(
  widget: Widget | null
): string | null {
  return widget ? `IPY_MODEL_${widget.commId}` : null;
}

/**
 * The widget of a serialized reference, or null.
 *
 * @internal
 */
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

/**
 * The serialized pair of a widget and one of its traits, for links.
 *
 * @internal
 */
export function _serializeWidgetPair(
  pair: WidgetTraitPair | null
): [string, string] | null {
  if (!pair) {
    return null;
  }
  return [`IPY_MODEL_${pair[0].commId}`, pair[1]];
}

/**
 * The pair of a widget and one of its traits, from its serialized form.
 *
 * @internal
 */
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

/**
 * Move the binary values of some state to buffers, like ipywidgets: they can
 * be nested in arrays and plain objects, which are copied, and get null in
 * their place.
 */
function removeBuffers(state: Record<string, unknown>): ISerializedState {
  const buffers: ArrayBuffer[] = [];
  const bufferPaths: BufferPath[] = [];
  const visiting = new Set<unknown>();

  const remove = (value: unknown, path: BufferPath): unknown => {
    const bytes = toBytes(value);
    if (bytes !== null) {
      buffers.push(bytes.slice().buffer);
      bufferPaths.push(path);
      return null;
    }
    const isArray = Array.isArray(value);
    if ((!isArray && !isPlainObject(value)) || visiting.has(value)) {
      return value;
    }
    visiting.add(value);
    const container = value as Record<string | number, unknown>;
    let copy: Record<string | number, unknown> | null = null;
    for (const [key, item] of Object.entries(container)) {
      const index = isArray ? Number(key) : key;
      const next = remove(item, [...path, index]);
      if (next !== item) {
        copy ??= (
          isArray ? [...(value as unknown[])] : { ...container }
        ) as Record<string | number, unknown>;
        copy[index] = next;
      }
    }
    visiting.delete(value);
    return copy ?? value;
  };

  const serialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    serialized[key] = remove(value, [key]);
  }
  return { state: serialized, buffers, bufferPaths };
}

/**
 * Put the buffers of a message of the frontend in its state, at their paths,
 * as bytes, like the contents of the files of a FileUpload at
 * `['value', 0, 'content']`.
 */
function putBuffers(
  state: Record<string, unknown>,
  bufferPaths: BufferPath[],
  buffers: ArrayBuffer[] | undefined,
  Bytes: Uint8ArrayConstructor
): void {
  bufferPaths.forEach((path, i) => {
    const buffer = buffers?.[i];
    if (!buffer || !Array.isArray(path) || path.length === 0) {
      return;
    }
    let target: unknown = state;
    for (const key of path.slice(0, -1)) {
      if (
        typeof target !== 'object' ||
        target === null ||
        !Object.prototype.hasOwnProperty.call(target, key)
      ) {
        return;
      }
      target = (target as Record<string | number, unknown>)[key];
    }
    const key = path[path.length - 1];
    if (typeof target === 'object' && target !== null && key !== '__proto__') {
      (target as Record<string | number, unknown>)[key] = new Bytes(buffer);
    }
  });
}
