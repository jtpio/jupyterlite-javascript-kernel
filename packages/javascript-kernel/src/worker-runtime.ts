// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as Comlink from 'comlink';

import { createRemoteRuntimeApi } from './runtime_remote';
import { RUNTIME_CLOSED_MESSAGE } from './runtime_protocol';

const runtimeGlobal = self as unknown as Record<string, any>;

// The functions of the transport, read before any code of the cells runs: a
// cell declaring `function postMessage() {}` replaces the global one, and
// the replies to the page would be lost.
const postMessage = runtimeGlobal.postMessage as (
  message: unknown,
  transfer?: Transferable[]
) => void;
const addEventListener = runtimeGlobal.addEventListener;
const removeEventListener = runtimeGlobal.removeEventListener;
const close = runtimeGlobal.close as () => void;

const endpoint: Comlink.Endpoint = {
  postMessage: (message, transfer) =>
    postMessage.call(runtimeGlobal, message, transfer),
  addEventListener: (type, listener, options) =>
    addEventListener.call(runtimeGlobal, type, listener, options),
  removeEventListener: (type, listener, options) =>
    removeEventListener.call(runtimeGlobal, type, listener, options)
};

// close() stops the worker without replying to the pending requests: tell
// the page first, so that they fail instead of waiting forever
runtimeGlobal.close = function () {
  postMessage.call(runtimeGlobal, { type: RUNTIME_CLOSED_MESSAGE });
  close.call(runtimeGlobal);
};

Comlink.expose(createRemoteRuntimeApi(runtimeGlobal), endpoint);
