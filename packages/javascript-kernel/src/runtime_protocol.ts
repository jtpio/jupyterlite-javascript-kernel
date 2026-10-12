// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';
import type { IWorkerKernel } from '@jupyterlite/services';

import type {
  IExecutorOptions,
  JavaScriptRuntimeEvaluator,
  RuntimeOutputMessage
} from '@jupyterlite/javascript-kernel-runtime';

/**
 * Supported runtime backends for the JavaScript kernel.
 */
export type RuntimeMode = 'iframe' | 'worker';

/**
 * Options to initialize a runtime.
 */
export interface IRuntimeInitializeOptions extends IWorkerKernel.IOptions {
  /**
   * Whether prompt() asks for user input in the frontend, with input_request
   * messages relayed by the service worker of JupyterLite. Only a runtime in
   * a Web Worker can block until the user replies. Without
   * `browsingContextId`, prompt() fails with a StdinNotImplementedError.
   */
  stdin?: boolean;

  /**
   * The id of the browsing context of the page, to ask for user input through
   * the service worker, when it controls the page.
   */
  browsingContextId?: string;

  /**
   * The number of characters a cell can print on stdout and stderr, 0 for
   * no limit. Defaults to the limit of the runtime package.
   */
  maxStreamOutput?: number;

  /**
   * The time in milliseconds a loop of the cells can keep the runtime busy
   * before it is stopped with a LoopTimeoutError, 0 for no limit.
   */
  loopTimeout?: number;

  /**
   * The options of the executor, like the CDN of the magic imports.
   */
  executorOptions?: IExecutorOptions;

  /**
   * A flag shared with the page to interrupt the loops of a Web Worker,
   * when the page is cross-origin isolated.
   */
  interruptBuffer?: SharedArrayBuffer;
}

/**
 * The options of an execution, from the content of its execute_request.
 */
export interface IRuntimeExecuteOptions
  extends JavaScriptRuntimeEvaluator.IExecuteOptions {
  /**
   * With false, the frontend does not support input requests: prompt()
   * fails with a StdinNotImplementedError in the Web Worker. Without it, as
   * for the startup code, the setting of the running cell is kept (false
   * when no cell runs).
   */
  allowStdin?: boolean;
}

/**
 * The message a Web Worker runtime posts to the page when the code of a
 * cell closes it with `close()`.
 */
export const RUNTIME_CLOSED_MESSAGE =
  '@jupyterlite/javascript-kernel:runtime-closed';

/**
 * Output callback of the runtime API, called directly in the iframe backend
 * and through a Comlink proxy from a Web Worker.
 */
export type RuntimeOutputCallback = (
  message: RuntimeOutputMessage
) => void | Promise<void>;

/**
 * Runtime API running next to the code of the cells. The iframe backend
 * calls it directly, from the page, and the Web Worker backend over Comlink.
 */
export interface IRemoteRuntimeApi {
  initialize(
    options: IRuntimeInitializeOptions,
    onOutput: RuntimeOutputCallback
  ): Promise<void>;
  /**
   * Execute the code of a cell, with the options of its execute_request.
   */
  execute(
    code: string,
    executionCount: number,
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader,
    options?: IRuntimeExecuteOptions
  ): Promise<KernelMessage.IExecuteReplyMsg['content']>;
  preloadModule(moduleName: string): Promise<void>;
  registerCommTarget(
    targetName: string,
    moduleName: string,
    exportName?: string
  ): Promise<void>;
  unregisterCommTarget(targetName: string): Promise<void>;
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
   * Handle a comm message of the frontend. The outputs captured by an Output
   * widget, and the comm messages sent by the handler, go to `parentHeader`.
   * The promise resolves once the kernel handled the outputs of the
   * synchronous part of the handler: the promises it returns are not
   * awaited.
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
  /**
   * Interrupt the running cell, if any, and clear the timers of the cells.
   */
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}
