// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import type { IMimeBundle } from '@jupyterlab/nbformat';

import { JavaScriptExecutor, type IAsyncCodeResult } from './executor';
import { normalizeError } from './errors';
import { CommManager } from './comm';
import type { CommTargetHandler } from './comm';
import { createConsole, type KernelConsole } from './console';
import { createDisplay, type IDisplay } from './display';
import { setDoc } from './introspection';
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
    this._onOutput = options.onOutput;
    this._executor =
      options.executor ?? new JavaScriptExecutor(options.globalScope);

    this._requestInput = options.requestInput;

    this._commManager = new CommManager(options.onOutput);
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
      mimeBundle: value => this._mimeBundle(value)
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
      now: () => {
        const performance = this._globalScope.performance;
        return typeof performance?.now === 'function'
          ? performance.now()
          : Date.now();
      }
    });
    this._setupGlobals();
    this._setupConsole();
  }

  /**
   * Dispose the evaluator and restore patched globals where possible.
   */
  dispose(): void {
    this._restoreConsole();
    this._restoreGlobals();
    this._commManager.dispose();
  }

  /**
   * The runtime global scope.
   */
  get globalScope(): Record<string, any> {
    return this._globalScope;
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
    return this._withParentMessageId(parentMessageId, async () => {
      // Parse-time errors are syntax errors, so show only `Name: message`.
      let asyncFunction: () => Promise<any>;
      let withReturn: boolean;
      let docs: IAsyncCodeResult['docs'];
      try {
        const parsed = this._executor.makeAsyncFromCode(code);
        asyncFunction = parsed.asyncFunction;
        withReturn = parsed.withReturn;
        docs = parsed.docs;
      } catch (error) {
        const normalized = normalizeError(error);
        return this._emitError(executionCount, normalized, false);
      }

      // Runtime errors may include useful eval frames from user code.
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
        const normalized = normalizeError(error);
        return this._emitError(executionCount, normalized, true);
      } finally {
        // The declarations made before an error keep their documentation
        this._executor.introspection.registerDocs(docs);
      }
    });
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
    void this._withParentMessageId(parentMessageId, async () => {
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
    void this._withParentMessageId(parentMessageId, async () => {
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
    void this._withParentMessageId(parentMessageId, async () => {
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
   * Build and emit an execute error reply.
   */
  private _emitError(
    executionCount: number,
    error: Error,
    includeStack: boolean
  ): KernelMessage.IExecuteReplyMsg['content'] {
    const traceback = includeStack
      ? this._executor.cleanStackTrace(error)
      : `${error.name}: ${error.message}`;

    const content: KernelMessage.IReplyErrorContent = {
      status: 'error',
      ename: error.name || 'Error',
      evalue: error.message || '',
      traceback: [traceback]
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
      const ask = (message: unknown, password: boolean) =>
        requestInput(String(message), password, this._parentHeader);
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
      return;
    }
    for (const [name, method] of Object.entries(this._console)) {
      this._originalConsole.set(name, scopeConsole[name]);
      scopeConsole[name] = method;
    }

    if ('onerror' in this._globalScope) {
      this._originalOnError = this._globalScope.onerror;
      this._globalScope.onerror = (message: unknown) => {
        this._console.error(message);
        return false;
      };
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

    if ('onerror' in this._globalScope) {
      this._globalScope.onerror = this._originalOnError;
    }
    this._originalOnError = undefined;
  }

  private _globalScope: Record<string, any>;
  private _onOutput: RuntimeOutputHandler;
  private _executor: JavaScriptExecutor;
  private _commManager: CommManager;
  private _display: IDisplay;
  private _console: KernelConsole;
  private _requestInput?: JavaScriptRuntimeEvaluator.IOptions['requestInput'];
  private _parentHeader?: Record<string, unknown>;
  private _previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  private _originalConsole = new Map<string, unknown>();
  private _originalOnError: any;
}

/**
 * A namespace for JavaScriptRuntimeEvaluator statics.
 */
export namespace JavaScriptRuntimeEvaluator {
  /**
   * The instantiation options for a runtime evaluator.
   */
  export interface IOptions {
    globalScope: Record<string, any>;
    onOutput: RuntimeOutputHandler;
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
  }
}
