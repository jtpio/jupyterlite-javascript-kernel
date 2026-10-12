// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import type { RuntimeOutputMessage } from './protocol';

/**
 * A message of the frontend which the outputs of the runtime belong to: the
 * execute_request of a cell, or a comm message handled by the runtime.
 */
export interface IParentMessage {
  /**
   * The id of the message, recorded by Output.capture() in the msg_id of the
   * widget, null when there is none.
   */
  readonly id: string | null;

  /**
   * The header of the message, sent as the parent header of the outputs.
   * Without it, the host attaches the outputs to its own current parent.
   */
  readonly header?: KernelMessage.IHeader;

  /**
   * Whether the outputs of the message are dropped, for a silent
   * execute_request: only its comm messages are sent.
   */
  readonly silent?: boolean;
}

/**
 * An Output widget, which shows the output messages it is given.
 */
export interface IOutputSink {
  /**
   * Add an output message to the outputs of the widget.
   *
   * @returns Whether the widget took the message.
   */
  append(message: RuntimeOutputMessage): boolean;
}

/**
 * The capture of the outputs by an Output widget, with Output.capture().
 */
export interface IOutputCapture {
  /**
   * The id of the message whose outputs the frontend shows in the widget.
   */
  readonly messageId: string;

  /**
   * The message whose outputs the frontend shows in the widget.
   */
  readonly parent: IParentMessage;

  /**
   * Keep capturing the outputs sent outside of the handlers and the
   * callbacks, like after an `await`, until end(): for an async callback.
   */
  hold(): void;

  /**
   * End the capture.
   */
  end(): void;
}

/**
 * No parent message: the host attaches the outputs to its current parent.
 */
const NO_PARENT: IParentMessage = { id: null };

/**
 * A capture of the outputs by an Output widget.
 */
interface ICaptureRecord {
  parent: IParentMessage;
  sink: IOutputSink;
  // Whether a comm handler started the capture
  inRequest: boolean;
  held: boolean;
}

/**
 * Attaches the outputs of the runtime to the message which caused them,
 * their parent message, so that the frontend shows them in the right place:
 *
 * - the outputs of a cell, and of the code running after it, like its
 *   promises, go to the cell which ran last,
 * - the outputs of a timer go to the cell which created the timer, so that
 *   an interval prints in its own cell,
 * - the outputs of a widget callback, like the click handler of a button, go
 *   to the cell which registered the callback,
 * - the outputs captured by an Output widget go to the comm message the
 *   frontend handles in the widget, and the comm messages sent while the
 *   runtime handles a comm message go to that message.
 */
export class OutputRouter {
  /**
   * The parent of the outputs sent outside of the handlers and the callbacks:
   * the cell which ran last.
   */
  get cell(): IParentMessage {
    return this._cell;
  }
  set cell(parent: IParentMessage) {
    this._cell = parent;
    this._openRequest = null;
    this._errorParent = null;
  }

  /**
   * The current parent message: the comm message being handled, or else the
   * parent of the running callback, or else the cell which ran last.
   */
  get current(): IParentMessage {
    return this._request ?? this._scope ?? this._cell;
  }

  /**
   * The parent of the callbacks registered now, like the timers and the
   * widget callbacks: the comm messages are left out, as the frontend
   * forgets them once handled.
   */
  context(): IParentMessage {
    return this._scope ?? this._cell;
  }

  /**
   * Handle a comm message of the frontend: the outputs captured by an Output
   * widget, and the comm messages, go to it.
   *
   * The request stays open after the handler returned, until endRequest():
   * the outputs of the async callbacks captured by the handler, like after
   * an `await null`, still go to the message, which the frontend shows in
   * the widget until the host replied.
   */
  runRequest<T>(request: IParentMessage, callback: () => T): T {
    const previousRequest = this._request;
    const previousScope = this._scope;
    this._request = request;
    this._openRequest = request;
    this._scope = null;
    this._errorParent = null;
    try {
      return callback();
    } finally {
      this._request = previousRequest;
      this._scope = previousScope;
    }
  }

  /**
   * End a comm request, by default the one handled last: the host replied to
   * it, and the frontend forgot it.
   */
  endRequest(request?: IParentMessage): void {
    if (!request || this._openRequest === request) {
      this._openRequest = null;
    }
  }

  /**
   * Run a callback with the outputs going to a parent message.
   */
  runInScope<T>(parent: IParentMessage, callback: () => T): T {
    const previous = this.enter(parent);
    let threw = true;
    try {
      const result = callback();
      threw = false;
      return result;
    } finally {
      this.leave(previous, threw);
    }
  }

  /**
   * Run a callback registered in the context `parent`, like the handler of a
   * widget event. When the frontend triggers it, its outputs go to `parent`,
   * the cell which registered it. When the code of the cells triggers it,
   * like by setting the value of a widget, they go with the outputs of that
   * code.
   */
  runCallback<T>(parent: IParentMessage, callback: () => T): T {
    if (!this._request || this._scope) {
      return callback();
    }
    return this.runInScope(parent, callback);
  }

  /**
   * Make the outputs go to a parent message, until leave().
   *
   * @returns The previous parent, for leave().
   */
  enter(parent: IParentMessage): IParentMessage | null {
    const previous = this._scope;
    this._scope = parent;
    this._errorParent = null;
    return previous;
  }

  /**
   * Restore the parent of the outputs before enter().
   *
   * @param threw - Whether the callback threw: the error, reported by the
   * `error` event of the realm right after, goes to its parent.
   */
  leave(previous: IParentMessage | null, threw = false): void {
    this._errorParent = threw ? this._scope : null;
    this._scope = previous;
  }

  /**
   * Report an uncaught error, with the parent of the callback which threw
   * it when it was the last one to run.
   */
  runUncaught<T>(callback: () => T): T {
    const parent = this._errorParent;
    this._errorParent = null;
    if (!parent || this._request || this._scope) {
      return callback();
    }
    return this.runInScope(parent, callback);
  }

  /**
   * Start capturing the outputs in an Output widget: the frontend shows the
   * outputs of the current message in the widget.
   *
   * @returns The capture, or null without a current message.
   */
  beginCapture(sink: IOutputSink): IOutputCapture | null {
    const parent = this.current;
    const id = parent.id;
    if (id === null) {
      return null;
    }
    const record: ICaptureRecord = {
      parent,
      sink,
      inRequest: parent === this._request,
      held: false
    };
    this._captures.push(record);
    let ended = false;
    return {
      messageId: id,
      parent,
      hold: () => {
        if (!ended) {
          record.held = true;
        }
      },
      end: () => {
        if (ended) {
          return;
        }
        ended = true;
        const index = this._captures.indexOf(record);
        if (index >= 0) {
          this._captures.splice(index, 1);
        }
      }
    };
  }

  /**
   * Where an output message sent now for an Output widget goes, when the
   * widget captures outputs: to the parent message of the capture, or
   * `direct` to the widget once the host replied to the comm message which
   * started the capture, as the frontend forgot the message.
   */
  captureOf(
    sink: IOutputSink
  ): { parent: IParentMessage; direct: boolean } | null {
    for (let i = this._captures.length - 1; i >= 0; i--) {
      const record = this._captures[i];
      if (record.sink === sink) {
        return {
          parent: record.parent,
          direct: record.inRequest && !this._isOpen(record.parent)
        };
      }
    }
    return null;
  }

  /**
   * Attach an output message to its parent message.
   *
   * @returns The message with its parent header, or null when an Output
   * widget took it, or when its parent is a silent request.
   */
  route(message: RuntimeOutputMessage): RuntimeOutputMessage | null {
    if (message.parentHeader) {
      return message;
    }
    const parent = this._parentOf(message);
    if (!parent || (parent.silent && !isCommMessage(message))) {
      return null;
    }
    return parent.header
      ? { ...message, parentHeader: parent.header }
      : message;
  }

  /**
   * The parent message of an output message, or null when an Output widget
   * took it.
   */
  private _parentOf(message: RuntimeOutputMessage): IParentMessage | null {
    if (isCommMessage(message)) {
      return this.current;
    }
    switch (message.type) {
      case 'execute_result':
      case 'execute_error':
        return this._cell;
      default:
        break;
    }
    const request = this._request;
    if (request) {
      // The frontend shows the outputs of the message in the Output widgets
      // capturing them, and forgets them otherwise
      return this._captures.some(record => record.parent === request)
        ? request
        : (this._scope ?? this._cell);
    }
    if (this._scope) {
      return this._scope;
    }
    // Outside of the handlers and the callbacks, like after an `await`: the
    // outputs of an async callback captured by an Output widget
    const held = this._lastHeld();
    if (held) {
      if (!held.inRequest || this._isOpen(held.parent)) {
        return held.parent;
      }
      // The outputs the frontend showed in the widget are in its state once
      // the host replied, unless the frontend is slow to send them
      if (held.sink.append(message)) {
        return null;
      }
    }
    return this._cell;
  }

  /**
   * Whether the frontend still shows the outputs of a comm message in the
   * Output widgets capturing them: until the host replied to it.
   */
  private _isOpen(request: IParentMessage): boolean {
    return request === this._request || request === this._openRequest;
  }

  /**
   * The last capture of an async callback still running.
   */
  private _lastHeld(): ICaptureRecord | undefined {
    for (let i = this._captures.length - 1; i >= 0; i--) {
      if (this._captures[i].held) {
        return this._captures[i];
      }
    }
    return undefined;
  }

  private _cell: IParentMessage = NO_PARENT;
  private _request: IParentMessage | null = null;
  private _openRequest: IParentMessage | null = null;
  private _scope: IParentMessage | null = null;
  private _errorParent: IParentMessage | null = null;
  private _captures: ICaptureRecord[] = [];
}

/**
 * Whether an output message is a comm message, which a silent request still
 * sends, so that the frontend keeps the same comms and widgets.
 */
function isCommMessage(message: RuntimeOutputMessage): boolean {
  return (
    message.type === 'comm_open' ||
    message.type === 'comm_msg' ||
    message.type === 'comm_close'
  );
}
