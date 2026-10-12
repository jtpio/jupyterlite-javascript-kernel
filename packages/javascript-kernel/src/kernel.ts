// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { KernelMessage } from '@jupyterlab/services';

import { BaseKernel, type IKernel } from '@jupyterlite/services';

import {
  ECMASCRIPT_EDITION,
  KEYBOARD_INTERRUPT,
  normalizeError as normalizeUnknownError,
  stripAnsi,
  type IExecutorOptions,
  type JavaScriptExecutor,
  type RuntimeOutputMessage
} from '@jupyterlite/javascript-kernel-runtime';

import {
  IFrameRuntimeBackend,
  IRuntimeBackend,
  RuntimeReloadedError,
  RuntimeRestartedError,
  RuntimeStartupError,
  RuntimeStoppedError,
  WorkerRuntimeBackend,
  withTimeout
} from './runtime_backends';
import type { RuntimeMode } from './runtime_protocol';
import { KERNEL_VERSION } from './version';

/**
 * A kernel that executes JavaScript code in browser runtimes.
 */
export class JavaScriptKernel extends BaseKernel implements IKernel {
  /**
   * Instantiate a new JavaScriptKernel.
   *
   * @param options - The instantiation options for a new JavaScriptKernel.
   */
  constructor(options: JavaScriptKernel.IOptions) {
    super(options);
    this._sendKernelMessage = options.sendMessage;
    this._runtimeMode = options.runtime ?? 'iframe';
    this._executorFactory = options.executorFactory;
    this._browsingContextId = options.browsingContextId;
    this._maxStreamOutput = options.maxStreamOutput;
    this._loopTimeout = options.loopTimeout;
    this._executorOptions = options.executorOptions;
    this._cdnSetting = options.cdnSetting;
    this._startupExtensions = [...(options.startupExtensions ?? [])];
    this._backend = this.createBackend(this._runtimeMode);
  }

  /**
   * Dispose the kernel.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this._comms.clear();
    this._backend.dispose();
    this._runtimeReadyContext = null;
    this._appliedStartupExtensions.clear();
    this._failedStartupExtensions.clear();
    super.dispose();
  }

  /**
   * A promise that is fulfilled when the kernel runtime is ready, or failed
   * to start: the requests then get a reply with the error, in
   * `startupError`, instead of waiting forever.
   */
  get ready(): Promise<void> {
    // The backend has a new promise when its runtime restarts
    const backendReady = this._backend.ready;
    if (backendReady !== this._backendReady) {
      this._backendReady = backendReady;
      this._ready = backendReady.then(
        () => {
          if (this._backendReady === backendReady) {
            this._startupError = null;
          }
        },
        error => {
          if (this._backendReady === backendReady) {
            this._startupError = new RuntimeStartupError(
              this.normalizeError(error).message
            );
          }
        }
      );
    }
    return this._ready;
  }

  /**
   * The error of the runtime, when it failed to start: the cells fail with
   * it.
   */
  get startupError(): RuntimeStartupError | null {
    return this._startupError;
  }

  /**
   * Interrupt the running cell, if any, and clear the timers of the cells.
   *
   * JupyterLite cancels the queued cells on interrupt, but does not tell
   * the kernel: installKernelInterrupts makes it call this method.
   */
  async interrupt(): Promise<void> {
    await this._backend.interrupt();
  }

  /**
   * Handle an incoming message from the client.
   *
   * JupyterLite does not reply to the `comm_info_request` messages yet: the
   * widget manager of a notebook reopened on a running kernel would wait for
   * the reply forever. This can be removed once BaseKernel handles them.
   *
   * BaseKernel sends an `execute_input` message for the silent
   * `execute_request` messages too, and makes them the parent of the outputs
   * sent outside of the cells: the kernel handles them itself, and still
   * calls `executeRequest()`, which the kernels building on it override,
   * with the silent content.
   */
  async handleMessage(msg: KernelMessage.IMessage): Promise<void> {
    if (
      msg.header.msg_type === 'execute_request' &&
      (msg as KernelMessage.IExecuteRequestMsg).content.silent
    ) {
      return this._executeSilent(msg as KernelMessage.IExecuteRequestMsg);
    }
    if (msg.header.msg_type !== 'comm_info_request') {
      return super.handleMessage(msg);
    }
    const request = msg as KernelMessage.ICommInfoRequestMsg;
    this._publishStatus('busy', request);
    const content = await this.commInfoRequest(request.content);
    this._sendKernelMessage(
      KernelMessage.createMessage({
        msgType: 'comm_info_reply',
        channel: 'shell',
        session: request.header.session,
        parentHeader: request.header,
        content
      })
    );
    this._publishStatus('idle', request);
  }

  /**
   * The active runtime backend.
   */
  protected get runtimeBackend(): IRuntimeBackend {
    return this._backend;
  }

  /**
   * Handle a kernel_info_request message.
   */
  async kernelInfoRequest(): Promise<KernelMessage.IInfoReplyMsg['content']> {
    return {
      status: 'ok',
      protocol_version: '5.3',
      implementation: 'jupyterlite-javascript-kernel',
      implementation_version: KERNEL_VERSION,
      language_info: {
        name: 'javascript',
        version: `ES${ECMASCRIPT_EDITION}`,
        mimetype: 'text/javascript',
        file_extension: '.js',
        codemirror_mode: {
          name: 'javascript'
        },
        pygments_lexer: 'javascript',
        // nbconvert has no javascript exporter: the script exporter writes
        // the code cells to a file with the extension above
        nbconvert_exporter: 'script'
      },
      // The console shows the banner
      banner: this._startupError
        ? `${this.banner}\n\n${this._startupError.message}`
        : this.banner,
      help_links: [
        {
          text: 'JavaScript Reference',
          url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference'
        },
        {
          text: 'Web APIs',
          url: 'https://developer.mozilla.org/en-US/docs/Web/API'
        },
        {
          text: 'JavaScript Kernel',
          url: 'https://github.com/jupyterlite/javascript-kernel#readme'
        }
      ]
    };
  }

  /**
   * The name of the runtime shown in the kernel banner.
   */
  protected get runtimeName(): string {
    return this._runtimeMode === 'worker' ? 'Web Worker' : 'IFrame';
  }

  /**
   * The kernel banner, shown in consoles and in the Help menu.
   */
  protected get banner(): string {
    const where =
      this._runtimeMode === 'worker'
        ? 'Code runs in a Web Worker, off the main thread, without the DOM.'
        : 'Code runs in an iframe, with access to the DOM.';
    return (
      `JavaScript kernel ${KERNEL_VERSION} for JupyterLite (${this.runtimeName} runtime)\n` +
      `ECMAScript ${ECMASCRIPT_EDITION}. ${where}`
    );
  }

  /**
   * Handle an `execute_request` message.
   *
   * It is also called for a silent request, whose `content.silent` is true:
   * `parentHeader` is then still the header of the request which ran before
   * it, and the outputs published by an override with it go to that cell.
   */
  async executeRequest(
    content: KernelMessage.IExecuteRequestMsg['content']
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    const header =
      content.silent && this._silentHeader
        ? this._silentHeader
        : this.parentHeader;
    return this._executeCode(content, header);
  }

  /**
   * Execute the code of an `execute_request` message, with its header.
   *
   * A silent request publishes no outputs, no result and no error, only its
   * comm messages: its error is in the reply. The `user_expressions` are
   * evaluated after the code, when it succeeds, and their results are in the
   * reply.
   */
  private async _executeCode(
    content: KernelMessage.IExecuteRequestMsg['content'],
    header: KernelMessage.IHeader | undefined
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    const silent = content.silent === true;
    try {
      await this.ready;
      if (this._startupError) {
        throw this._startupError;
      }
      if (!silent) {
        this._reportStartupExtensionErrors();
      }
      return await this._backend.execute(
        content.code,
        this.executionCount,
        header?.msg_id,
        header,
        {
          allowStdin: content.allow_stdin,
          silent,
          // Like BaseKernel, which counts the requests storing the history
          storeHistory: !silent && content.store_history === true,
          userExpressions: content.user_expressions as
            | Record<string, string>
            | undefined
        }
      );
    } catch (error) {
      if (
        error instanceof RuntimeRestartedError ||
        error instanceof RuntimeReloadedError ||
        error instanceof RuntimeStoppedError ||
        error instanceof RuntimeStartupError
      ) {
        // Errors of the kernel, without frames
        const ename =
          error instanceof RuntimeRestartedError
            ? KEYBOARD_INTERRUPT
            : error.name;
        const errorContent = {
          ename,
          evalue: error.message,
          traceback: [`${ename}: ${error.message}`]
        };
        if (!silent) {
          this.publishExecuteError(errorContent, header);
        }
        return {
          status: 'error',
          execution_count: this.executionCount,
          ...errorContent
        };
      }
      const normalized = this.normalizeError(error);
      const traceback = [
        normalized.stack || normalized.message || String(error)
      ];

      if (!silent) {
        this.publishExecuteError(
          {
            ename: normalized.name || 'RuntimeError',
            evalue: normalized.message || '',
            traceback
          },
          header
        );
      }

      return {
        status: 'error',
        execution_count: this.executionCount,
        ename: normalized.name || 'RuntimeError',
        evalue: normalized.message || '',
        traceback
      };
    }
  }

  /**
   * Handle a `complete_request` message.
   */
  async completeRequest(
    content: KernelMessage.ICompleteRequestMsg['content']
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    try {
      await this.ready;
      return await this._backend.complete(content.code, content.cursor_pos);
    } catch {
      return {
        matches: [],
        cursor_start: content.cursor_pos,
        cursor_end: content.cursor_pos,
        metadata: {},
        status: 'ok'
      };
    }
  }

  /**
   * Handle an `inspect_request` message.
   */
  async inspectRequest(
    content: KernelMessage.IInspectRequestMsg['content']
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    try {
      await this.ready;
      return await this._backend.inspect(
        content.code,
        content.cursor_pos,
        content.detail_level
      );
    } catch {
      return {
        status: 'ok',
        found: false,
        data: {},
        metadata: {}
      };
    }
  }

  /**
   * Handle an `is_complete_request` message.
   */
  async isCompleteRequest(
    content: KernelMessage.IIsCompleteRequestMsg['content']
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    try {
      await this.ready;
      return await this._backend.isComplete(content.code);
    } catch {
      return {
        status: 'unknown'
      };
    }
  }

  /**
   * Handle a `comm_info_request` message.
   */
  async commInfoRequest(
    content: KernelMessage.ICommInfoRequestMsg['content']
  ): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    const comms: Record<string, { target_name: string }> = {};
    for (const [commId, info] of this._comms) {
      if (!content.target_name || info.target_name === content.target_name) {
        comms[commId] = { target_name: info.target_name };
      }
    }
    return {
      status: 'ok',
      comms
    };
  }

  /**
   * Send an `input_reply` message.
   */
  inputReply(content: KernelMessage.IInputReplyMsg['content']): void {
    this._logUnsupportedControlMessage('input_reply');
  }

  /**
   * Send an `comm_open` message.
   */
  async commOpen(msg: KernelMessage.ICommOpenMsg): Promise<void> {
    if (this._startupError) {
      // No runtime handles the comms
      return;
    }
    const { comm_id, target_name, data } = msg.content;
    this._comms.set(comm_id, { target_name });
    const buffers = this._toArrayBuffers(msg.buffers);
    await this._backend.handleCommOpen(
      comm_id,
      target_name,
      data as Record<string, unknown>,
      buffers,
      msg.header.msg_id,
      msg.header
    );
  }

  /**
   * Send an `comm_msg` message.
   */
  async commMsg(msg: KernelMessage.ICommMsgMsg): Promise<void> {
    if (this._startupError) {
      return;
    }
    const { comm_id, data } = msg.content;
    const buffers = this._toArrayBuffers(msg.buffers);
    await this._backend.handleCommMsg(
      comm_id,
      data as Record<string, unknown>,
      buffers,
      msg.header.msg_id,
      msg.header
    );
  }

  /**
   * Send an `comm_close` message.
   */
  async commClose(msg: KernelMessage.ICommCloseMsg): Promise<void> {
    if (this._startupError) {
      return;
    }
    const { comm_id, data } = msg.content;
    this._comms.delete(comm_id);
    const buffers = this._toArrayBuffers(msg.buffers);
    await this._backend.handleCommClose(
      comm_id,
      data as Record<string, unknown>,
      buffers,
      msg.header.msg_id,
      msg.header
    );
  }

  /**
   * Called once a runtime backend is initialized, before `ready` resolves.
   *
   * An error thrown here makes the runtime fail to start: the cells then
   * fail with a RuntimeStartupError. The errors of the startup extensions,
   * and the ones which do not activate within STARTUP_EXTENSION_TIMEOUT_MS,
   * are printed in the outputs of the next cell, and the kernel keeps
   * running without them.
   */
  protected async onRuntimeReady(
    context: JavaScriptKernel.IRuntimeReadyContext
  ): Promise<void> {
    this._runtimeReadyContext = context;
    for (const extension of [...this._startupExtensions]) {
      await this._applyStartupExtension(extension, context);
    }
  }

  /**
   * Apply a startup extension to an initialized runtime. The kernel keeps
   * it, and applies it again when its runtime restarts, like a Web Worker
   * which did not stop after an interrupt.
   */
  async applyStartupExtension(
    extension: JavaScriptKernel.IStartupExtension
  ): Promise<void> {
    if (!this._startupExtensions.some(item => item.id === extension.id)) {
      this._startupExtensions.push(extension);
    }
    await this.ready;
    const context = this._runtimeReadyContext;
    if (!context) {
      throw new Error('JavaScript runtime is not initialized');
    }
    await this._applyStartupExtension(extension, context);
  }

  /**
   * Remove runtime registrations made by a startup extension: the kernel
   * does not apply it again when its runtime restarts.
   */
  async removeStartupExtension(
    extension: JavaScriptKernel.IStartupExtension
  ): Promise<void> {
    this._startupExtensions = this._startupExtensions.filter(
      item => item.id !== extension.id
    );
    await this.ready;
    const context = this._runtimeReadyContext;
    this._failedStartupExtensions.delete(extension.id);
    if (!context || !this._appliedStartupExtensions.has(extension.id)) {
      return;
    }
    try {
      await extension.deactivate?.(context);
    } finally {
      this._appliedStartupExtensions.delete(extension.id);
    }
  }

  /**
   * Create a runtime backend for the selected mode.
   */
  protected createBackend(runtimeMode: RuntimeMode): IRuntimeBackend {
    const options = {
      onOutput: (message: RuntimeOutputMessage) => {
        this.processRuntimeMessage(message);
      },
      maxStreamOutput: this._maxStreamOutput,
      loopTimeout: this._loopTimeout,
      executorOptions: this._executorOptions,
      cdnSetting: this._cdnSetting
    };

    if (runtimeMode === 'worker') {
      return new WorkerRuntimeBackend({
        ...options,
        browsingContextId: this._browsingContextId,
        onRestart: info => {
          // When the worker was busy outside of a cell, like in a timer
          this._onRuntimeRestart(
            info.interrupted
              ? undefined
              : 'The Web Worker did not stop after the interrupt, so it was restarted: the variables, functions and imports of the previous cells are lost.'
          );
        },
        onReady: async context => {
          await this.onRuntimeReady({
            runtime: 'worker',
            execute: async code => {
              const reply = await context.execute(code);
              if (reply.status === 'error') {
                throw this._createRuntimeInitializationError(reply);
              }
              return reply;
            },
            preloadModule: context.preloadModule,
            registerCommTarget: async target => {
              await context.registerCommTarget(
                target.targetName,
                target.module,
                target.exportName
              );
            },
            unregisterCommTarget: context.unregisterCommTarget
          });
        }
      });
    }

    return new IFrameRuntimeBackend({
      ...options,
      executorFactory: this._executorFactory,
      onRestart: info => {
        // When the iframe was reloaded outside of a cell, like in a timer, or
        // after the cell reloading it
        this._onRuntimeRestart(
          info.running
            ? undefined
            : 'The code reloaded or left the page of the iframe, so the runtime was restarted: the variables, functions and imports of the previous cells are lost.'
        );
      },
      onReady: async context => {
        await this.onRuntimeReady({
          runtime: 'iframe',
          globalScope: context.globalScope,
          executor: context.executor,
          execute: async code => {
            const reply = await context.execute(code);
            if (reply.status === 'error') {
              throw this._createRuntimeInitializationError(reply);
            }
            return reply;
          },
          preloadModule: context.preloadModule,
          registerCommTarget: async target => {
            await context.registerCommTarget(
              target.targetName,
              target.module,
              target.exportName
            );
          },
          unregisterCommTarget: context.unregisterCommTarget
        });
      }
    });
  }

  /**
   * Route runtime output messages to Jupyter kernel channels, with the parent
   * header given by the runtime, or else the one of the cell that ran last.
   */
  protected processRuntimeMessage(message: RuntimeOutputMessage): void {
    // The runtime of a disposed kernel can still send some outputs
    if (this.isDisposed) {
      return;
    }
    const parentHeader = message.parentHeader ?? this.parentHeader;

    switch (message.type) {
      case 'stream':
        this.stream(message.bundle, parentHeader);
        break;
      case 'display_data':
        this.displayData(message.bundle, parentHeader);
        break;
      case 'update_display_data':
        this.updateDisplayData(message.bundle, parentHeader);
        break;
      case 'clear_output':
        this.clearOutput(message.bundle, parentHeader);
        break;
      case 'execute_result':
        this.publishExecuteResult(message.bundle, parentHeader);
        break;
      case 'execute_error':
        this.publishExecuteError(message.bundle, parentHeader);
        break;
      case 'comm_open':
        this._comms.set(message.content.comm_id, {
          target_name: message.content.target_name
        });
        this.handleComm(
          'comm_open',
          message.content as any,
          (message.metadata ?? {}) as any,
          message.buffers as any,
          parentHeader
        );
        break;
      case 'comm_msg':
        this.handleComm(
          'comm_msg',
          message.content as any,
          (message.metadata ?? {}) as any,
          message.buffers as any,
          parentHeader
        );
        break;
      case 'comm_close':
        this._comms.delete(message.content.comm_id);
        this.handleComm(
          'comm_close',
          message.content as any,
          (message.metadata ?? {}) as any,
          message.buffers as any,
          parentHeader
        );
        break;
      default:
        break;
    }
  }

  /**
   * Normalize unknown thrown values into Error instances.
   */
  protected normalizeError(error: unknown): Error {
    return normalizeUnknownError(error, 'RuntimeError');
  }

  /**
   * Forget the state of a restarted runtime, a Web Worker which did not stop
   * after an interrupt or an iframe reloaded by the code of a cell: close its
   * comms in the frontend, and apply the startup extensions again to the new
   * runtime.
   *
   * @param notice - The notice printed on stderr, when no cell shows the
   * error of the restart.
   */
  private _onRuntimeRestart(notice?: string): void {
    for (const commId of [...this._comms.keys()]) {
      this.handleComm(
        'comm_close',
        { comm_id: commId, data: {} },
        {},
        [],
        this.parentHeader
      );
    }
    this._comms.clear();
    this._appliedStartupExtensions.clear();
    this._failedStartupExtensions.clear();
    this._runtimeReadyContext = null;
    if (notice) {
      this.stream({ name: 'stderr', text: `${notice}\n` }, this.parentHeader);
    }
  }

  /**
   * Handle a silent `execute_request` message: without `execute_input`,
   * without changing the execution count, the history and the parent of the
   * outputs sent outside of the cells.
   */
  private async _executeSilent(
    request: KernelMessage.IExecuteRequestMsg
  ): Promise<void> {
    this._publishStatus('busy', request);
    // JupyterLite handles one message at a time
    this._silentHeader = request.header;
    let content: KernelMessage.IExecuteReplyMsg['content'];
    try {
      content = await this.executeRequest(request.content);
    } finally {
      this._silentHeader = undefined;
    }
    this._sendKernelMessage(
      KernelMessage.createMessage({
        msgType: 'execute_reply',
        channel: 'shell',
        session: request.header.session,
        parentHeader: request.header,
        content
      })
    );
    this._publishStatus('idle', request);
  }

  /**
   * Publish the status of the kernel while it handles a message.
   */
  private _publishStatus(
    state: 'busy' | 'idle',
    parent: KernelMessage.IMessage
  ): void {
    this._sendKernelMessage(
      KernelMessage.createMessage({
        msgType: 'status',
        channel: 'iopub',
        session: parent.header.session,
        parentHeader: parent.header,
        content: { execution_state: state }
      })
    );
  }

  /**
   * Normalize an execute reply error into an Error instance.
   */
  private _createRuntimeInitializationError(
    reply: KernelMessage.IExecuteReplyMsg['content']
  ): Error {
    const ename =
      'ename' in reply && typeof reply.ename === 'string'
        ? reply.ename
        : 'RuntimeError';
    const evalue =
      'evalue' in reply && typeof reply.evalue === 'string'
        ? reply.evalue
        : 'Runtime initialization failed';
    const error = new Error(evalue);
    error.name = ename;

    const traceback =
      'traceback' in reply && Array.isArray(reply.traceback)
        ? reply.traceback
        : [];
    if (traceback.length > 0) {
      // The traceback is colored for the notebook
      error.stack = stripAnsi(traceback.join('\n'));
    }

    return error;
  }

  /**
   * Convert incoming message buffers to ArrayBuffer for Comlink transport.
   */
  private _toArrayBuffers(
    buffers?: (ArrayBuffer | ArrayBufferView)[]
  ): ArrayBuffer[] | undefined {
    if (!buffers || buffers.length === 0) {
      return undefined;
    }
    return buffers.map(buf => {
      if (ArrayBuffer.isView(buf)) {
        return buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength
        );
      }
      return buf;
    });
  }

  /**
   * Warn once per unsupported control message type to avoid noisy consoles.
   */
  private _logUnsupportedControlMessage(
    type: 'input_reply',
    detail?: string
  ): void {
    if (this._unsupportedControlMessages.has(type)) {
      return;
    }

    this._unsupportedControlMessages.add(type);
    const suffix = detail ? ` (${detail})` : '';

    console.warn(
      `[javascript-kernel] Ignoring unsupported ${type} message${suffix}.`
    );
  }

  /**
   * Apply a startup extension once to the given runtime context.
   *
   * An extension which fails does not stop the runtime: its error is printed
   * in the outputs of the next cell, and it is not applied again to this
   * runtime. So does an extension which does not activate within
   * STARTUP_EXTENSION_TIMEOUT_MS, like one awaiting a promise which never
   * settles: the runtime becomes ready without waiting for it.
   */
  private async _applyStartupExtension(
    extension: JavaScriptKernel.IStartupExtension,
    context: JavaScriptKernel.IRuntimeReadyContext
  ): Promise<void> {
    if (
      this._appliedStartupExtensions.has(extension.id) ||
      this._failedStartupExtensions.has(extension.id)
    ) {
      return;
    }
    const timeout = (this.constructor as typeof JavaScriptKernel)
      .STARTUP_EXTENSION_TIMEOUT_MS;
    try {
      await withTimeout(
        Promise.resolve(extension.activate(context)),
        timeout,
        `it did not activate within ${timeout / 1000} s`,
        'TimeoutError'
      );
    } catch (error) {
      this._failedStartupExtensions.add(extension.id);
      const normalized = this.normalizeError(error);
      const message = normalized.message
        ? `${normalized.name}: ${normalized.message}`
        : normalized.name;
      this._startupExtensionErrors.push(
        `The startup extension "${extension.id}" failed, so the kernel runs without it: ${message}`
      );
      return;
    }
    this._appliedStartupExtensions.add(extension.id);
  }

  /**
   * Print the errors of the startup extensions on stderr, in the outputs of
   * the cell about to run.
   */
  private _reportStartupExtensionErrors(): void {
    if (this._startupExtensionErrors.length === 0) {
      return;
    }
    const text = this._startupExtensionErrors.join('\n');
    this._startupExtensionErrors = [];
    this.stream({ name: 'stderr', text: `${text}\n` }, this.parentHeader);
  }

  private _sendKernelMessage: IKernel.SendMessage;
  private _unsupportedControlMessages = new Set<'input_reply'>();
  private _comms = new Map<string, { target_name: string }>();
  private _backend: IRuntimeBackend;
  private _executorFactory?: JavaScriptKernel.IExecutorFactory;
  private _browsingContextId?: string;
  private _maxStreamOutput?: number;
  private _loopTimeout?: number;
  private _cdnSetting?: string;
  private _executorOptions?: IExecutorOptions;
  private _startupExtensions: JavaScriptKernel.IStartupExtension[];
  private _appliedStartupExtensions = new Set<string>();
  private _failedStartupExtensions = new Set<string>();
  private _startupExtensionErrors: string[] = [];
  private _backendReady: Promise<void> | null = null;
  private _ready: Promise<void> = Promise.resolve();
  private _startupError: RuntimeStartupError | null = null;
  // The header of the silent execute_request being handled, if any
  private _silentHeader: KernelMessage.IHeader | undefined = undefined;
  private _runtimeReadyContext: JavaScriptKernel.IRuntimeReadyContext | null =
    null;
  private _runtimeMode: RuntimeMode;

  /**
   * The time in milliseconds a startup extension has to activate, before
   * the kernel runs without it.
   */
  static readonly STARTUP_EXTENSION_TIMEOUT_MS: number = 30000;
}

/**
 * A namespace for JavaScriptKernel statics.
 */
export namespace JavaScriptKernel {
  /**
   * Runtime context shared by all backend initialization hooks.
   */
  export interface IRuntimeReadyContextBase {
    runtime: RuntimeMode;
    execute: (code: string) => Promise<unknown>;
    preloadModule: (moduleName: string) => Promise<void>;
    registerCommTarget: (target: IStartupCommTarget) => Promise<void>;
    unregisterCommTarget: (targetName: string) => Promise<void>;
  }

  /**
   * Runtime context for iframe backend initialization.
   */
  export interface IIFrameRuntimeReadyContext extends IRuntimeReadyContextBase {
    runtime: 'iframe';
    globalScope: Record<string, any>;
    executor: JavaScriptExecutor;
  }

  /**
   * Runtime context for worker backend initialization.
   */
  export interface IWorkerRuntimeReadyContext extends IRuntimeReadyContextBase {
    runtime: 'worker';
  }

  /**
   * Runtime context available from `onRuntimeReady`.
   */
  export type IRuntimeReadyContext =
    | IIFrameRuntimeReadyContext
    | IWorkerRuntimeReadyContext;

  /**
   * A comm target handler exported by a startup module.
   */
  export interface IStartupCommTarget {
    targetName: string;
    module: string;
    exportName?: string;
  }

  /**
   * Startup extension executed before the kernel accepts user code.
   */
  export interface IStartupExtension {
    id: string;
    activate: (context: IRuntimeReadyContext) => Promise<void> | void;
    deactivate?: (context: IRuntimeReadyContext) => Promise<void> | void;
  }

  /**
   * Factory used to customize iframe runtime evaluation behavior.
   */
  export type IExecutorFactory = (
    globalScope: Record<string, any>
  ) => JavaScriptExecutor;

  /**
   * The instantiation options for a JavaScript kernel.
   */
  export interface IOptions extends IKernel.IOptions {
    runtime?: RuntimeMode;
    executorFactory?: IExecutorFactory;
    startupExtensions?: readonly IStartupExtension[];

    /**
     * The id of the browsing context of the page, from the service worker
     * manager of JupyterLite, only when the service worker is active. With
     * it, prompt() asks for user input in the Web Worker runtime. Without
     * it, prompt() fails there with a StdinNotImplementedError.
     */
    browsingContextId?: string;

    /**
     * The number of characters a cell can print on stdout and stderr: the
     * rest is not shown, with a notice. 5,000,000 by default, 0 for no
     * limit.
     */
    maxStreamOutput?: number;

    /**
     * The time in milliseconds a loop of the cells can keep the runtime busy
     * before it is stopped with a LoopTimeoutError, 0 for no limit. Defaults
     * to 10 s in the iframe runtime, which runs on the thread of the page,
     * and to no limit in the Web Worker runtime. The code of the cells
     * changes it with `Jupyter.loopTimeout`.
     */
    loopTimeout?: number;

    /**
     * The configuration of the executor, like the CDN of the magic imports,
     * as plain data. Applied when the runtime starts, also to the executor
     * of executorFactory.
     */
    executorOptions?: IExecutorOptions;

    /**
     * Where the users set the CDN of the magic imports, like
     * `Settings > Settings Editor > JavaScript Kernel`: the errors of the
     * imports which fail name it. Without it, they do not point to a
     * setting.
     */
    cdnSetting?: string;
  }
}
