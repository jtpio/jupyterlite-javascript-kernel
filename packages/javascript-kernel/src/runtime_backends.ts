// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';
import { PageConfig } from '@jupyterlab/coreutils';

import { PromiseDelegate } from '@lumino/coreutils';

import * as Comlink from 'comlink';

import {
  JavaScriptExecutor,
  normalizeError,
  type IExecutorOptions,
  type ILiveNode,
  type RuntimeOutputHandler,
  type RuntimeOutputMessage
} from '@jupyterlite/javascript-kernel-runtime';

import { createRemoteRuntimeApi } from './runtime_remote';
import {
  RUNTIME_CLOSED_MESSAGE,
  type IRemoteRuntimeApi,
  type IRuntimeExecuteOptions,
  type RuntimeOutputCallback
} from './runtime_protocol';

/**
 * Shared options for runtime backend implementations.
 */
export interface IRuntimeBackendOptions {
  onOutput: RuntimeOutputHandler;
  baseUrl?: string;

  /**
   * The number of characters a cell can print on stdout and stderr, 0 for
   * no limit. Defaults to the limit of the runtime package.
   */
  maxStreamOutput?: number;

  /**
   * The time in milliseconds a loop of the cells can keep the runtime busy
   * before it is stopped with a LoopTimeoutError, 0 for no limit. Defaults
   * to 10 s in the iframe, which runs on the thread of the page, and to no
   * limit in the Web Worker.
   */
  loopTimeout?: number;

  /**
   * The options of the executor, like the CDN of the magic imports, applied
   * when the runtime starts.
   */
  executorOptions?: IExecutorOptions;
}

/**
 * The error of a request to a Web Worker runtime restarted because its code
 * did not stop when the kernel was interrupted.
 */
export class RuntimeRestartedError extends Error {
  constructor() {
    super(
      'The code did not stop, so the Web Worker was restarted: the variables, functions and imports of the previous cells are lost. Run those cells again.'
    );
    this.name = 'RuntimeRestartedError';
  }
}

/**
 * The error of a request to an iframe runtime restarted because the code of
 * a cell reloaded the iframe or navigated it away.
 */
export class RuntimeReloadedError extends Error {
  constructor() {
    super(
      'The code reloaded or left the page of the iframe, so the runtime was restarted: the variables, functions and imports of the previous cells are lost. Run those cells again.'
    );
    this.name = 'RuntimeReloadedError';
  }
}

/**
 * The error of the requests to a runtime which stopped, for example a Web
 * Worker closed by the code of a cell.
 */
export class RuntimeStoppedError extends Error {
  constructor(reason: string) {
    super(`The JavaScript runtime stopped: ${reason}. Restart the kernel.`);
    this.name = 'RuntimeStoppedError';
  }
}

/**
 * The error of the requests to a runtime which failed to start, like a Web
 * Worker whose script could not be loaded, or an iframe which did not load
 * in time.
 */
export class RuntimeStartupError extends Error {
  constructor(reason: string) {
    super(
      `JavaScript runtime failed to start: ${reason.replace(/\.$/, '')}. Restart the kernel to try again.`
    );
    this.name = 'RuntimeStartupError';
  }
}

/**
 * Interface implemented by all execution runtime backends.
 */
export interface IRuntimeBackend {
  readonly ready: Promise<void>;
  dispose(): void;

  /**
   * Interrupt the running cell, if any, and clear the timers of the cells.
   */
  interrupt(): Promise<void>;

  /**
   * Execute the code of a cell, with the options of its execute_request,
   * like `silent` and `allowStdin`.
   */
  execute(
    code: string,
    executionCount: number,
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader,
    options?: IRuntimeExecuteOptions
  ): Promise<KernelMessage.IExecuteReplyMsg['content']>;
  complete(
    code: string,
    cursorPos: number
  ): Promise<KernelMessage.ICompleteReplyMsg['content']>;
  inspect(
    code: string,
    cursorPos: number,
    detailLevel: KernelMessage.IInspectRequestMsg['content']['detail_level']
  ): Promise<KernelMessage.IInspectReplyMsg['content']>;
  isComplete(
    code: string
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']>;
  /**
   * Handle a comm message of the frontend: the outputs captured by an
   * Output widget, and the comm messages sent by the handler, go to
   * `parentHeader`.
   */
  handleCommOpen(
    commId: string,
    targetName: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader
  ): Promise<void>;
  handleCommMsg(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader
  ): Promise<void>;
  handleCommClose(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader
  ): Promise<void>;
}

/**
 * Base class providing the shared request logic of the runtime backends,
 * whether the runtime API is called directly or through a Comlink proxy.
 *
 * Subclasses must set `_remote` during initialization and call
 * `_ready.resolve()` / `_ready.reject()` to signal readiness.
 */
abstract class AbstractRuntimeBackend<
  TRemote extends IRemoteRuntimeApi
> implements IRuntimeBackend {
  /**
   * A promise that resolves when the runtime is initialized.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  abstract dispose(): void;

  abstract interrupt(): Promise<void>;

  /**
   * Execute code via the remote runtime API.
   */
  async execute(
    code: string,
    executionCount: number,
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader,
    options?: IRuntimeExecuteOptions
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    await this.ready;
    const reply = this._call<KernelMessage.IExecuteReplyMsg['content']>(
      remote =>
        remote.execute(
          code,
          executionCount,
          parentMessageId,
          parentHeader,
          options
        )
    );
    this._running = reply;
    try {
      return await reply;
    } finally {
      if (this._running === reply) {
        this._running = null;
      }
    }
  }

  /**
   * Complete code via the remote runtime API.
   */
  async complete(
    code: string,
    cursorPos: number
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    await this.ready;
    return this._call<KernelMessage.ICompleteReplyMsg['content']>(remote =>
      remote.complete(code, cursorPos)
    );
  }

  /**
   * Inspect code via the remote runtime API.
   */
  async inspect(
    code: string,
    cursorPos: number,
    detailLevel: KernelMessage.IInspectRequestMsg['content']['detail_level']
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    await this.ready;
    return this._call<KernelMessage.IInspectReplyMsg['content']>(remote =>
      remote.inspect(code, cursorPos, detailLevel)
    );
  }

  /**
   * Check code completeness via the remote runtime API.
   */
  async isComplete(
    code: string
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    await this.ready;
    return this._call<KernelMessage.IIsCompleteReplyMsg['content']>(remote =>
      remote.isComplete(code)
    );
  }

  /**
   * Forward comm_open to the remote runtime.
   */
  async handleCommOpen(
    commId: string,
    targetName: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader
  ): Promise<void> {
    await this.ready;
    await this._callComm(remote =>
      remote.handleCommOpen(
        commId,
        targetName,
        data,
        buffers,
        parentMessageId,
        parentHeader
      )
    );
  }

  /**
   * Forward comm_msg to the remote runtime.
   */
  async handleCommMsg(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader
  ): Promise<void> {
    await this.ready;
    await this._callComm(remote =>
      remote.handleCommMsg(commId, data, buffers, parentMessageId, parentHeader)
    );
  }

  /**
   * Forward comm_close to the remote runtime.
   */
  async handleCommClose(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader
  ): Promise<void> {
    await this.ready;
    await this._callComm(remote =>
      remote.handleCommClose(
        commId,
        data,
        buffers,
        parentMessageId,
        parentHeader
      )
    );
  }

  /**
   * Send a request to the remote runtime. The request fails when the runtime
   * stops or restarts before replying, which would never come.
   */
  protected async _call<T>(
    request: (remote: TRemote) => Promise<T>
  ): Promise<T> {
    if (this._stopped) {
      throw this._stopped;
    }
    if (!this._remote) {
      throw new Error(`${this._runtimeLabel} runtime is not initialized`);
    }
    return Promise.race([request(this._remote), this._lost.promise]);
  }

  /**
   * Send a comm message to the remote runtime, unless it is not initialized
   * or stopped: the comms of a stopped runtime are gone.
   */
  private async _callComm(
    request: (remote: TRemote) => Promise<void>
  ): Promise<void> {
    if (!this._remote || this._stopped) {
      return;
    }
    try {
      await this._call(request);
    } catch (error) {
      if (
        !(error instanceof RuntimeStoppedError) &&
        !(error instanceof RuntimeRestartedError) &&
        !(error instanceof RuntimeReloadedError)
      ) {
        throw error;
      }
    }
  }

  /**
   * Fail the pending requests, which will never get a reply.
   */
  protected _rejectPending(error: Error): void {
    this._lost.reject(error);
    this._lost = createLostDelegate();
  }

  /**
   * Stop the runtime: the pending and later requests fail with the error.
   */
  protected _stop(error: RuntimeStoppedError): void {
    if (this._stopped || this._isDisposed) {
      return;
    }
    this._stopped = error;
    this._rejectPending(error);
  }

  /**
   * Publish an output of the runtime, unless the backend is disposed: the
   * outputs sent before the runtime stopped can still arrive after.
   */
  protected _publishOutput(message: RuntimeOutputMessage): void {
    if (!this._isDisposed) {
      this._options.onOutput(message);
    }
  }

  /** Human-readable label used in error messages. */
  protected abstract readonly _runtimeLabel: string;
  protected abstract readonly _options: IRuntimeBackendOptions;
  protected _isDisposed = false;
  protected _isReady = false;
  protected _ready = new PromiseDelegate<void>();
  protected _remote: TRemote | null = null;

  /**
   * The request executing a cell, if any.
   */
  protected _running: Promise<unknown> | null = null;
  private _lost = createLostDelegate();
  private _stopped: RuntimeStoppedError | null = null;
}

/**
 * A promise rejected when the pending requests to a runtime will never get
 * a reply.
 */
function createLostDelegate(): PromiseDelegate<never> {
  const delegate = new PromiseDelegate<never>();
  delegate.promise.catch(() => undefined);
  return delegate;
}

/**
 * Create the container of the runtime iframe: rendered, so that the DOM of
 * the cells has a layout and the animation frames run, but invisible.
 *
 * With `display: none`, the elements of the iframe have no size, like
 * `offsetWidth` and `getBoundingClientRect()`, and some browsers stop the
 * animation frames. The container is instead fixed on the page, with the size
 * of the iframe, hidden with `visibility: hidden`, and `inert` and
 * `aria-hidden`, so that the users and the assistive technologies do not
 * reach the elements of the cells. The code of the cells can still focus
 * them: the backend then gives the focus back to the page.
 */
function createHiddenContainer(): HTMLDivElement {
  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: `${IFrameRuntimeBackend.FRAME_WIDTH}px`,
    height: `${IFrameRuntimeBackend.FRAME_HEIGHT}px`,
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none'
  });
  container.inert = true;
  container.setAttribute('aria-hidden', 'true');
  return container;
}

/**
 * Runtime backend that executes code in a hidden iframe.
 *
 * The runtime API lives in the page, next to the kernel, and runs the code of
 * the cells in the realm of the iframe: the backend calls it directly. No
 * message goes through the window of the iframe, which any other window
 * holding a reference to it could post to.
 */
export class IFrameRuntimeBackend extends AbstractRuntimeBackend<IRemoteRuntimeApi> {
  /**
   * Instantiate a new iframe runtime backend.
   */
  constructor(options: IFrameRuntimeBackend.IOptions) {
    super();
    this._options = options;
    window.addEventListener('blur', this._onFocusChange);
    window.addEventListener('focus', this._onFocusChange);
    document.addEventListener('visibilitychange', this._onFocusChange);
    document.addEventListener('focusin', this._onPageFocusIn, true);
    IFrameRuntimeBackend._backends.add(this);
    void this._start();
  }

  /**
   * Find a DOM node shown live by an iframe runtime of the page, from the id
   * of its output, with the LIVE_NODE_MIME_TYPE MIME type. Returns null when
   * no running runtime has it: after a restart of the kernel, or when the
   * output comes from a notebook file.
   */
  static findLiveNode(id: string): ILiveNode | null {
    for (const backend of IFrameRuntimeBackend._backends) {
      const node = backend._executor?.liveNodes?.get(id);
      if (node) {
        return node;
      }
    }
    return null;
  }

  /**
   * The iframe used by the runtime backend. A new iframe replaces it when
   * the code of a cell reloads the iframe.
   */
  get iframe(): HTMLIFrameElement | null {
    return this._iframe;
  }

  /**
   * Interrupt the running cell. The runtime shares the thread of the page:
   * when the page handles the interrupt, the cell is waiting for a promise,
   * so it stops at once. The loops that never yield are stopped by the loop
   * timeout, as the page can not handle the interrupt during them.
   */
  async interrupt(): Promise<void> {
    if (this._isReady && !this._isDisposed) {
      await this._call(remote => remote.interrupt());
    }
  }

  /**
   * Execute the code of a cell, then give the focus back to the page if the
   * cell focused an element of the iframe while the page did not have it.
   */
  async execute(
    code: string,
    executionCount: number,
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader,
    options?: IRuntimeExecuteOptions
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    try {
      return await super.execute(
        code,
        executionCount,
        parentMessageId,
        parentHeader,
        options
      );
    } finally {
      this._watchFrameFocus();
      this._restoreFocus();
    }
  }

  /**
   * Dispose iframe resources.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._ready.reject(new Error('IFrame runtime disposed'));
    this._rejectPending(new Error('IFrame runtime disposed'));
    this._teardown();
    window.removeEventListener('blur', this._onFocusChange);
    window.removeEventListener('focus', this._onFocusChange);
    document.removeEventListener('visibilitychange', this._onFocusChange);
    document.removeEventListener('focusin', this._onPageFocusIn, true);
    IFrameRuntimeBackend._backends.delete(this);
    this._focused = null;

    this._container?.remove();
    this._container = null;
  }

  /**
   * Create an iframe, and initialize the runtime API in its realm.
   */
  private async _start(): Promise<void> {
    const iframe = document.createElement('iframe');
    try {
      if (!this._container) {
        this._container = createHiddenContainer();
        document.body.appendChild(this._container);
      }
      const container = this._container;

      iframe.style.border = 'none';
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>JavaScript Kernel</title>
</head>
<body></body>
</html>`;
      this._iframe = iframe;

      const iframeLoad = new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          iframe.onload = null;
          iframe.onerror = null;
        };

        iframe.onload = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve();
        };
        iframe.onerror = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error('IFrame runtime failed to load'));
        };
      });

      container.appendChild(iframe);

      await withTimeout(
        iframeLoad,
        IFrameRuntimeBackend.STARTUP_TIMEOUT_MS,
        'IFrame runtime failed to load'
      );
      if (this._iframe !== iframe) {
        // Disposed while loading
        return;
      }
      if (!iframe.contentWindow || !iframe.contentDocument) {
        throw new Error('IFrame window not available');
      }

      // The later loads of the iframe come from the code of the cells
      this._document = iframe.contentDocument;
      iframe.addEventListener('load', this._onLoad);
      this._watchFrameFocus();

      const globalScope = iframe.contentWindow as Record<string, any>;
      const executor =
        this._options.executorFactory?.(globalScope) ??
        new JavaScriptExecutor(globalScope);
      const remote = createRemoteRuntimeApi(globalScope, executor);
      this._remote = remote;
      this._executor = executor;

      await withTimeout(
        remote.initialize(
          {
            baseUrl: resolveBaseUrl(this._options.baseUrl),
            maxStreamOutput: this._options.maxStreamOutput,
            executorOptions: this._options.executorOptions,
            loopTimeout:
              this._options.loopTimeout ??
              IFrameRuntimeBackend.DEFAULT_LOOP_TIMEOUT_MS
          },
          message => {
            if (this._remote === remote) {
              this._publishOutput(message);
            }
          }
        ),
        IFrameRuntimeBackend.STARTUP_TIMEOUT_MS,
        'IFrame runtime failed to initialize'
      );

      await this._options.onReady?.({
        iframe,
        container,
        globalScope,
        executor,
        execute: (code, executionCount = 0) =>
          remote.execute(code, executionCount),
        preloadModule: moduleName => remote.preloadModule(moduleName),
        registerCommTarget: (targetName, moduleName, exportName) =>
          remote.registerCommTarget(targetName, moduleName, exportName),
        unregisterCommTarget: targetName =>
          remote.unregisterCommTarget(targetName)
      });

      if (this._remote !== remote) {
        // Disposed, or restarted, during the initialization
        return;
      }
      this._isReady = true;
      this._ready.resolve();
    } catch (error) {
      if (this._iframe === iframe) {
        this._teardown();
        this._ready.reject(error);
      }
    }
  }

  /**
   * Handle a load of the iframe after its initialization.
   *
   * `document.write()` after the load opens the document again, but keeps it
   * with the window and the state of the cells, so nothing changes. A new
   * document means that the code reloaded the iframe or navigated it away,
   * like with `location.reload()`: the realm of the cells is gone, and a new
   * iframe replaces it.
   */
  private _onLoad = (): void => {
    const iframe = this._iframe;
    if (
      this._isDisposed ||
      !iframe ||
      iframe.contentDocument === this._document
    ) {
      return;
    }
    this._restart();
  };

  /**
   * Keep the element of the page which has the focus, to give it back when
   * the iframe takes the focus.
   */
  private _onPageFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof HTMLElement) {
      this._focused = event.target;
    }
  };

  /**
   * Check where the focus went when the page or the iframe gains or loses
   * it, or when the page is shown again, once the focus has moved.
   */
  private _onFocusChange = (): void => {
    setTimeout(() => this._restoreFocus());
  };

  /**
   * Listen to the focus of the window of the iframe: when the user comes
   * back to a page whose iframe took the focus while the page did not have
   * it, the window of the iframe gets the focus, and the page none. The
   * listeners in the iframe go away when a cell opens its document again,
   * so this runs after each cell, and adding the same listener twice does
   * nothing.
   */
  private _watchFrameFocus(): void {
    this._iframe?.contentWindow?.addEventListener('focus', this._onFocusChange);
  }

  /**
   * Give the focus back to the page when the code of a cell focused an
   * element of the hidden iframe, like with `input.focus()`: the keyboard
   * keeps going to the notebook. The page loses the focus to the iframe
   * without a focus event on the iframe, so the page checks where the focus
   * is when it loses or gains it, when it is shown again and after each
   * cell. The page does not scroll back to the element which gets the focus.
   */
  private _restoreFocus(): void {
    const iframe = this._iframe;
    if (!iframe || document.activeElement !== iframe) {
      return;
    }
    this._focused?.focus({ preventScroll: true });
    if (document.activeElement === iframe) {
      // The element is gone, or can not take the focus anymore
      iframe.blur();
    }
  }

  /**
   * Start a new iframe after the code of a cell reloaded the current one:
   * the requests sent to the previous one fail with a RuntimeReloadedError.
   */
  private _restart(): void {
    const running = this._running !== null;
    this._rejectPending(new RuntimeReloadedError());
    this._teardown();
    if (this._isReady) {
      this._isReady = false;
      this._ready = new PromiseDelegate<void>();
    }
    this._options.onRestart?.({ running });
    void this._start();
  }

  /**
   * Dispose the runtime API, then remove the iframe: the evaluator removes
   * its listeners and restores the globals of the iframe before it goes.
   */
  private _teardown(): void {
    const remote = this._remote;
    if (remote) {
      // The evaluator is disposed before the promise is returned, and sends
      // the text printed last, like before a reload, while it is still the
      // current runtime
      void remote.dispose().catch(() => undefined);
    }
    this._remote = null;
    // The elements of the cells shown live in the outputs show their
    // snapshot instead
    this._executor?.liveNodes?.clear();
    this._executor = null;

    this._iframe?.removeEventListener('load', this._onLoad);
    this._iframe?.remove();
    this._iframe = null;
    this._document = null;
  }

  protected readonly _runtimeLabel = 'IFrame';
  protected readonly _options: IFrameRuntimeBackend.IOptions;

  private _iframe: HTMLIFrameElement | null = null;
  private _executor: JavaScriptExecutor | null = null;
  private _document: Document | null = null;
  private _container: HTMLDivElement | null = null;
  private _focused: HTMLElement | null = null;

  static readonly STARTUP_TIMEOUT_MS = 10000;

  /**
   * The iframe runtime backends of the page, which are not disposed.
   */
  private static _backends = new Set<IFrameRuntimeBackend>();

  /**
   * The default time in milliseconds a loop can keep the page busy.
   */
  static readonly DEFAULT_LOOP_TIMEOUT_MS = 10000;

  /**
   * The width in pixels of the hidden iframe, its `innerWidth`.
   */
  static readonly FRAME_WIDTH = 800;

  /**
   * The height in pixels of the hidden iframe, its `innerHeight`.
   */
  static readonly FRAME_HEIGHT = 600;
}

/**
 * A namespace for IFrameRuntimeBackend statics.
 */
export namespace IFrameRuntimeBackend {
  /**
   * Runtime objects available after iframe initialization.
   */
  export interface IReadyContext {
    iframe: HTMLIFrameElement;
    container: HTMLDivElement;
    globalScope: Record<string, any>;
    executor: JavaScriptExecutor;
    execute: (
      code: string,
      executionCount?: number
    ) => Promise<KernelMessage.IExecuteReplyMsg['content']>;
    preloadModule: (moduleName: string) => Promise<void>;
    registerCommTarget: (
      targetName: string,
      moduleName: string,
      exportName?: string
    ) => Promise<void>;
    unregisterCommTarget: (targetName: string) => Promise<void>;
  }

  /**
   * What happened when the iframe was restarted.
   */
  export interface IRestartInfo {
    /**
     * Whether a cell was running: its execution fails with a
     * RuntimeReloadedError.
     */
    running: boolean;
  }

  /**
   * The instantiation options for an iframe runtime backend.
   */
  export interface IOptions extends IRuntimeBackendOptions {
    /**
     * Create the executor of the realm of an iframe, also of the new iframe
     * started when the code of a cell reloaded the previous one.
     */
    executorFactory?: (globalScope: Record<string, any>) => JavaScriptExecutor;

    /**
     * Called once the runtime of an iframe is initialized, also after a
     * restart.
     */
    onReady?: (context: IReadyContext) => void | Promise<void>;

    /**
     * Called when the code of a cell reloaded the iframe or navigated it
     * away, before a new iframe starts: the state of the runtime, like its
     * comms, is lost.
     */
    onRestart?: (info: IRestartInfo) => void;
  }
}

/**
 * Runtime backend that executes code in a dedicated web worker.
 */
export class WorkerRuntimeBackend extends AbstractRuntimeBackend<
  Comlink.Remote<IRemoteRuntimeApi>
> {
  /**
   * Instantiate a new worker runtime backend.
   */
  constructor(options: WorkerRuntimeBackend.IOptions) {
    super();
    this._options = options;

    if (typeof Worker === 'undefined') {
      this._ready.reject(new Error('Web Workers are not available'));
      return;
    }

    // A shared flag interrupts the loops of the worker at once, without
    // restarting it. SharedArrayBuffer needs a cross-origin isolated page.
    if (
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
        true &&
      typeof SharedArrayBuffer === 'function'
    ) {
      this._interruptBuffer = new SharedArrayBuffer(4);
    }

    this._start();
  }

  /**
   * Interrupt the running cell.
   *
   * The worker stops the cell waiting for a promise, and with the shared
   * flag of a cross-origin isolated page, its loops. When the code does not
   * stop within INTERRUPT_GRACE_MS, or on a second interrupt, the worker is
   * terminated and started again: the state of the cells is lost.
   */
  async interrupt(): Promise<void> {
    const remote = this._remote;
    if (!remote || !this._isReady || this._isDisposed) {
      return;
    }
    if (this._interrupting) {
      this._restart();
      return;
    }

    const running = this._running;
    if (running && this._interruptBuffer) {
      Atomics.store(new Int32Array(this._interruptBuffer), 0, 1);
    }
    // Handled once the worker is not running any code
    const interrupted = this._call(api => api.interrupt());
    // Rejected when the worker is restarted before it handles the interrupt
    interrupted.catch(() => undefined);
    const settled = (running ?? interrupted).then(
      () => true,
      () => true
    );
    this._interrupting = true;
    try {
      const stopped = await Promise.race([
        settled,
        delay(WorkerRuntimeBackend.INTERRUPT_GRACE_MS).then(() => false)
      ]);
      if (!stopped && this._remote === remote) {
        this._restart();
      }
    } finally {
      if (this._remote === remote) {
        this._interrupting = false;
      }
    }
  }

  /**
   * Dispose worker resources.
   */
  dispose(): void {
    this._isDisposed = true;
    this._ready.reject(new Error('Worker runtime disposed'));
    this._rejectPending(new Error('Worker runtime disposed'));

    if (this._remote) {
      void this._remote.dispose().catch(() => undefined);
    }
    this._terminate();
  }

  /**
   * Start a worker, and initialize its runtime.
   */
  private _start(): void {
    const worker = new Worker(new URL('./worker-runtime.js', import.meta.url), {
      type: 'module'
    });

    worker.onerror = event => {
      if (this._worker !== worker) {
        return;
      }
      if (this._isReady) {
        // The runtime prints the uncaught errors of the cells and cancels
        // them. Print the other ones too, and keep the worker running.
        event.preventDefault();
        this._publishOutput({
          type: 'stream',
          bundle: {
            name: 'stderr',
            text: `${event.message || 'Uncaught error in the Web Worker'}\n`
          }
        });
        return;
      }
      // A plain event, without a message, when the script of the worker or
      // one of its modules failed to load
      const details = [
        event.message?.replace(/^Uncaught /, '') ||
          'the script of the Web Worker, or one of its modules, could not be loaded'
      ];
      if (event.filename) {
        details.push(`at ${event.filename}:${event.lineno}:${event.colno}`);
      }
      this._handleWorkerFatal(new Error(details.join(' ')));
    };
    worker.onmessageerror = () => {
      if (this._worker !== worker) {
        return;
      }
      if (this._isReady) {
        // The reply in the message is lost
        this._stop(
          new RuntimeStoppedError(
            'the Web Worker sent a message that could not be read'
          )
        );
        return;
      }
      this._handleWorkerFatal(
        new Error(
          'Worker runtime sent a message that could not be deserialized'
        )
      );
    };
    worker.addEventListener('message', event => {
      if (
        this._worker === worker &&
        event.data?.type === RUNTIME_CLOSED_MESSAGE
      ) {
        this._stop(
          new RuntimeStoppedError('the code closed the Web Worker with close()')
        );
        this._terminate();
      }
    });

    this._worker = worker;
    this._remote = Comlink.wrap<IRemoteRuntimeApi>(worker);
    this._outputProxy = Comlink.proxy((message: RuntimeOutputMessage) => {
      this._publishOutput(message);
    });

    void this._init(worker, this._remote, this._outputProxy);
  }

  /**
   * Initialize remote worker API and execute optional initialization hook.
   */
  private async _init(
    worker: Worker,
    remote: Comlink.Remote<IRemoteRuntimeApi>,
    outputProxy: RuntimeOutputCallback
  ): Promise<void> {
    try {
      await withTimeout(
        remote.initialize(
          {
            baseUrl: resolveBaseUrl(this._options.baseUrl),
            stdin: true,
            browsingContextId: this._options.browsingContextId,
            maxStreamOutput: this._options.maxStreamOutput,
            executorOptions: this._options.executorOptions,
            loopTimeout: this._options.loopTimeout ?? 0,
            interruptBuffer: this._interruptBuffer ?? undefined
          },
          outputProxy
        ),
        WorkerRuntimeBackend.STARTUP_TIMEOUT_MS,
        'Worker runtime failed to initialize'
      );

      await this._options.onReady?.({
        execute: (code, executionCount = 0) =>
          remote.execute(code, executionCount),
        preloadModule: moduleName => remote.preloadModule(moduleName),
        registerCommTarget: (targetName, moduleName, exportName) =>
          remote.registerCommTarget(targetName, moduleName, exportName),
        unregisterCommTarget: targetName =>
          remote.unregisterCommTarget(targetName)
      });

      if (this._worker !== worker) {
        return;
      }
      this._isReady = true;
      this._ready.resolve();
    } catch (error) {
      if (this._worker === worker) {
        this._handleWorkerFatal(normalizeError(error));
      }
    }
  }

  /**
   * Terminate the worker and start a new one: the requests sent to the
   * terminated worker fail with a RuntimeRestartedError.
   */
  private _restart(): void {
    const interrupted = this._running !== null;
    this._interrupting = false;
    this._isReady = false;
    this._rejectPending(new RuntimeRestartedError());
    this._terminate();
    this._ready = new PromiseDelegate<void>();
    this._options.onRestart?.({ interrupted });
    this._start();
  }

  /**
   * Terminate the worker, and release its proxy.
   */
  private _terminate(): void {
    if (this._remote) {
      this._remote[Comlink.releaseProxy]();
      this._remote = null;
    }
    this._worker?.terminate();
    this._worker = null;
    this._outputProxy = null;
  }

  /**
   * Reject initialization with a fatal worker error.
   */
  private _handleWorkerFatal(error: Error): void {
    this._terminate();
    this._ready.reject(error);
  }

  protected readonly _runtimeLabel = 'Worker';
  protected readonly _options: WorkerRuntimeBackend.IOptions;

  private _worker: Worker | null = null;
  private _outputProxy: RuntimeOutputCallback | null = null;
  private _interruptBuffer: SharedArrayBuffer | null = null;
  private _interrupting = false;

  static readonly STARTUP_TIMEOUT_MS = 10000;

  /**
   * The time in milliseconds the code of a cell has to stop after an
   * interrupt, before the worker is restarted.
   */
  static readonly INTERRUPT_GRACE_MS = 2000;
}

/**
 * A namespace for WorkerRuntimeBackend statics.
 */
export namespace WorkerRuntimeBackend {
  /**
   * Runtime capabilities available during worker initialization.
   */
  export interface IReadyContext {
    execute: (
      code: string,
      executionCount?: number
    ) => Promise<KernelMessage.IExecuteReplyMsg['content']>;
    preloadModule: (moduleName: string) => Promise<void>;
    registerCommTarget: (
      targetName: string,
      moduleName: string,
      exportName?: string
    ) => Promise<void>;
    unregisterCommTarget: (targetName: string) => Promise<void>;
  }

  /**
   * What happened when the worker was restarted.
   */
  export interface IRestartInfo {
    /**
     * Whether a cell was running: its execution fails with a
     * RuntimeRestartedError.
     */
    interrupted: boolean;
  }

  /**
   * The instantiation options for a worker runtime backend.
   */
  export interface IOptions extends IRuntimeBackendOptions {
    /**
     * Called once the runtime of a worker is initialized, also after a
     * restart.
     */
    onReady?: (context: IReadyContext) => void | Promise<void>;

    /**
     * Called when the worker is terminated after an interrupt, before a new
     * one starts: the state of the runtime, like its comms, is lost.
     */
    onRestart?: (info: IRestartInfo) => void;

    /**
     * The id of the browsing context of the page, to ask for user input
     * through the service worker of JupyterLite. Only set it when the
     * service worker controls the page: without it, prompt() fails with a
     * StdinNotImplementedError.
     */
    browsingContextId?: string;
  }
}

/**
 * Resolve after some milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Add a timeout to runtime startup operations, like the activation of a
 * startup extension: reject with an error of `errorName` when the promise
 * does not settle in time.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
  errorName = 'Error'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error(errorMessage);
      error.name = errorName;
      reject(error);
    }, timeoutMs);

    void promise.then(
      value => {
        clearTimeout(timeout);
        resolve(value);
      },
      error => {
        clearTimeout(timeout);
        reject(error as Error);
      }
    );
  });
}

/**
 * Resolve the runtime base URL with JupyterLab PageConfig fallback.
 */
function resolveBaseUrl(baseUrl?: string): string {
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    return baseUrl;
  }

  try {
    return PageConfig.getBaseUrl();
  } catch {
    return '/';
  }
}
