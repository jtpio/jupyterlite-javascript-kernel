// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { normalizeBundle } from '../display';
import type { IOutputCapture, IOutputSink } from '../output_router';
import type { RuntimeOutputMessage } from '../protocol';
import { isThenable } from '../utils';

import { DOMWidget } from './widget_dom';
import { OUTPUT_MODULE, OUTPUT_MODULE_VERSION } from './version';

export interface IOutputCaptureOptions {
  clearOutput?: boolean;
  wait?: boolean;
}

export class Output extends DOMWidget {
  static override modelName = 'OutputModel';
  static override viewName = 'OutputView';
  static override modelModule = OUTPUT_MODULE;
  static override modelModuleVersion = OUTPUT_MODULE_VERSION;
  static override viewModule = OUTPUT_MODULE;
  static override viewModuleVersion = OUTPUT_MODULE_VERSION;

  protected override _defaults() {
    return {
      ...super._defaults(),
      msg_id: '',
      outputs: []
    };
  }

  get msg_id(): string {
    return this.get('msg_id') as string;
  }
  set msg_id(v: string) {
    this.set('msg_id', v);
  }

  get outputs(): Array<Record<string, unknown>> {
    return [...((this.get('outputs') as Array<Record<string, unknown>>) ?? [])];
  }
  set outputs(v: Array<Record<string, unknown>>) {
    this._flushPending();
    this.set('outputs', [...v]);
  }

  get currentMessageId(): string | null {
    return this._manager.getCurrentMessageId();
  }

  /**
   * Remove the outputs of the widget. With `wait`, they are removed when
   * the next output arrives, to avoid flickering.
   */
  clearOutput(options: { wait?: boolean } = {}): void {
    const wait = Boolean(options.wait);
    const capture = this._manager.router.captureOf(this._sink);
    if (capture && (wait || capture.direct)) {
      // The frontend clears the widget when the next captured output
      // arrives, and the widget clears its own outputs after the ones
      // printed before
      this._manager.publish({
        type: 'clear_output',
        bundle: { wait },
        parentHeader: capture.parent.header
      });
      return;
    }
    this._clear(wait);
  }

  appendStdout(text: string): void {
    this._appendOutput({ output_type: 'stream', name: 'stdout', text });
  }

  appendStderr(text: string): void {
    this._appendOutput({ output_type: 'stream', name: 'stderr', text });
  }

  /**
   * Add a value to the outputs of the widget, shown like display() shows
   * it: a widget, an HTML element, an object... A MIME bundle, an object
   * whose keys are all MIME types, is shown as is.
   */
  appendDisplayData(
    value: unknown,
    metadata: Record<string, unknown> = {}
  ): void {
    const data = isMimeBundle(value)
      ? normalizeBundle(value)
      : this._manager.mimeBundle(value);
    this._appendOutput({
      output_type: 'display_data',
      data,
      metadata
    });
  }

  capture<T extends (...args: any[]) => any>(callback: T): T;
  capture<T extends (...args: any[]) => any>(
    callback: T,
    options: IOutputCaptureOptions
  ): T;
  capture(
    options?: IOutputCaptureOptions
  ): <T extends (...args: any[]) => any>(callback: T) => T;
  capture<T extends (...args: any[]) => any>(
    callbackOrOptions?: T | IOutputCaptureOptions,
    options: IOutputCaptureOptions = {}
  ): T | ((callback: T) => T) {
    if (typeof callbackOrOptions === 'function') {
      return this._captureWrapper(callbackOrOptions, options);
    }

    const captureOptions = callbackOrOptions ?? {};
    return (callback: T) => this._captureWrapper(callback, captureOptions);
  }

  /**
   * Start capturing the outputs of the current message.
   *
   * @internal
   */
  _beginCapture(): IOutputCapture | null {
    const capture = this._manager.router.beginCapture(this._sink);
    if (!capture) {
      return null;
    }
    // The frontend shows the outputs of the message in the widget, like
    // the outputs of a click while the async callback of the click before
    // still runs
    this._captures.push(capture);
    this.msg_id = capture.messageId;
    if (this._clearPending) {
      // The frontend clears the widget when the first captured output
      // arrives, like after clearOutput({ wait: true }) in the capture
      this._clearPending = false;
      this._manager.publish({
        type: 'clear_output',
        bundle: { wait: true },
        parentHeader: capture.parent.header
      });
    }
    return capture;
  }

  /**
   * End a capture of the outputs.
   *
   * @internal
   */
  _endCapture(capture: IOutputCapture | null): void {
    if (!capture) {
      return;
    }
    capture.end();
    const index = this._captures.indexOf(capture);
    if (index < 0) {
      // Already ended, like by a new cell
      return;
    }
    this._captures.splice(index, 1);
    // The frontend shows the outputs of the captures still running
    const last = this._captures[this._captures.length - 1];
    this.msg_id = last?.messageId ?? '';
  }

  /**
   * Remove the outputs, now or when the next one arrives.
   */
  private _clear(wait: boolean): void {
    this._flushPending();
    if (wait) {
      this._clearPending = true;
      return;
    }
    this._clearPending = false;
    this.outputs = [];
  }

  private _appendOutput(output: Record<string, unknown>): void {
    this._flushPending();
    const outputs = this._clearPending ? [] : this.outputs;
    this._clearPending = false;
    const last = outputs[outputs.length - 1];
    if (
      output.output_type === 'stream' &&
      last?.output_type === 'stream' &&
      last.name === output.name
    ) {
      // One output for the consecutive writes to a stream, like in the
      // notebook
      outputs[outputs.length - 1] = {
        ...last,
        text: `${last.text}${output.text}`
      };
    } else {
      outputs.push(output);
    }
    this.outputs = outputs;
  }

  /**
   * Send the state with the outputs printed before, like when the frontend
   * requests it.
   */
  protected override _sendState(state: Record<string, unknown>): void {
    this._flushPending();
    super._sendState(state);
  }

  /**
   * Add the outputs printed before, which the batcher keeps, like the text
   * of console.log() after an `await` in an async callback captured by a
   * comm handler: before the widget changes its outputs, so that they keep
   * their order, and the state the frontend receives last has all of them.
   */
  private _flushPending(): void {
    this._manager.flushOutputs(this._sink);
  }

  /**
   * Add an output message of the runtime to the outputs: the outputs of a
   * callback captured in a comm handler, sent after the handler returned,
   * like after an `await`.
   */
  private _appendMessage(message: RuntimeOutputMessage): boolean {
    switch (message.type) {
      case 'stream':
        this._appendOutput({ output_type: 'stream', ...message.bundle });
        return true;
      case 'display_data':
        this._appendOutput({
          output_type: 'display_data',
          data: message.bundle.data,
          metadata: message.bundle.metadata ?? {}
        });
        return true;
      case 'clear_output':
        this._clear(Boolean(message.bundle.wait));
        return true;
      default:
        return false;
    }
  }

  private _captureWrapper<T extends (...args: any[]) => any>(
    callback: T,
    options: IOutputCaptureOptions
  ): T {
    return _wrapCapturedOutputCallback(this, callback, options);
  }

  private _captures: IOutputCapture[] = [];
  private _clearPending = false;
  private _sink: IOutputSink = {
    append: message => this._appendMessage(message),
    ended: capture => this._endCapture(capture)
  };
}

/**
 * Whether a value is a MIME bundle: a plain object whose keys are all MIME
 * types.
 */
function isMimeBundle(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(key => /^[\w.+-]+\/[\w.+-]+$/.test(key));
}

function _wrapCapturedOutputCallback<T extends (...args: any[]) => any>(
  output: Output,
  callback: T,
  options: IOutputCaptureOptions
): T {
  return function (this: unknown, ...args: any[]): any {
    const capture = output._beginCapture();
    const finish = (): void => {
      output._endCapture(capture);
    };

    try {
      if (options.clearOutput ?? false) {
        // Cleared with the captured outputs, for the wait option
        output.clearOutput({ wait: options.wait });
      }
      const result = callback.apply(this, args);
      if (isThenable(result)) {
        // The outputs sent after the handler returned, like after an await,
        // are still captured
        capture?.hold();
        // The finally of the promise keeps its rejection in the realm of the
        // callback, where the runtime reports the unhandled ones: a promise
        // of the kernel could belong to the page of an iframe
        const promise = result as PromiseLike<unknown> & {
          finally?: (onFinally: () => void) => PromiseLike<unknown>;
        };
        return typeof promise.finally === 'function'
          ? promise.finally(finish)
          : Promise.resolve(result).finally(finish);
      }
      finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  } as T;
}
