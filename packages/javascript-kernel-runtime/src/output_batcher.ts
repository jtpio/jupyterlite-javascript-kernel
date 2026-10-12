// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { RuntimeOutputHandler, RuntimeOutputMessage } from './protocol';

/**
 * The stream output messages.
 */
type StreamMessage = Extract<RuntimeOutputMessage, { type: 'stream' }>;

/**
 * Merges the consecutive writes to a stream into one output message, and
 * limits the volume of the stream outputs of a cell.
 *
 * The text written to stdout or stderr is kept until another output, a write
 * to the other stream or for another parent message, a call to flush(), or
 * flushInterval after the first write. It is also sent on a write when
 * flushInterval elapsed, so a long synchronous loop shows its output while
 * it runs, without timers. The frontend merges the consecutive stream
 * outputs anyway, so the notebook shows the same text, with one message
 * instead of one per console.log().
 */
export class OutputBatcher {
  /**
   * Instantiate an output batcher.
   */
  constructor(options: OutputBatcher.IOptions) {
    this._onOutput = options.onOutput;
    this._scheduler = options.scheduler ?? null;
    this._now = options.now ?? Date.now;
    this._parent = options.parent ?? (() => null);
    this._flushInterval =
      options.flushInterval ?? OutputBatcher.DEFAULT_FLUSH_INTERVAL;
    this._maxBufferSize =
      options.maxBufferSize ?? OutputBatcher.DEFAULT_MAX_BUFFER_SIZE;
    this._maxStreamOutput =
      options.maxStreamOutput ?? OutputBatcher.DEFAULT_MAX_STREAM_OUTPUT;
  }

  /**
   * The output handler of the producers, which pushes the messages.
   */
  readonly handler: RuntimeOutputHandler = message => this.push(message);

  /**
   * Handle an output message: keep the text of a stream, or send the
   * pending text and then the message.
   */
  push(message: RuntimeOutputMessage): void {
    if (message.type === 'stream') {
      this._pushStream(message);
      return;
    }
    if (message.type === 'clear_output') {
      this.resetStreamOutput();
      // The pending text of the cell would be shown and cleared at once
      if (!message.bundle.wait && this._bufferParent === this._parent()) {
        this._discard();
      }
    }
    this.flush();
    this._onOutput(message);
  }

  /**
   * Send the pending text, if any.
   */
  flush(): void {
    const first = this._first;
    if (!first) {
      return;
    }
    const text =
      this._chunks.length === 1 ? this._chunks[0] : this._chunks.join('');
    // Reset first, in case the handler writes again
    this._discard();
    this._onOutput({ ...first, bundle: { ...first.bundle, text } });
  }

  /**
   * Whether the cell reached the limit of its stream outputs: the next
   * stream messages are dropped until resetStreamOutput().
   */
  get isTruncated(): boolean {
    return this._isTruncated;
  }

  /**
   * Start counting the stream outputs from zero, for a new cell.
   */
  resetStreamOutput(): void {
    this._streamOutput = 0;
    this._isTruncated = false;
  }

  /**
   * Send the pending text and stop batching: the next messages are sent
   * as they come.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    try {
      this.flush();
    } finally {
      this._isDisposed = true;
    }
  }

  /**
   * Keep the text of a stream message, within the limit of the cell.
   */
  private _pushStream(message: StreamMessage): void {
    const limit = this._maxStreamOutput;
    if (limit <= 0) {
      this._write(message);
      return;
    }
    if (this._isTruncated) {
      return;
    }
    const { text } = message.bundle;
    const remaining = limit - this._streamOutput;
    if (text.length <= remaining) {
      this._streamOutput += text.length;
      this._write(message);
      return;
    }
    this._isTruncated = true;
    this._streamOutput = limit;
    const kept = truncate(text, remaining);
    if (kept) {
      this._write({ ...message, bundle: { ...message.bundle, text: kept } });
    }
    // The notice starts on a new line of stderr
    const newLine =
      message.bundle.name === 'stderr' && kept && !kept.endsWith('\n');
    this._write({
      type: 'stream',
      bundle: {
        name: 'stderr',
        text:
          `${newLine ? '\n' : ''}Output limit reached: the cell printed ` +
          `more than ${groupDigits(limit)} characters, the rest is not ` +
          'shown. Print less, or clear the outputs from the cell with ' +
          'console.clear() or clearOutput() to print more.\n'
      }
    });
  }

  /**
   * Add the text of a stream message to the pending text.
   */
  private _write(message: StreamMessage): void {
    if (this._flushInterval <= 0 || this._isDisposed) {
      this.flush();
      this._onOutput(message);
      return;
    }
    const parent = this._parent();
    const first = this._first;
    if (
      first &&
      (first.bundle.name !== message.bundle.name ||
        this._bufferParent !== parent)
    ) {
      this.flush();
    }
    const { text } = message.bundle;
    if (!this._first) {
      this._first = message;
      this._bufferParent = parent;
      this._start = this._now();
      this._timer =
        this._scheduler?.setTimeout(this._onTimer, this._flushInterval) ?? null;
    }
    this._chunks.push(text);
    this._size += text.length;
    if (
      this._size >= this._maxBufferSize ||
      this._now() - this._start >= this._flushInterval
    ) {
      this.flush();
    }
  }

  /**
   * Drop the pending text, and cancel the timer.
   */
  private _discard(): void {
    if (this._timer !== null) {
      this._scheduler?.clearTimeout(this._timer);
      this._timer = null;
    }
    this._first = null;
    this._bufferParent = null;
    this._chunks = [];
    this._size = 0;
  }

  /**
   * Send the pending text when the timer fires.
   */
  private _onTimer = (): void => {
    this._timer = null;
    try {
      this.flush();
    } catch {
      // The handler of the host failed: keep the error out of the realm of
      // the timer, where it would be reported as an output again
    }
  };

  private _onOutput: RuntimeOutputHandler;
  private _scheduler: OutputBatcher.IScheduler | null;
  private _now: () => number;
  private _parent: () => unknown;
  private _flushInterval: number;
  private _maxBufferSize: number;
  private _maxStreamOutput: number;
  private _first: StreamMessage | null = null;
  private _bufferParent: unknown = null;
  private _chunks: string[] = [];
  private _size = 0;
  private _start = 0;
  private _timer: unknown = null;
  private _streamOutput = 0;
  private _isTruncated = false;
  private _isDisposed = false;
}

/**
 * A namespace for OutputBatcher statics.
 */
export namespace OutputBatcher {
  /**
   * The timers used to send the pending text.
   */
  export interface IScheduler {
    /**
     * Call a function after a delay in milliseconds, and return a handle.
     */
    setTimeout(callback: () => void, ms: number): unknown;

    /**
     * Cancel a call scheduled with setTimeout.
     */
    clearTimeout(handle: unknown): void;
  }

  /**
   * The instantiation options for an output batcher.
   */
  export interface IOptions {
    /**
     * Called with the output messages, in order.
     */
    onOutput: RuntimeOutputHandler;

    /**
     * The timers sending the pending text flushInterval after the first
     * write. Without them, the text is sent by the next output, the next
     * write after flushInterval, or flush().
     */
    scheduler?: IScheduler | null;

    /**
     * The current time in milliseconds. Defaults to Date.now.
     */
    now?: () => number;

    /**
     * The current parent message, compared with ===: the text written for
     * another parent is sent in another message.
     */
    parent?: () => unknown;

    /**
     * The longest time in milliseconds the text is kept, 50 by default.
     * 0 sends every message as it comes.
     */
    flushInterval?: number;

    /**
     * The size of the pending text, in UTF-16 code units, from which it is
     * sent. 1,000,000 by default.
     */
    maxBufferSize?: number;

    /**
     * The number of characters (UTF-16 code units) a cell can print on
     * stdout and stderr, until resetStreamOutput() or a clear_output
     * message: the rest is not sent, and a notice is printed on stderr.
     * 5,000,000 by default, 0 for no limit.
     */
    maxStreamOutput?: number;
  }

  /**
   * The default flushInterval: short enough to feel instant, at most 20
   * stream messages per second.
   */
  export const DEFAULT_FLUSH_INTERVAL = 50;

  /**
   * The default maxBufferSize.
   */
  export const DEFAULT_MAX_BUFFER_SIZE = 1_000_000;

  /**
   * The default maxStreamOutput: 5 MB of ASCII text, like 50,000 lines of
   * 100 characters or 500,000 short lines, far more than a log read in a
   * notebook, and 5 s of the default data rate limit of Jupyter Server
   * (1 MB/s). JupyterLab takes about 2 s per million characters to show
   * them, and stays slow while they are in the notebook: the limit stops an
   * endless loop of console.log() after a few seconds, instead of a frozen
   * page and a notebook file growing without bounds.
   */
  export const DEFAULT_MAX_STREAM_OUTPUT = 5_000_000;
}

/**
 * The start of a text, at most `length` code units, without splitting a
 * surrogate pair.
 */
function truncate(text: string, length: number): string {
  if (length <= 0) {
    return '';
  }
  const code = text.charCodeAt(length - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? length - 1 : length;
  return text.slice(0, end);
}

/**
 * A number with its digits grouped by three, like 10,000,000.
 */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
