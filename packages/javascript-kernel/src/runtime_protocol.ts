// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';
import type { IWorkerKernel } from '@jupyterlite/services';

import type { RuntimeOutputMessage } from '@jupyterlite/javascript-kernel-runtime';

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
}

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
  dispose(): Promise<void>;
}
