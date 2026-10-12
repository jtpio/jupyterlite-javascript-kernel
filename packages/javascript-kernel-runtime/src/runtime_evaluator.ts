// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import type { IMimeBundle } from '@jupyterlab/nbformat';

import {
  ExecutorConfig,
  JavaScriptExecutor,
  type IAsyncCodeResult,
  type IExecutorOptions
} from './executor';
import { CommManager } from './comm';
import type { CommTargetHandler } from './comm';
import { createConsole, type KernelConsole } from './console';
import { createDisplay, type IDisplay } from './display';
import { hostConsole } from './env';
import { setPromiseStateResolver, type PromiseStateResolver } from './inspect';
import { LoopGuard, TimerRegistry, defaultClock } from './interrupt';
import { getDoc, setDoc } from './introspection';
import { OutputBatcher } from './output_batcher';
import { OutputRouter, type IParentMessage } from './output_router';
import type { RuntimeOutputHandler } from './protocol';
import { safe, stripAnsi } from './utils';
import {
  Widget,
  createWidgetClasses,
  registerWidgetControlTarget
} from './widgets';

/**
 * The names of the globals installed by the evaluator.
 */
const GLOBALS = ['display', 'clearOutput', 'prompt', 'Jupyter'];

/**
 * The functions of the global scope which block the page until the user
 * replies: the time they take does not count in the loop timeout.
 */
const BLOCKING_FUNCTIONS = ['alert', 'confirm', 'prompt', 'print'];

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
      flushInterval: options.flushInterval,
      maxBufferSize: options.maxStreamBufferSize,
      maxStreamOutput: options.maxStreamOutput
    });
    // Every output goes through the batcher, the comm messages too: the
    // Output widget captures the outputs between two of them. The router
    // attaches them to their parent message first.
    this._onOutput = message => {
      const routed = this._router.route(message);
      if (routed) {
        this._outputs.push(routed);
      }
    };
    this._executor =
      options.executor ??
      new JavaScriptExecutor(
        options.globalScope,
        new ExecutorConfig(options.executorOptions)
      );
    if (options.executor && options.executorOptions) {
      options.executor.config.update(options.executorOptions);
    }
    this._guard = new LoopGuard({
      globalScope: this._globalScope,
      timeout: options.loopTimeout,
      interruptBuffer: options.interruptBuffer,
      now
    });
    this._executor.loopGuard = this._guard;

    this._requestInput = options.requestInput;
    if (options.promiseState) {
      setPromiseStateResolver(options.promiseState);
      this._resetPromiseState = true;
    }

    this._commManager = new CommManager(this._onOutput, {
      onTargetRegistered: options.onCommTargetRegistered,
      reportError: (error, inPromise) => this.reportUncaught(error, inPromise),
      mimeBundle: value => this._mimeBundle(value),
      router: this._router
    });
    registerWidgetControlTarget(this._commManager);
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
    this._guard.dispose();
    if (this._executor.loopGuard === this._guard) {
      this._executor.loopGuard = null;
    }
    this._commManager.dispose();
    // The timers of a removed realm never fire
    for (const end of [...this._openRequests]) {
      end();
    }
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
   * cell, its timers and its jobs are done, and after a comm handler and its
   * jobs: it ends the comm request.
   */
  flushOutputs(): void {
    this._outputs.flush();
    this._router.endRequest();
  }

  /**
   * The executor used by the evaluator.
   */
  get executor(): JavaScriptExecutor {
    return this._executor;
  }

  /**
   * The time in milliseconds a loop of the cells can keep the page busy,
   * 0 for no limit. The code of the cells changes it with
   * `Jupyter.loopTimeout`.
   */
  get loopTimeout(): number {
    return this._guard.timeout;
  }
  set loopTimeout(value: number) {
    this._guard.timeout = value;
  }

  /**
   * Interrupt the running cell, if any, and clear the timers created by the
   * code of the cells, which also stops the intervals when no cell runs.
   *
   * The cell stops waiting for its promise and fails with a
   * KeyboardInterrupt: this only stops a cell waiting for a promise, as the
   * host can only call it while the code of the cell is not running. Its
   * loops throw the error too, until the next execution. To stop a loop
   * which never yields, the host runs the evaluator in another thread and
   * sets the `interruptBuffer`.
   */
  interrupt(): void {
    this._guard.interrupt();
    this._timers.clearAll();
  }

  /**
   * Execute user code in the configured runtime global scope.
   *
   * The outputs of the cell go to `parentHeader`, and so do the outputs
   * sent outside of the cells, until the next execution: the timers and
   * the widget callbacks keep the cell which created them. Without a parent
   * message, like for some startup code, the outputs keep the current one.
   *
   * A silent execution sends no outputs, no result and no error, only its
   * comm messages, until it ends: the outputs sent outside of the cells then
   * go to the cell which ran before it again. The timers and the callbacks
   * of the silent code stay silent, but not its promise continuations which
   * run after it ended, like the code after an `await` in an async function
   * it did not wait for, or its unhandled rejections: like the ones of the
   * cell before it, they go to that cell.
   */
  async execute(
    code: string,
    executionCount: number,
    parentMessageId?: string,
    parentHeader?: Record<string, unknown>,
    options: JavaScriptRuntimeEvaluator.IExecuteOptions = {}
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    const silent = options.silent === true;
    const previous = this._router.cell;
    if (parentMessageId !== undefined || parentHeader !== undefined) {
      this._router.cell = toParent(parentMessageId, parentHeader, silent);
    } else if (silent) {
      this._router.cell = { ...previous, silent };
    }
    const cell = this._router.cell;
    if (!silent) {
      // A silent execution keeps the output limit of the cell before it
      this._outputs.resetStreamOutput();
    }
    if (executionCount > 0) {
      // The timers of the startup code, run without execution count, are
      // not cleared on interrupt
      this._timers.enable();
    }
    this._guard.beginExecution();
    try {
      return await this._execute(code, executionCount, options);
    } finally {
      this._guard.endExecution();
      if (silent && this._router.cell === cell) {
        this._router.cell = previous;
      }
    }
  }

  /**
   * Execute user code.
   */
  private async _execute(
    code: string,
    executionCount: number,
    options: JavaScriptRuntimeEvaluator.IExecuteOptions
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    const silent = options.silent === true;
    // The name of the cell in the tracebacks: the code which is not in the
    // history does not replace the cell of the execution count
    const name =
      executionCount > 0 && options.storeHistory !== false && !silent
        ? `In[${executionCount}]`
        : undefined;
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
      return this._emitError(executionCount, error, undefined, silent);
    }

    // The code of the cell sends its outputs to the cell, even while an
    // Output widget captures the outputs of an async callback
    const cell = this._router.cell;
    try {
      // An interrupt stops waiting for the promise of the cell
      const result = await this._evaluate(asyncFunction, cell);

      if (withReturn && result !== undefined && !silent) {
        this._router.runInScope(cell, () => {
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
        });
      }

      return {
        status: 'ok',
        execution_count: executionCount,
        user_expressions: await this._evaluateUserExpressions(
          options.userExpressions,
          cell
        )
      };
    } catch (error) {
      // The thrown value as is, which may not be an error
      return this._emitError(executionCount, error, token, silent);
    } finally {
      // The declarations made before an error keep their documentation
      this._executor.introspection.registerDocs(docs);
      // document.open() removes the listeners of the window, add them back
      this._listenForUncaughtErrors();
      // The outputs of the cell are sent before its reply
      this._outputs.flush();
    }
  }

  /**
   * Run the compiled code of a cell or of an expression, with its outputs
   * going to `parent`, and wait for its promise, until an interrupt.
   */
  private async _evaluate(
    asyncFunction: () => Promise<any>,
    parent: IParentMessage
  ): Promise<any> {
    const result = await this._guard.race(
      this._router.runInScope(parent, () => this._evalFunc(asyncFunction))
    );
    // The code caught the error of the loop guard: it still fails with it
    const tripped = this._guard.tripped;
    if (tripped) {
      throw tripped;
    }
    return result;
  }

  /**
   * Evaluate the user expressions of an execute_request, after its code
   * ran: the results hold the MIME bundle of the value of each expression,
   * awaited like the last expression of a cell, with its text without
   * colors, or its error. Their outputs go to the request.
   */
  private async _evaluateUserExpressions(
    expressions: Record<string, string> | undefined,
    parent: IParentMessage
  ): Promise<UserExpressionResults> {
    const results: UserExpressionResults = {};
    if (!expressions) {
      return results;
    }
    for (const [key, expression] of Object.entries(expressions)) {
      // The loop timeout of an expression does not fail the next ones
      this._guard.clearTimedOut();
      let token: string | undefined;
      try {
        const parsed = this._executor.makeAsyncFromCode(String(expression), {
          expression: true
        });
        token = parsed.name;
        const value = await this._evaluate(parsed.asyncFunction, parent);
        const data = this._mimeBundle(value);
        // The text is read by the extensions, not shown in a notebook
        const text = data['text/plain'];
        if (typeof text === 'string') {
          data['text/plain'] = stripAnsi(text);
        }
        results[key] = {
          status: 'ok',
          data: data as UserExpressionResults,
          metadata: {}
        };
      } catch (error) {
        const { ename, evalue, traceback } = this._executor.formatError(error, {
          currentToken: token
        });
        results[key] = { status: 'error', ename, evalue, traceback };
      }
    }
    return results;
  }

  /**
   * Print an error thrown outside of an execution, like in a timer, an event
   * listener or a widget callback, on stderr: `Uncaught Error: ...` with its
   * location in the cells. The error goes to the cell which created the timer
   * or registered the callback which threw it, when the evaluator knows it,
   * or else to the cell that ran last. Once that cell reached its
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
    this._router.runUncaught(() => {
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
   *
   * The handlers run synchronously: the promises they return are not
   * awaited. The outputs they capture in an Output widget, and the comm
   * messages they send, go to `parentHeader`. Their other outputs go to the
   * cell which registered the widget callback, or else to the cell that ran
   * last.
   *
   * The returned promise resolves at the next timer of the scheduler, once
   * the jobs queued by the handler ran: the outputs of an async callback
   * captured by the handler, like after an `await null`, still go to
   * `parentHeader` until then. Without a scheduler, it resolves at once, and
   * the host calls flushOutputs() once it ran the jobs.
   */
  handleCommOpen(
    commId: string,
    targetName: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string,
    parentHeader?: Record<string, unknown>
  ): Promise<void> {
    return this._handleComm(parentMessageId, parentHeader, () => {
      this._commManager.handleCommOpen(commId, targetName, data, buffers);
    });
  }

  /**
   * Handle a comm_msg message from the frontend, like handleCommOpen().
   */
  handleCommMsg(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string,
    parentHeader?: Record<string, unknown>
  ): Promise<void> {
    return this._handleComm(parentMessageId, parentHeader, () => {
      this._commManager.handleCommMsg(commId, data, buffers);
    });
  }

  /**
   * Handle a comm_close message from the frontend, like handleCommOpen().
   */
  handleCommClose(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string,
    parentHeader?: Record<string, unknown>
  ): Promise<void> {
    return this._handleComm(parentMessageId, parentHeader, () => {
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
   * Handle a comm message of the frontend, outside of an execution, and
   * report the errors of the handler.
   *
   * The errors thrown by the kernel are not seen by the listeners of
   * globalScope when the kernel runs in another realm, like the page of an
   * iframe, so they are reported here.
   */
  private _handleComm(
    parentMessageId: string | undefined,
    parentHeader: Record<string, unknown> | undefined,
    callback: () => void
  ): Promise<void> {
    const request = toParent(parentMessageId, parentHeader);
    this._router.runRequest(request, () => {
      try {
        callback();
      } catch (error) {
        this.reportUncaught(error);
      } finally {
        // The outputs of the handler are sent before it returns, like the
        // prints of a button click
        this._outputs.flush();
      }
    });
    const scheduler = this._scheduler;
    if (!scheduler || this._isDisposed) {
      return Promise.resolve();
    }
    // The jobs queued by the handler run before the timer, not the code
    // after an await of a timer or of a request: that one is not awaited
    return new Promise(resolve => {
      const end = (): void => {
        this._openRequests.delete(end);
        this._outputs.flush();
        this._router.endRequest(request);
        resolve();
      };
      this._openRequests.add(end);
      scheduler.setTimeout(end, 0);
    });
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
   * @param silent - Whether the error is only returned, for a silent
   * execution, and not sent as an output.
   */
  private _emitError(
    executionCount: number,
    error: unknown,
    currentToken?: string,
    silent = false
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

    if (!silent) {
      this._onOutput({
        type: 'execute_error',
        bundle: content
      });
    }

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
        try {
          const parent = this._router.current.header as
            | Record<string, unknown>
            | undefined;
          return requestInput(String(message), password, parent);
        } finally {
          this._guard.resetClock();
        }
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
    const jupyter: Record<string, unknown> = {
      ...(typeof previousJupyter === 'object' && previousJupyter !== null
        ? previousJupyter
        : {}),
      comm: this._commManager,
      widgets: createWidgetClasses(this._commManager)
    };
    const guard = this._guard;
    Object.defineProperty(jupyter, 'loopTimeout', {
      get: () => guard.timeout,
      set: (value: unknown) => {
        const timeout = Number(value);
        if (!Number.isFinite(timeout) || timeout < 0) {
          throw new RangeError(
            'Jupyter.loopTimeout must be a number of milliseconds, 0 for no limit'
          );
        }
        guard.timeout = timeout;
      },
      enumerable: true,
      configurable: true
    });
    scope.Jupyter = jupyter;
    this._installRequireStub();

    // The timers keep the cell which created them, for their outputs
    const router = this._router;
    this._timers.install(scope, {
      capture: () => router.context(),
      enter: context => router.enter(context as IParentMessage),
      leave: (previous, threw) =>
        router.leave(previous as IParentMessage | null, threw)
    });
    this._wrapBlockingFunctions();
  }

  /**
   * Install a `require()` which explains that the cells use `import`, like
   * ES modules, unless the runtime has its own, like RequireJS in the page.
   * It throws a ReferenceError, like a `require` which is not defined, so the
   * code checking for CommonJS with a try/catch keeps working.
   */
  private _installRequireStub(): void {
    const scope = this._globalScope;
    if (safe(() => 'require' in scope, true)) {
      return;
    }
    this._previousGlobals.set('require', undefined);
    const scopeReferenceError = safe(() => scope.ReferenceError);
    const ReferenceErrorConstructor: ReferenceErrorConstructor =
      typeof scopeReferenceError === 'function'
        ? scopeReferenceError
        : ReferenceError;
    const require = setDoc((name?: unknown) => {
      const source = typeof name === 'string' ? name : 'package-name';
      throw new ReferenceErrorConstructor(
        `require() is not available, the cells run like ES modules: use import x from '${source}' or await import('${source}') instead`
      );
    }, "require() is not available, the cells run like ES modules: use import x from 'package-name' or await import('package-name') instead.");
    Object.defineProperty(scope, 'require', {
      value: require,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  /**
   * Restart the clock of the loop timeout after the functions waiting for
   * the user, like alert() and prompt(), and the synchronous requests: the
   * page is blocked on purpose. The functions are wrapped in proxies, which
   * still look like the native functions when inspected.
   */
  private _wrapBlockingFunctions(): void {
    const scope = this._globalScope;
    const guard = this._guard;
    const afterCall = <T extends (...args: any[]) => any>(
      fn: T,
      when: (thisArg: unknown) => boolean = () => true
    ): T =>
      new Proxy(fn, {
        apply: (target, thisArg, args) => {
          if (!when(thisArg)) {
            return Reflect.apply(target, thisArg, args);
          }
          try {
            return Reflect.apply(target, thisArg, args);
          } finally {
            guard.resetClock();
          }
        }
      });

    for (const name of BLOCKING_FUNCTIONS) {
      const original = safe(() => scope[name]);
      // The prompt() of the kernel restarts the clock itself
      if (typeof original !== 'function' || getDoc(original) !== undefined) {
        continue;
      }
      if (!this._previousGlobals.has(name)) {
        this._previousGlobals.set(
          name,
          Object.getOwnPropertyDescriptor(scope, name)
        );
      }
      scope[name] = afterCall(original);
    }

    const xhr = safe(() => scope.XMLHttpRequest?.prototype);
    if (
      xhr &&
      typeof xhr.open === 'function' &&
      typeof xhr.send === 'function'
    ) {
      const { open, send } = xhr;
      const synchronous = new WeakSet<object>();
      xhr.open = new Proxy(open, {
        apply: (target, thisArg, args) => {
          if (args.length > 2 && !args[2]) {
            synchronous.add(thisArg);
          } else {
            synchronous.delete(thisArg);
          }
          return Reflect.apply(target, thisArg, args);
        }
      });
      xhr.send = afterCall(send, thisArg => synchronous.has(thisArg as object));
      this._restoreXhr = () => {
        xhr.open = open;
        xhr.send = send;
      };
    }
  }

  /**
   * Restore the globals replaced by the kernel.
   */
  private _restoreGlobals(): void {
    this._timers.restore();
    this._restoreXhr?.();
    this._restoreXhr = null;
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
  private _guard: LoopGuard;
  private _timers = new TimerRegistry();
  private _router = new OutputRouter();
  // Ends the comm requests waiting for the jobs of their handler
  private _openRequests = new Set<() => void>();
  private _restoreXhr: (() => void) | null = null;
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
  private _previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  private _originalConsole = new Map<string, unknown>();
}

/**
 * The results of the user expressions in an execute_reply, by name: the MIME
 * bundle of the value of an expression, `{ status: 'ok', data, metadata }`,
 * or its error, `{ status: 'error', ename, evalue, traceback }`.
 */
type UserExpressionResults = KernelMessage.IExecuteReply['user_expressions'];

/**
 * The parent message of a request of the host.
 */
function toParent(
  id: string | undefined,
  header: Record<string, unknown> | undefined,
  silent = false
): IParentMessage {
  return {
    id: id ?? (typeof header?.msg_id === 'string' ? header.msg_id : null),
    header: header as KernelMessage.IHeader | undefined,
    ...(silent ? { silent } : {})
  };
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
     * The options of the executor, like the CDN of the magic imports, as
     * plain data. They also change the configuration of `executor`.
     */
    executorOptions?: IExecutorOptions;

    /**
     * Ask the user for some input, for prompt(). It blocks until the user
     * replies, and returns null when the user cancels. It throws a
     * StdinNotImplementedError when the input can not be requested, like
     * when the frontend does not allow it: the cell fails with it. Without
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

    /**
     * The time in milliseconds a loop of the cells can keep the page busy
     * before it is stopped with a LoopTimeoutError, 0 (the default) for no
     * limit. The time counts from the first iteration, until the page can
     * handle a task. The code of the cells changes it with
     * `Jupyter.loopTimeout`.
     */
    loopTimeout?: number;

    /**
     * A flag shared with the host, to interrupt the loops of a cell from
     * another thread: the host sets its first element to a non-zero value
     * (with Atomics.store), and the loops throw a KeyboardInterrupt. The
     * evaluator resets it at the start of every execution. It is a view of
     * a SharedArrayBuffer, available when the page is cross-origin isolated.
     */
    interruptBuffer?: Int32Array;
  }

  /**
   * The timers of a host.
   */
  export type IScheduler = OutputBatcher.IScheduler;

  /**
   * The options of an execution, from the content of its execute_request.
   */
  export interface IExecuteOptions {
    /**
     * Run the code as quietly as possible, for a request with `silent`: its
     * outputs, its result and its error are not sent, only its comm
     * messages, and neither are the outputs of its timers and callbacks.
     * The error is still returned in the reply. Once it ends, the outputs
     * sent outside of the cells go to the cell which ran before it again,
     * also the ones of the promise continuations of the silent code which
     * run after it ended, and its unhandled rejections.
     */
    silent?: boolean;

    /**
     * Whether the code is in the history of the execution counts, false for
     * a request with `store_history: false`: the code is then named
     * `<silent-k>` in the tracebacks, instead of the cell of the execution
     * count, `In[n]`. True by default, false for a silent execution.
     */
    storeHistory?: boolean;

    /**
     * The `user_expressions` of the request: the expressions evaluated after
     * the code, when it succeeds, by name. The reply holds their results.
     */
    userExpressions?: Record<string, string>;
  }
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
