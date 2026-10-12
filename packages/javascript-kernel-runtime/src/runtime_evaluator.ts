// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import type { IMimeBundle } from '@jupyterlab/nbformat';

import { JavaScriptExecutor, type IAsyncCodeResult } from './executor';
import { CommManager } from './comm';
import type { CommTargetHandler } from './comm';
import { createConsole, type KernelConsole } from './console';
import { createDisplay, type IDisplay } from './display';
import { hostConsole } from './env';
import { setPromiseStateResolver, type PromiseStateResolver } from './inspect';
import { setDoc } from './introspection';
import { OutputBatcher } from './output_batcher';
import type { RuntimeOutputHandler } from './protocol';
import { Widget, createWidgetClasses } from './widgets';

/**
 * The names of the globals installed by the evaluator.
 */
const GLOBALS = ['display', 'clearOutput', 'prompt', 'Jupyter'];

/**
 * Shared execution logic for iframe and worker runtime backends.
 */
export class JavaScriptRuntimeEvaluator {
  /**
   * Instantiate a runtime evaluator.
   */
  constructor(options: JavaScriptRuntimeEvaluator.IOptions) {
    this._globalScope = options.globalScope;
    // The timers and the clock are read before any code of the cells runs,
    // which could replace or wrap them
    this._scheduler =
      options.scheduler === null
        ? undefined
        : (options.scheduler ?? defaultScheduler(this._globalScope));
    const now = options.now ?? defaultClock(this._globalScope);
    this._outputs = new OutputBatcher({
      onOutput: options.onOutput,
      scheduler: this._scheduler,
      now,
      parent: () => this._commManager.getCurrentMessageId(),
      flushInterval: options.flushInterval,
      maxBufferSize: options.maxStreamBufferSize,
      maxStreamOutput: options.maxStreamOutput
    });
    // Every output goes through the batcher, the comm messages too: the
    // Output widget captures the outputs between two of them
    this._onOutput = this._outputs.handler;
    this._executor =
      options.executor ?? new JavaScriptExecutor(options.globalScope);

    this._requestInput = options.requestInput;
    if (options.promiseState) {
      setPromiseStateResolver(options.promiseState);
      this._resetPromiseState = true;
    }

    this._commManager = new CommManager(this._onOutput, {
      onTargetRegistered: options.onCommTargetRegistered,
      reportError: (error, inPromise) => this.reportUncaught(error, inPromise)
    });
    this._display = createDisplay({
      publish: (data, metadata, transient, update) => {
        const bundle = { data, metadata, transient } as any;
        if (update) {
          this._onOutput({ type: 'update_display_data', bundle });
        } else {
          this._onOutput({ type: 'display_data', bundle });
        }
      },
      clear: wait => {
        this._onOutput({ type: 'clear_output', bundle: { wait } });
      },
      mimeBundle: value => this._mimeBundle(value),
      readFile: options.readFile
    });
    this._console = createConsole({
      write: (name, text) => {
        this._onOutput({ type: 'stream', bundle: { name, text } });
      },
      display: data => {
        this._display(data, { raw: true });
      },
      clear: wait => {
        this._display.clear(wait);
      },
      formatStack: (error, colors) =>
        this._executor.formatStackFrames(error, colors),
      now
    });
    this._setupGlobals();
    this._setupConsole();
    this._listenForUncaughtErrors();
  }

  /**
   * Dispose the evaluator and restore patched globals where possible.
   */
  dispose(): void {
    this._isDisposed = true;
    this._stopListeningForUncaughtErrors();
    try {
      this._outputs.dispose();
    } catch {
      // The handler of the host failed: still restore the realm below
    }
    this._restoreConsole();
    this._restoreGlobals();
    this._commManager.dispose();
    if (this._resetPromiseState) {
      setPromiseStateResolver(null);
      this._resetPromiseState = false;
    }
  }

  /**
   * The runtime global scope.
   */
  get globalScope(): Record<string, any> {
    return this._globalScope;
  }

  /**
   * The timers of the host, if any, for the work the runtime defers.
   */
  get scheduler(): JavaScriptRuntimeEvaluator.IScheduler | undefined {
    return this._scheduler;
  }

  /**
   * Send the text written to stdout and stderr and not sent yet.
   *
   * The consecutive writes to a stream are sent together, at most
   * flushInterval after the first one, or before any other output. The
   * evaluator flushes them at the end of execute() and of the comm handlers,
   * and before prompt() blocks. A host without timers calls it when the
   * cell, its timers and its jobs are done.
   */
  flushOutputs(): void {
    this._outputs.flush();
  }

  /**
   * The executor used by the evaluator.
   */
  get executor(): JavaScriptExecutor {
    return this._executor;
  }

  /**
   * Execute user code in the configured runtime global scope.
   */
  async execute(
    code: string,
    executionCount: number,
    parentMessageId?: string,
    parentHeader?: Record<string, unknown>
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    this._parentHeader = parentHeader;
    this._outputs.resetStreamOutput();
    return this._withParentMessageId(parentMessageId, async () => {
      // The name of the cell in the tracebacks
      const name = executionCount > 0 ? `In[${executionCount}]` : undefined;
      let asyncFunction: () => Promise<any>;
      let withReturn: boolean;
      let docs: IAsyncCodeResult['docs'];
      let token: string;
      try {
        const parsed = this._executor.makeAsyncFromCode(code, { name });
        asyncFunction = parsed.asyncFunction;
        withReturn = parsed.withReturn;
        docs = parsed.docs;
        token = parsed.name;
      } catch (error) {
        // A syntax error, with its location in the cell. The error sends the
        // pending outputs before it.
        return this._emitError(executionCount, error);
      }

      try {
        const resultPromise = this._evalFunc(asyncFunction);

        if (withReturn) {
          const result = await resultPromise;

          if (result !== undefined) {
            if (result instanceof Widget) {
              this._commManager.displayWidget(result.commId);
            } else {
              const data = this._mimeBundle(result);
              this._onOutput({
                type: 'execute_result',
                bundle: {
                  execution_count: executionCount,
                  data,
                  metadata: {}
                }
              });
            }
          }
        } else {
          await resultPromise;
        }

        return {
          status: 'ok',
          execution_count: executionCount,
          user_expressions: {}
        };
      } catch (error) {
        // The thrown value as is, which may not be an error
        return this._emitError(executionCount, error, token);
      } finally {
        // The declarations made before an error keep their documentation
        this._executor.introspection.registerDocs(docs);
        // document.open() removes the listeners of the window, add them back
        this._listenForUncaughtErrors();
        // The outputs of the cell are sent before its reply
        this._outputs.flush();
      }
    });
  }

  /**
   * Print an error thrown outside of an execution, like in a timer, an event
   * listener or a widget callback, on stderr: `Uncaught Error: ...` with its
   * location in the cells. The outputs go to the current parent message of
   * the host, usually the last cell that ran. Once that cell reached its
   * output limit, the error goes to the console of the host instead, as
   * the notebook does not show the rest of the cell outputs.
   *
   * The evaluator calls it for the `error` and `unhandledrejection` events
   * of globalScope, when it has addEventListener. Hosts without these events
   * can call it with the errors they catch.
   *
   * @param error - The thrown value, which may not be an error.
   * @param inPromise - Whether the value is the reason of a rejected promise
   * that has no handler: `Uncaught (in promise) ...`.
   */
  reportUncaught(error: unknown, inPromise = false): void {
    const prefix = inPromise ? 'Uncaught (in promise)' : 'Uncaught';
    if (!this._outputs.isTruncated) {
      try {
        const { traceback } = this._executor.formatError(error, { prefix });
        this._onOutput({
          type: 'stream',
          bundle: { name: 'stderr', text: `${traceback.join('\n')}\n` }
        });
        return;
      } catch {
        // The error can not be shown in the notebook, keep it in the console
      }
    }
    this._logError(prefix, error);
  }

  /**
   * Complete code at the given cursor position.
   */
  complete(
    code: string,
    cursorPos: number
  ): KernelMessage.ICompleteReplyMsg['content'] {
    const result = this._executor.completeRequest(code, cursorPos);

    return {
      matches: result.matches,
      cursor_start: result.cursorStart,
      cursor_end: result.cursorEnd ?? cursorPos,
      metadata: (result.metadata ?? {}) as any,
      status: 'ok'
    };
  }

  /**
   * Inspect symbol information at the given cursor position.
   */
  inspect(
    code: string,
    cursorPos: number,
    detailLevel: KernelMessage.IInspectRequestMsg['content']['detail_level']
  ): KernelMessage.IInspectReplyMsg['content'] {
    return this._executor.inspect(code, cursorPos, detailLevel);
  }

  /**
   * Check whether the provided code is complete.
   */
  isComplete(code: string): KernelMessage.IIsCompleteReplyMsg['content'] {
    return this._executor.isComplete(code);
  }

  /**
   * The comm manager instance.
   */
  get commManager(): CommManager {
    return this._commManager;
  }

  /**
   * Preload a module in the runtime scope.
   */
  async preloadModule(moduleName: string): Promise<void> {
    await this._executor.importModule(moduleName);
  }

  /**
   * Register a comm target handler exported by a runtime module.
   */
  async registerCommTarget(
    targetName: string,
    moduleName: string,
    exportName = 'default'
  ): Promise<void> {
    if (this._commManager.hasTarget(targetName)) {
      throw new Error(`Comm target ${targetName} is already registered`);
    }

    const moduleExports = await this._executor.importModule(moduleName);
    const handler = moduleExports[exportName];
    if (typeof handler !== 'function') {
      throw new TypeError(
        `Comm target ${targetName} must export a handler function`
      );
    }
    this._commManager.registerTarget(targetName, handler as CommTargetHandler);
  }

  /**
   * Remove a comm target handler registration.
   */
  unregisterCommTarget(targetName: string): void {
    this._commManager.unregisterTarget(targetName);
  }

  /**
   * Handle a comm_open message from the frontend.
   */
  handleCommOpen(
    commId: string,
    targetName: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string
  ): void {
    this._runInBackground(parentMessageId, () => {
      this._commManager.handleCommOpen(commId, targetName, data, buffers);
    });
  }

  /**
   * Handle a comm_msg message from the frontend.
   */
  handleCommMsg(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string
  ): void {
    this._runInBackground(parentMessageId, () => {
      this._commManager.handleCommMsg(commId, data, buffers);
    });
  }

  /**
   * Handle a comm_close message from the frontend.
   */
  handleCommClose(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string
  ): void {
    this._runInBackground(parentMessageId, () => {
      this._commManager.handleCommClose(commId, data, buffers);
    });
  }

  /**
   * Evaluate an async function within the configured global scope.
   */
  private _evalFunc(asyncFunc: () => Promise<any>): Promise<any> {
    return asyncFunc.call(this._globalScope);
  }

  /**
   * Set the active parent message ID while invoking runtime code.
   */
  private async _withParentMessageId<T>(
    parentMessageId: string | undefined,
    callback: () => Promise<T> | T
  ): Promise<T> {
    const previousMessageId = this._commManager.getCurrentMessageId();
    this._commManager.setCurrentMessageId(parentMessageId ?? null);
    try {
      return await callback();
    } finally {
      this._commManager.setCurrentMessageId(previousMessageId);
    }
  }

  /**
   * Run a callback with the active parent message ID, outside of an
   * execution, and report its errors.
   *
   * The rejections of the promises of the kernel are not seen by the
   * listeners of globalScope when the kernel runs in another realm, like the
   * page of an iframe, so they are reported here.
   */
  private _runInBackground(
    parentMessageId: string | undefined,
    callback: () => void
  ): void {
    this._withParentMessageId(parentMessageId, () => {
      try {
        callback();
      } finally {
        // The outputs of the handler are sent before it returns, like the
        // prints of a button click
        this._outputs.flush();
      }
    }).catch(error => this.reportUncaught(error));
  }

  /**
   * Listen for the errors thrown and the promises rejected without a
   * handler in globalScope, outside of the executions.
   *
   * Cancelling the events keeps them out of the console of the browser, and
   * keeps a Web Worker alive: the errors it does not cancel reach the page.
   * Adding the same listeners again does nothing, so this can be called
   * after every execution. An execution which ends after dispose() does not
   * add them back.
   */
  private _listenForUncaughtErrors(): void {
    const scope = this._globalScope;
    if (this._isDisposed || typeof scope.addEventListener !== 'function') {
      return;
    }
    scope.addEventListener('error', this._onError);
    scope.addEventListener('unhandledrejection', this._onUnhandledRejection);
  }

  /**
   * Remove the listeners of the uncaught errors.
   */
  private _stopListeningForUncaughtErrors(): void {
    const scope = this._globalScope;
    if (typeof scope.removeEventListener !== 'function') {
      return;
    }
    scope.removeEventListener('error', this._onError);
    scope.removeEventListener('unhandledrejection', this._onUnhandledRejection);
  }

  /**
   * Handle the `error` event of an error thrown outside of an execution.
   */
  private _onError = (event: IErrorEvent): void => {
    event.preventDefault?.();
    this.reportUncaught(event.error ?? errorFromEvent(event));
  };

  /**
   * Handle the `unhandledrejection` event of a promise rejected without a
   * handler.
   */
  private _onUnhandledRejection = (event: IRejectionEvent): void => {
    event.preventDefault?.();
    this.reportUncaught(event.reason, true);
  };

  /**
   * Build and emit an execute error reply, with the traceback of a thrown
   * value.
   *
   * @param currentToken - The name of the cell which threw the value.
   */
  private _emitError(
    executionCount: number,
    error: unknown,
    currentToken?: string
  ): KernelMessage.IExecuteReplyMsg['content'] {
    const { ename, evalue, traceback } = this._executor.formatError(error, {
      currentToken
    });

    const content: KernelMessage.IReplyErrorContent = {
      status: 'error',
      ename,
      evalue,
      traceback
    };

    this._onOutput({
      type: 'execute_error',
      bundle: content
    });

    return {
      ...content,
      execution_count: executionCount
    };
  }

  /**
   * The MIME bundle of a value, with the view of the widgets.
   */
  private _mimeBundle(value: unknown): IMimeBundle {
    if (value instanceof Widget) {
      return this._commManager.widgetMimeBundle(value.commId);
    }
    return this._executor.getMimeBundle(value);
  }

  /**
   * Install the globals of the kernel: display, clearOutput, prompt and
   * Jupyter, saving the previous values to restore them.
   */
  private _setupGlobals(): void {
    const scope = this._globalScope;
    for (const name of GLOBALS) {
      this._previousGlobals.set(
        name,
        Object.getOwnPropertyDescriptor(scope, name)
      );
    }

    scope.display = this._display;
    scope.clearOutput = setDoc(
      (wait = false) => this._display.clear(Boolean(wait)),
      'Clears the outputs of the cell. With wait=true, waits for the next output to clear them.'
    );

    // Without a way to ask for input, the runtime keeps its own prompt(), like
    // the dialog of the browser in an iframe
    const requestInput = this._requestInput;
    if (requestInput) {
      const ask = (message: unknown, password: boolean) => {
        // Show the outputs printed before the input box, since the request
        // blocks the runtime
        this._outputs.flush();
        return requestInput(String(message), password, this._parentHeader);
      };
      const prompt = setDoc((message: unknown = '', defaultValue?: unknown) => {
        const value = ask(message, false);
        if ((value === '' || value === null) && defaultValue !== undefined) {
          return String(defaultValue);
        }
        return value;
      }, 'Asks the user for some input, and returns it as a string.\n\nprompt(message?, defaultValue?)') as ((
        message?: unknown,
        defaultValue?: unknown
      ) => string | null) & {
        password?: (message?: unknown) => string | null;
      };
      prompt.password = setDoc(
        (message: unknown = '') => ask(message, true),
        'Asks for a password, the input is hidden.\n\nprompt.password(message?)'
      );
      scope.prompt = prompt;
    }

    const previousJupyter = scope.Jupyter;
    scope.Jupyter = {
      ...(typeof previousJupyter === 'object' && previousJupyter !== null
        ? previousJupyter
        : {}),
      comm: this._commManager,
      widgets: createWidgetClasses(this._commManager)
    };
  }

  /**
   * Restore the globals replaced by the kernel.
   */
  private _restoreGlobals(): void {
    const scope = this._globalScope;
    for (const [name, descriptor] of this._previousGlobals) {
      if (descriptor) {
        Object.defineProperty(scope, name, descriptor);
      } else {
        delete scope[name];
      }
    }
    this._previousGlobals.clear();
  }

  /**
   * Replace the methods of the console of the runtime with the ones of the
   * kernel, which write to the outputs of the cells.
   */
  private _setupConsole(): void {
    const scopeConsole = this._globalScope.console as
      | Record<string, unknown>
      | undefined;
    if (!scopeConsole) {
      // Engines without a console get the one of the kernel, removed by
      // dispose() with the other globals
      this._previousGlobals.set('console', undefined);
      this._globalScope.console = { ...this._console };
      return;
    }
    for (const [name, method] of Object.entries(this._console)) {
      this._originalConsole.set(name, scopeConsole[name]);
      scopeConsole[name] = method;
    }
  }

  /**
   * Print an error in the console of the host, with the original method
   * when the evaluator patched the console, which would print it in the
   * notebook.
   */
  private _logError(...args: unknown[]): void {
    const original = this._originalConsole.get('error');
    if (typeof original === 'function') {
      original.apply(this._globalScope.console, args);
      return;
    }
    const console = hostConsole();
    if (console && console !== this._globalScope.console) {
      console.error?.(...args);
    }
  }

  /**
   * Restore the methods of the console of the runtime.
   */
  private _restoreConsole(): void {
    const scopeConsole = this._globalScope.console as
      | Record<string, unknown>
      | undefined;
    if (scopeConsole) {
      for (const [name, method] of this._originalConsole) {
        scopeConsole[name] = method;
      }
    }
    this._originalConsole.clear();
  }

  private _globalScope: Record<string, any>;
  private _onOutput: RuntimeOutputHandler;
  private _outputs: OutputBatcher;
  private _executor: JavaScriptExecutor;
  private _commManager: CommManager;
  private _display: IDisplay;
  private _console: KernelConsole;
  private _requestInput?: JavaScriptRuntimeEvaluator.IOptions['requestInput'];
  private _scheduler?: JavaScriptRuntimeEvaluator.IScheduler;
  private _resetPromiseState = false;
  private _isDisposed = false;
  private _parentHeader?: Record<string, unknown>;
  private _previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  private _originalConsole = new Map<string, unknown>();
}

/**
 * The `error` event of an error thrown outside of an execution
 * (an ErrorEvent in browsers).
 */
interface IErrorEvent {
  error?: unknown;
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  preventDefault?(): void;
}

/**
 * The `unhandledrejection` event of a promise rejected without a handler
 * (a PromiseRejectionEvent in browsers).
 */
interface IRejectionEvent {
  reason?: unknown;
  preventDefault?(): void;
}

/**
 * An error for an `error` event without one, like the errors of the scripts
 * of other origins: its message and the location of the script.
 */
function errorFromEvent(event: IErrorEvent): {
  name: string;
  message: string;
  stack?: string;
} {
  // The message of the browsers starts with `Uncaught Error: `
  const match = /^(?:Uncaught )?(?:([A-Za-z]*Error): )?([^]*)$/.exec(
    event.message ?? ''
  );
  const name = match?.[1] || 'Error';
  const message = match?.[2] ?? '';
  const stack = event.filename
    ? `${name}: ${message}\n    at ${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
    : undefined;
  return { name, message, stack };
}

/**
 * A namespace for JavaScriptRuntimeEvaluator statics.
 */
export namespace JavaScriptRuntimeEvaluator {
  /**
   * The instantiation options for a runtime evaluator.
   */
  export interface IOptions {
    /**
     * The global object of the realm running the code of the cells.
     */
    globalScope: Record<string, any>;

    /**
     * Called with the outputs of the runtime, in order: during execute(),
     * and later for the outputs of callbacks, timers and widget handlers.
     * The consecutive writes to stdout or stderr are merged into one stream
     * message, sent at most flushInterval after the first write, before any
     * other output, and at the end of execute() and of the comm handlers.
     */
    onOutput: RuntimeOutputHandler;

    /**
     * The executor compiling the cells, to customize it (for example to turn
     * off the magic imports). Defaults to a JavaScriptExecutor of globalScope.
     */
    executor?: JavaScriptExecutor;

    /**
     * Ask the user for some input, for prompt(). It blocks until the user
     * replies, and returns null when the input can not be requested. Without
     * it, the runtime keeps its own prompt().
     */
    requestInput?: (
      prompt: string,
      password: boolean,
      parentHeader?: Record<string, unknown>
    ) => string | null;

    /**
     * The current time in milliseconds, for console.time and the batching
     * of the outputs. Defaults to performance.now of globalScope, or else
     * Date.now.
     */
    now?: () => number;

    /**
     * Read a file, for display.image(path). Without it, display.image is not
     * available.
     */
    readFile?: (path: string) => Uint8Array;

    /**
     * Get the state of a promise, for engines which can tell it: the
     * promises are then shown with their state. Reset by dispose().
     */
    promiseState?: PromiseStateResolver;

    /**
     * Called when a comm target is registered, for kernels that must
     * register the targets on their side before the frontend can open comms.
     */
    onCommTargetRegistered?: (targetName: string) => void;

    /**
     * The timers of the host, for the work the runtime defers, like sending
     * the pending text of the streams. Defaults to setTimeout and
     * clearTimeout of globalScope, when they exist, read when the evaluator
     * is created. null for an engine whose timers would keep the cell
     * running: the host then calls flushOutputs() at the end of the cell.
     */
    scheduler?: IScheduler | null;

    /**
     * The longest time in milliseconds the text written to stdout or stderr
     * is kept, to send the consecutive writes together. 50 by default, 0
     * sends one message per write.
     */
    flushInterval?: number;

    /**
     * The size of the pending text of a stream, in UTF-16 code units, from
     * which it is sent. 1,000,000 by default.
     */
    maxStreamBufferSize?: number;

    /**
     * The number of characters (UTF-16 code units) a cell can print on
     * stdout and stderr, counted from the start of the cell or from its last
     * clear_output: the rest is not shown, and a notice is printed on
     * stderr. 5,000,000 by default, 0 for no limit.
     */
    maxStreamOutput?: number;
  }

  /**
   * The timers of a host.
   */
  export type IScheduler = OutputBatcher.IScheduler;
}

/**
 * The clock of a global scope: its performance.now, or else Date.now.
 */
function defaultClock(scope: Record<string, any>): () => number {
  const performance = scope.performance;
  if (typeof performance?.now === 'function') {
    const now = performance.now;
    return () => now.call(performance);
  }
  return Date.now;
}

/**
 * The timers of a global scope, when it has setTimeout and clearTimeout.
 */
function defaultScheduler(
  scope: Record<string, any>
): JavaScriptRuntimeEvaluator.IScheduler | undefined {
  const { setTimeout, clearTimeout } = scope;
  if (typeof setTimeout !== 'function' || typeof clearTimeout !== 'function') {
    return undefined;
  }
  return {
    setTimeout: (callback, ms) => setTimeout.call(scope, callback, ms),
    clearTimeout: handle => clearTimeout.call(scope, handle)
  };
}
