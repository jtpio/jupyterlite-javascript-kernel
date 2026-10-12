// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  JavaScriptRuntimeEvaluator,
  type JavaScriptExecutor,
  type RuntimeOutputMessage,
  uuid
} from '@jupyterlite/javascript-kernel-runtime';

import type { IRemoteRuntimeApi } from './runtime_protocol';

/**
 * Ask the user for some input with an input_request message, sent to the
 * page through the service worker of JupyterLite. The synchronous request
 * blocks until the user replies, so it can only be used in a Web Worker: in
 * an iframe, it would block the page showing the input box.
 */
function createInputRequester(
  baseUrl: string,
  browsingContextId: string
): (
  prompt: string,
  password: boolean,
  parentHeader?: Record<string, unknown>
) => string | null {
  const url = `${baseUrl.replace(/\/$/, '')}/api/stdin/kernel`;
  return (prompt, password, parentHeader) => {
    const inputRequest = {
      header: {
        msg_id: uuid(),
        msg_type: 'input_request',
        session: parentHeader?.session ?? '',
        username: parentHeader?.username ?? '',
        date: new Date().toISOString(),
        version: '5.3'
      },
      parent_header: parentHeader ?? {},
      metadata: {},
      content: { prompt, password },
      channel: 'stdin',
      buffers: []
    };
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, false);
      xhr.send(JSON.stringify({ browsingContextId, data: inputRequest }));
      const reply = JSON.parse(xhr.responseText);
      if (!reply || 'error' in reply) {
        return null;
      }
      return reply.content?.value ?? null;
    } catch (error) {
      console.warn(`Failed to request user input: ${error}`);
      return null;
    }
  };
}

/**
 * Create a runtime API bound to the provided global scope, called directly
 * in the page for an iframe, and exposed with Comlink in a Web Worker.
 */
export function createRemoteRuntimeApi(
  globalScope: Record<string, any>,
  executor?: JavaScriptExecutor
): IRemoteRuntimeApi {
  let evaluator: JavaScriptRuntimeEvaluator | null = null;

  const ensureEvaluator = (): JavaScriptRuntimeEvaluator => {
    if (!evaluator) {
      throw new Error('Runtime is not initialized');
    }
    return evaluator;
  };

  // The outputs not yet handled by the kernel. In a Web Worker, they go
  // through the port of the output callback, and the replies through another
  // port, so a reply could arrive before the outputs of its cell, which would
  // be lost.
  const pendingOutputs = new Set<Promise<unknown>>();

  const emitOutput = (
    callback: Parameters<IRemoteRuntimeApi['initialize']>[1],
    message: RuntimeOutputMessage
  ): void => {
    const delivered = Promise.resolve(callback(makeCloneSafe(message))).catch(
      () => {
        // Ignore output callback failures so execution replies can still resolve.
      }
    );
    pendingOutputs.add(delivered);
    void delivered.then(() => pendingOutputs.delete(delivered));
  };

  /**
   * Wait until the kernel handled all the outputs sent so far.
   */
  const flushOutputs = async (): Promise<void> => {
    while (pendingOutputs.size > 0) {
      await Promise.all([...pendingOutputs]);
    }
  };

  return {
    async initialize(
      options: Parameters<IRemoteRuntimeApi['initialize']>[0],
      onOutput: Parameters<IRemoteRuntimeApi['initialize']>[1]
    ): Promise<void> {
      if (typeof options.baseUrl !== 'string') {
        throw new Error('Runtime baseUrl is required');
      }
      evaluator?.dispose();
      evaluator = new JavaScriptRuntimeEvaluator({
        globalScope,
        executor,
        executorOptions: options.executorOptions,
        onOutput: message => {
          emitOutput(onOutput, message);
        },
        requestInput: options.browsingContextId
          ? createInputRequester(options.baseUrl, options.browsingContextId)
          : undefined,
        maxStreamOutput: options.maxStreamOutput,
        loopTimeout: options.loopTimeout,
        interruptBuffer: options.interruptBuffer
          ? new Int32Array(options.interruptBuffer)
          : undefined
      });
    },

    async interrupt(): Promise<void> {
      evaluator?.interrupt();
    },

    async execute(
      code: string,
      executionCount: number,
      parentMessageId?: string,
      parentHeader?: Parameters<IRemoteRuntimeApi['execute']>[3]
    ) {
      const reply = await ensureEvaluator().execute(
        code,
        executionCount,
        parentMessageId,
        parentHeader as Record<string, unknown> | undefined
      );
      await flushOutputs();
      return reply;
    },

    async preloadModule(moduleName: string): Promise<void> {
      await ensureEvaluator().preloadModule(moduleName);
    },

    async registerCommTarget(
      targetName: string,
      moduleName: string,
      exportName?: string
    ): Promise<void> {
      await ensureEvaluator().registerCommTarget(
        targetName,
        moduleName,
        exportName
      );
    },

    async unregisterCommTarget(targetName: string): Promise<void> {
      ensureEvaluator().unregisterCommTarget(targetName);
    },

    async complete(code: string, cursorPos: number) {
      return ensureEvaluator().complete(code, cursorPos);
    },

    async inspect(
      code: string,
      cursorPos: number,
      detailLevel: Parameters<IRemoteRuntimeApi['inspect']>[2]
    ) {
      return ensureEvaluator().inspect(code, cursorPos, detailLevel);
    },

    async isComplete(code: string) {
      return ensureEvaluator().isComplete(code);
    },

    async handleCommOpen(
      commId: string,
      targetName: string,
      data: Record<string, unknown>,
      buffers?: ArrayBuffer[],
      parentMessageId?: string
    ): Promise<void> {
      ensureEvaluator().handleCommOpen(
        commId,
        targetName,
        data,
        buffers,
        parentMessageId
      );
      // The kernel is idle after the outputs of the handler
      await flushOutputs();
    },

    async handleCommMsg(
      commId: string,
      data: Record<string, unknown>,
      buffers?: ArrayBuffer[],
      parentMessageId?: string
    ): Promise<void> {
      ensureEvaluator().handleCommMsg(commId, data, buffers, parentMessageId);
      await flushOutputs();
    },

    async handleCommClose(
      commId: string,
      data: Record<string, unknown>,
      buffers?: ArrayBuffer[],
      parentMessageId?: string
    ): Promise<void> {
      ensureEvaluator().handleCommClose(commId, data, buffers, parentMessageId);
      await flushOutputs();
    },

    async dispose(): Promise<void> {
      evaluator?.dispose();
      evaluator = null;
    }
  };
}

/**
 * Make outbound payload clone-safe for Comlink transport. The kernel in the
 * page gets plain data too, without references to the objects of the cells.
 */
function makeCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // fall through to sanitization
    }
  }

  return sanitize(value, new WeakSet<object>(), 0) as T;
}

/**
 * Convert unsupported values (functions, cyclic objects) to plain data.
 */
function sanitize(value: any, seen: WeakSet<object>, depth: number): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth > 8) {
    return '[Truncated]';
  }

  const valueType = typeof value;
  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean'
  ) {
    return value;
  }
  if (valueType === 'bigint') {
    return value.toString();
  }
  if (valueType === 'symbol' || valueType === 'function') {
    return String(value);
  }

  if (value instanceof ArrayBuffer) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitize(item, seen, depth + 1));
  }

  if (valueType === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const output: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = sanitize(item, seen, depth + 1);
    }

    seen.delete(value);
    return output;
  }

  return String(value);
}
