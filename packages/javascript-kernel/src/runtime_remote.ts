// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  JavaScriptRuntimeEvaluator,
  StdinNotImplementedError,
  type JavaScriptExecutor,
  type RuntimeOutputMessage,
  uuid
} from '@jupyterlite/javascript-kernel-runtime';

import type { IRemoteRuntimeApi } from './runtime_protocol';

/**
 * How to make prompt() work, in the errors of the Web Worker runtime.
 */
const STDIN_HINT =
  'Open JupyterLite over HTTPS or on localhost, in a browser allowing service workers, or use the JavaScript (IFrame) kernel, where prompt() shows a dialog of the browser.';

/**
 * Ask the user for some input with an input_request message, sent to the
 * page through the service worker of JupyterLite. The synchronous request
 * blocks until the user replies, so it can only be used in a Web Worker: in
 * an iframe, it would block the page showing the input box.
 *
 * It throws a StdinNotImplementedError when the input can not be requested:
 * the frontend does not allow it, or no service worker relays the request.
 *
 * @param browsingContextId - The id of the page for the service worker, when
 * it controls the page.
 * @param isAllowed - Whether the request of the running cell allows input.
 */
function createInputRequester(
  globalScope: Record<string, any>,
  baseUrl: string,
  browsingContextId: string | undefined,
  isAllowed: () => boolean
): (
  prompt: string,
  password: boolean,
  parentHeader?: Record<string, unknown>
) => string | null {
  const url = `${baseUrl.replace(/\/$/, '')}/api/stdin/kernel`;
  // Read before the code of the cells runs, which can replace it
  const Request = globalScope.XMLHttpRequest as typeof XMLHttpRequest;
  return (prompt, password, parentHeader) => {
    if (!isAllowed()) {
      throw new StdinNotImplementedError();
    }
    if (!browsingContextId || typeof Request !== 'function') {
      throw new StdinNotImplementedError(
        `prompt() needs the service worker of JupyterLite, which is not active on this page. ${STDIN_HINT}`
      );
    }
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
    const xhr = new Request();
    let reply: unknown;
    try {
      xhr.open('POST', url, false);
      xhr.send(JSON.stringify({ browsingContextId, data: inputRequest }));
      if (xhr.status === 200) {
        reply = JSON.parse(xhr.responseText);
      }
    } catch {
      // Without a service worker, the server of the site gets the request
    }
    if (typeof reply !== 'object' || reply === null) {
      const status = xhr.status ? ` (HTTP ${xhr.status})` : '';
      throw new StdinNotImplementedError(
        `The input request was not answered by the service worker of JupyterLite${status}. ${STDIN_HINT}`
      );
    }
    if ('error' in reply) {
      return null;
    }
    const value = (reply as { content?: { value?: unknown } }).content?.value;
    return typeof value === 'string' ? value : null;
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
  // Whether the request of the running cell allows input: not the timers
  // of the cells, which run after their request
  let stdinAllowed = false;

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
   * Wait until the kernel handled the outputs sent so far, and the ones
   * sent by the jobs queued until then. Not the outputs sent while waiting
   * for them, like the ones of an interval updating a display: the reply
   * would wait for them forever.
   */
  const flushOutputs = async (): Promise<void> => {
    await Promise.all([...pendingOutputs]);
    await Promise.all([...pendingOutputs]);
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
        requestInput: options.stdin
          ? createInputRequester(
              globalScope,
              options.baseUrl,
              options.browsingContextId,
              () => stdinAllowed
            )
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
      parentHeader?: Parameters<IRemoteRuntimeApi['execute']>[3],
      options: Parameters<IRemoteRuntimeApi['execute']>[4] = {}
    ) {
      const { allowStdin, ...executeOptions } = options;
      const run = async () => {
        const reply = await ensureEvaluator().execute(
          code,
          executionCount,
          parentMessageId,
          parentHeader as Record<string, unknown> | undefined,
          executeOptions
        );
        await flushOutputs();
        return reply;
      };
      // The startup code passes no allowStdin: it can run while a cell
      // awaits, and must not change the input setting of that cell
      if (allowStdin === undefined) {
        return run();
      }
      stdinAllowed = allowStdin;
      try {
        return await run();
      } finally {
        stdinAllowed = false;
      }
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
      parentMessageId?: string,
      parentHeader?: Parameters<IRemoteRuntimeApi['handleCommOpen']>[5]
    ): Promise<void> {
      await ensureEvaluator().handleCommOpen(
        commId,
        targetName,
        data,
        buffers,
        parentMessageId,
        parentHeader as Record<string, unknown> | undefined
      );
      // The kernel is idle after the outputs of the handler and of its jobs
      await flushOutputs();
    },

    async handleCommMsg(
      commId: string,
      data: Record<string, unknown>,
      buffers?: ArrayBuffer[],
      parentMessageId?: string,
      parentHeader?: Parameters<IRemoteRuntimeApi['handleCommMsg']>[4]
    ): Promise<void> {
      await ensureEvaluator().handleCommMsg(
        commId,
        data,
        buffers,
        parentMessageId,
        parentHeader as Record<string, unknown> | undefined
      );
      await flushOutputs();
    },

    async handleCommClose(
      commId: string,
      data: Record<string, unknown>,
      buffers?: ArrayBuffer[],
      parentMessageId?: string,
      parentHeader?: Parameters<IRemoteRuntimeApi['handleCommClose']>[4]
    ): Promise<void> {
      await ensureEvaluator().handleCommClose(
        commId,
        data,
        buffers,
        parentMessageId,
        parentHeader as Record<string, unknown> | undefined
      );
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
