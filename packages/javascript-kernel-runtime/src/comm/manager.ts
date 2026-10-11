// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { hostConsole, uuid } from '../env';
import type { RuntimeOutputHandler } from '../protocol';
import { isThenable } from '../utils';

/**
 * Represents an open comm channel.
 */
export interface IComm {
  readonly commId: string;
  readonly targetName: string;
  send(
    data: Record<string, unknown>,
    metadata?: Record<string, unknown>,
    buffers?: ArrayBuffer[]
  ): void;
  close(data?: Record<string, unknown>): void;
  display(): void;
  onMsg:
    | ((data: Record<string, unknown>, buffers?: ArrayBuffer[]) => void)
    | null;
  onClose:
    | ((data: Record<string, unknown>, buffers?: ArrayBuffer[]) => void)
    | null;
}

/**
 * Handler invoked when the frontend opens a comm targeting a registered name.
 */
export type CommTargetHandler = (
  comm: IComm,
  data: Record<string, unknown>,
  buffers?: ArrayBuffer[]
) => void;

/**
 * Manages comm lifecycle within the runtime.
 */
export class CommManager {
  constructor(
    onOutput: RuntimeOutputHandler,
    options: CommManager.IOptions = {}
  ) {
    this._onOutput = onOutput;
    this._onTargetRegistered = options.onTargetRegistered;
    this._reportError = options.reportError;
  }

  /**
   * Open a new comm channel.
   */
  open(
    targetName: string,
    data: Record<string, unknown> = {},
    metadata: Record<string, unknown> = {},
    buffers?: ArrayBuffer[],
    commId?: string
  ): IComm {
    const id = commId ?? uuid();
    const comm = this._createComm(id, targetName);
    this._comms.set(id, comm);

    this._onOutput({
      type: 'comm_open',
      content: {
        comm_id: id,
        target_name: targetName,
        data
      },
      metadata,
      buffers
    });

    return comm;
  }

  /**
   * Register a handler for frontend-initiated comms targeting the given name.
   */
  registerTarget(targetName: string, handler: CommTargetHandler): void {
    this._targets.set(targetName, handler);
    this._onTargetRegistered?.(targetName);
  }

  /**
   * Whether a comm target handler is registered.
   */
  hasTarget(targetName: string): boolean {
    return this._targets.has(targetName);
  }

  /**
   * Remove a comm target handler registration.
   */
  unregisterTarget(targetName: string): void {
    this._targets.delete(targetName);
  }

  /**
   * Register a widget instance by comm ID.
   *
   * @internal
   */
  registerWidget<T>(commId: string, widget: T): void {
    this._widgets.set(commId, widget);
  }

  /**
   * Look up a widget instance by comm ID.
   *
   * @internal
   */
  getWidget<T>(commId: string): T | undefined {
    return this._widgets.get(commId) as T | undefined;
  }

  /**
   * Remove a widget registration.
   *
   * @internal
   */
  unregisterWidget(commId: string): void {
    this._widgets.delete(commId);
  }

  /**
   * Track the active parent message ID for output capture helpers.
   *
   * @internal
   */
  setCurrentMessageId(messageId: string | null): void {
    this._currentMessageId = messageId;
  }

  /**
   * The active parent message ID, if any.
   *
   * @internal
   */
  getCurrentMessageId(): string | null {
    return this._currentMessageId;
  }

  /**
   * Handle a comm_open message from the frontend.
   *
   * @internal
   */
  handleCommOpen(
    commId: string,
    targetName: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[]
  ): void {
    const handler = this._targets.get(targetName);
    if (!handler) {
      // Close the comm like ipykernel, so that the frontend can fall back
      // (the console would print in the outputs of the running cell)
      this._onOutput({
        type: 'comm_close',
        content: { comm_id: commId, data: {} }
      });
      return;
    }
    const comm = this._createComm(commId, targetName);
    this._comms.set(commId, comm);
    if (!this.invokeCallback(() => handler(comm, data, buffers))) {
      // Close the comm when its handler fails, like ipykernel
      this.invokeCallback(() => comm.close());
    }
  }

  /**
   * Handle a comm_msg message from the frontend.
   *
   * @internal
   */
  handleCommMsg(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[]
  ): void {
    const onMsg = this._comms.get(commId)?.onMsg;
    if (onMsg) {
      this.invokeCallback(() => onMsg(data, buffers));
    }
  }

  /**
   * Handle a comm_close message from the frontend.
   *
   * @internal
   */
  handleCommClose(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[]
  ): void {
    const comm = this._comms.get(commId);
    if (comm) {
      const onClose = comm.onClose;
      if (onClose) {
        this.invokeCallback(() => onClose(data, buffers));
      }
      this._widgets.delete(commId);
      this._comms.delete(commId);
    }
  }

  /**
   * Report an error thrown by a callback of the user, outside of an
   * execution: the evaluator prints it in the outputs.
   *
   * @param error - The thrown value.
   * @param inPromise - Whether the value is the reason of a rejected promise.
   *
   * @internal
   */
  reportError(error: unknown, inPromise = false): void {
    if (this._reportError) {
      this._reportError(error, inPromise);
    } else {
      hostConsole()?.error?.(
        inPromise ? 'Uncaught (in promise)' : 'Uncaught',
        error
      );
    }
  }

  /**
   * Call a callback of the user, like a comm handler or the handler of a
   * widget event, and report its errors, as well as the rejection of the
   * promise it returns.
   *
   * The callbacks are called by the kernel, which may run in another realm
   * than the user code (the page of an iframe), so their errors are caught
   * here rather than by the error listeners of the realm of the user code.
   *
   * @returns Whether the callback returned without throwing.
   *
   * @internal
   */
  invokeCallback(callback: () => unknown): boolean {
    try {
      const result = callback();
      if (isThenable(result)) {
        result.then(undefined, (error: unknown) => {
          this.reportError(error, true);
        });
      }
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  /**
   * Display a widget identified by its comm ID.
   */
  displayWidget(commId: string): void {
    this._onOutput({
      type: 'display_data',
      bundle: {
        data: this.widgetMimeBundle(commId),
        metadata: {},
        transient: {}
      }
    });
  }

  /**
   * The MIME bundle showing the view of a widget.
   *
   * @internal
   */
  widgetMimeBundle(commId: string): {
    'text/plain': string;
    'application/vnd.jupyter.widget-view+json': {
      version_major: number;
      version_minor: number;
      model_id: string;
    };
  } {
    return {
      'text/plain': 'Widget',
      'application/vnd.jupyter.widget-view+json': {
        version_major: 2,
        version_minor: 0,
        model_id: commId
      }
    };
  }

  /**
   * Dispose all comms and clear state.
   */
  dispose(): void {
    this._widgets.clear();
    this._comms.clear();
    this._targets.clear();
  }

  /**
   * Create an IComm instance bound to this manager.
   */
  private _createComm(commId: string, targetName: string): IComm {
    const comm: IComm = {
      get commId() {
        return commId;
      },
      get targetName() {
        return targetName;
      },
      send: (
        data: Record<string, unknown>,
        metadata?: Record<string, unknown>,
        buffers?: ArrayBuffer[]
      ): void => {
        this._onOutput({
          type: 'comm_msg',
          content: {
            comm_id: commId,
            data
          },
          metadata,
          buffers
        });
      },
      close: (data: Record<string, unknown> = {}): void => {
        this._onOutput({
          type: 'comm_close',
          content: {
            comm_id: commId,
            data
          }
        });
        comm.onClose?.(data);
        this._widgets.delete(commId);
        this._comms.delete(commId);
      },
      display: (): void => {
        this.displayWidget(commId);
      },
      onMsg: null,
      onClose: null
    };
    return comm;
  }

  private _onOutput: RuntimeOutputHandler;
  private _onTargetRegistered?: (targetName: string) => void;
  private _reportError?: (error: unknown, inPromise: boolean) => void;
  private _comms = new Map<string, IComm>();
  private _targets = new Map<string, CommTargetHandler>();
  private _widgets = new Map<string, unknown>();
  private _currentMessageId: string | null = null;
}

/**
 * A namespace for CommManager statics.
 */
export namespace CommManager {
  /**
   * The options of a comm manager.
   */
  export interface IOptions {
    /**
     * Called when a comm target is registered, for kernels that must
     * register the targets on their side before the frontend can open comms.
     */
    onTargetRegistered?: (targetName: string) => void;

    /**
     * Called with the errors thrown by the comm handlers and the callbacks
     * of the widgets, and the rejections of the promises they return, to
     * show them to the user. Defaults to the console of the host.
     */
    reportError?: (error: unknown, inPromise: boolean) => void;
  }
}
