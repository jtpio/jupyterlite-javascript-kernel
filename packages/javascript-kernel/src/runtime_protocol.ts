// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';
import type { IWorkerKernel } from '@jupyterlite/services';

import type {
  IExecutorOptions,
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
   * The id of the browsing context of the page, to ask for user input through
   * the service worker. Only a runtime in a Web Worker can block until the
   * user replies.
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
 * The message a Web Worker runtime posts to the page when the code of a
 * cell closes it with `close()`.
 */
export const RUNTIME_CLOSED_MESSAGE =
  '@jupyterlite/javascript-kernel:runtime-closed';

/**
 * Output callback passed across Comlink endpoints.
 */
export type RuntimeOutputCallback = (
  message: RuntimeOutputMessage
) => void | Promise<void>;

/**
 * Runtime API exposed from iframe and worker contexts over Comlink.
 */
export interface IRemoteRuntimeApi {
  initialize(
    options: IRuntimeInitializeOptions,
    onOutput: RuntimeOutputCallback
  ): Promise<void>;
  execute(
    code: string,
    executionCount: number,
    parentMessageId?: string,
    parentHeader?: KernelMessage.IHeader
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
  handleCommOpen(
    commId: string,
    targetName: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string
  ): Promise<void>;
  handleCommMsg(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string
  ): Promise<void>;
  handleCommClose(
    commId: string,
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[],
    parentMessageId?: string
  ): Promise<void>;
  /**
   * Interrupt the running cell, if any, and clear the timers of the cells.
   */
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}
