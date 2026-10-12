// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { RuntimeOutputHandler, RuntimeOutputMessage } from './protocol';

/**
 * The stream output messages.
 */
type StreamMessage = Extract<RuntimeOutputMessage, { type: 'stream' }>;

/**
 * An output message waiting for its content, with the outputs after it.
 */
interface IHeldOutput {
  // null until the content is ready
  message: RuntimeOutputMessage | null;
  fallback: RuntimeOutputMessage;
  // Called once the message is sent, for settled()
  sent?: (() => void)[];
}

/**
 * The number of characters printed for a parent message.
 */
interface IStreamCount {
  count: number;
  isTruncated: boolean;
}

/**
 * Merges the consecutive writes to a stream into one output message, and
 * limits the volume of the stream outputs of each parent message, like a
 * cell: an interval printing in its cell does not silence the other cells.
 *
 * The text written to stdout or stderr is kept until another output, a write
 * to the other stream or for another parent message (another `parentHeader`
 * object), a call to flush(), or flushInterval after the first write. It
 * is also sent on a write, or by flushIfDue(), when flushInterval elapsed,
 * so a long synchronous loop shows its output while it runs, without
 * timers. The frontend merges the consecutive stream outputs anyway, so the
 * notebook shows the same text, with one message instead of one per
 * console.log().
 *
 * An output whose content is not ready yet, like an image being encoded,
 * keeps its place with pushLater(): the outputs pushed after it wait for
 * it.
 */
export class OutputBatcher {
  /**
   * Instantiate an output batcher.
   */
  constructor(options: OutputBatcher.IOptions) {
    this._onOutput = options.onOutput;
    this._scheduler = options.scheduler ?? null;
    this._now = options.now ?? Date.now;
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
    if (this._held.length > 0) {
      this._held.push({ message, fallback: message });
      return;
    }
    this._pushNow(message);
  }

  /**
   * Send an output message once its content is ready, in its place: the
   * outputs pushed after it, and the pending text, are sent after it.
   *
   * @param fallback - The message sent when `ready` rejects, or when
   * releaseHeld() is called first.
   * @param ready - The message with its content.
   */
  pushLater(
    fallback: RuntimeOutputMessage,
    ready: PromiseLike<RuntimeOutputMessage>
  ): void {
    if (this._isDisposed) {
      this.push(fallback);
      return;
    }
    const held: IHeldOutput = { message: null, fallback };
    if (this._held.length === 0) {
      this.flush();
    }
    this._held.push(held);
    const release = (message: RuntimeOutputMessage) => {
      if (held.message === null) {
        held.message = message;
        this._release();
      }
    };
    Promise.resolve(ready)
      .then(release, () => release(fallback))
      .catch(() => {
        // The handler of the host failed: keep the error out of the realm,
        // like for the timer
      });
  }

  /**
   * Send the outputs waiting for their content now, with their fallback,
   * like on interrupt: the content of an image could never come.
   */
  releaseHeld(): void {
    for (const held of this._held) {
      held.message ??= held.fallback;
    }
    this._release();
  }

  /**
   * Wait until the outputs pushed until now are sent to the handler, or are
   * pending text, after the ones pushed with pushLater(). The outputs pushed
   * later are not waited for, like the frames of an animation.
   */
  settled(): Promise<void> {
    const last = this._held[this._held.length - 1];
    if (!last) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      last.sent ??= [];
      last.sent.push(resolve);
    });
  }

  /**
   * Handle an output message, which no held output waits for.
   */
  private _pushNow(message: RuntimeOutputMessage): void {
    if (message.type === 'stream') {
      this._pushStream(message);
      return;
    }
    if (message.type === 'clear_output') {
      this.resetStreamOutput(message.parentHeader);
      // The pending text of the cell would be shown and cleared at once
      if (
        !message.bundle.wait &&
        this._first &&
        this._bufferParent === message.parentHeader
      ) {
        this._discard();
      }
    }
    this.flush();
    this._onOutput(message);
  }

  /**
   * Send the pending text, if any.
   *
   * @param filter - Send it only when its parent header passes the filter,
   * like the ones of an Output widget.
   */
  flush(filter?: (parentHeader: unknown) => boolean): void {
    const first = this._first;
    if (!first || (filter && !filter(first.parentHeader))) {
      return;
    }
    const text =
      this._chunks.length === 1 ? this._chunks[0] : this._chunks.join('');
    // Reset first, in case the handler writes again
    this._discard();
    this._onOutput({ ...first, bundle: { ...first.bundle, text } });
  }

  /**
   * Send the pending text if it was kept for flushInterval, for the hosts
   * whose timers can not fire while the code runs, like a Web Worker busy
   * with a long synchronous loop: the loop guard calls it when it checks
   * the clock.
   */
  flushIfDue(): void {
    if (this._first && this._now() - this._start >= this._flushInterval) {
      this.flush();
    }
  }

  /**
   * Whether a parent message, like a cell, reached the limit of its stream
   * outputs: its next stream messages are dropped until
   * resetStreamOutput().
   *
   * @param parentHeader - The parent header of the messages, the same
   * object.
   */
  isTruncated(parentHeader?: unknown): boolean {
    return this._countOf(parentHeader)?.isTruncated ?? false;
  }

  /**
   * Start counting the stream outputs of a parent message from zero, like
   * for a new cell. The counts of the other parent messages are kept.
   */
  resetStreamOutput(parentHeader?: unknown): void {
    if (isObject(parentHeader)) {
      this._counts.delete(parentHeader);
    } else {
      this._count = null;
    }
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
      this.releaseHeld();
      this.flush();
    } finally {
      this._isDisposed = true;
    }
  }

  /**
   * Send the ready outputs at the head of the held outputs.
   */
  private _release(): void {
    if (this._releasing) {
      return;
    }
    this._releasing = true;
    try {
      while (this._held.length > 0 && this._held[0].message !== null) {
        const held = this._held.shift()!;
        try {
          this._pushNow(held.message!);
        } finally {
          for (const resolve of held.sent ?? []) {
            resolve();
          }
        }
      }
    } finally {
      this._releasing = false;
    }
  }

  /**
   * Keep the text of a stream message, within the limit of its parent
   * message.
   */
  private _pushStream(message: StreamMessage): void {
    const limit = this._maxStreamOutput;
    if (limit <= 0) {
      this._write(message);
      return;
    }
    const parent = message.parentHeader;
    let counted = this._countOf(parent);
    if (!counted) {
      counted = { count: 0, isTruncated: false };
      if (isObject(parent)) {
        this._counts.set(parent, counted);
      } else {
        this._count = counted;
      }
    }
    if (counted.isTruncated) {
      return;
    }
    const { text } = message.bundle;
    const remaining = limit - counted.count;
    if (text.length <= remaining) {
      counted.count += text.length;
      this._write(message);
      return;
    }
    counted.isTruncated = true;
    counted.count = limit;
    const kept = truncate(text, remaining);
    if (kept) {
      this._write({ ...message, bundle: { ...message.bundle, text: kept } });
    }
    // The notice starts on a new line of stderr
    const newLine =
      message.bundle.name === 'stderr' && kept && !kept.endsWith('\n');
    // In the same place as the text it cuts
    this._write({
      type: 'stream',
      parentHeader: message.parentHeader,
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
    const parent = message.parentHeader;
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
   * The count of the stream outputs of a parent message, if it printed.
   */
  private _countOf(parentHeader: unknown): IStreamCount | undefined {
    return isObject(parentHeader)
      ? this._counts.get(parentHeader)
      : (this._count ?? undefined);
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
    this._bufferParent = undefined;
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
  private _flushInterval: number;
  private _maxBufferSize: number;
  private _maxStreamOutput: number;
  private _first: StreamMessage | null = null;
  private _bufferParent: unknown = undefined;
  private _chunks: string[] = [];
  private _size = 0;
  private _start = 0;
  private _timer: unknown = null;
  // The counts of the parent headers, forgotten with them, and the count of
  // the messages without one
  private _counts = new WeakMap<object, IStreamCount>();
  private _count: IStreamCount | null = null;
  private _isDisposed = false;
  private _held: IHeldOutput[] = [];
  private _releasing = false;
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
     * The number of characters (UTF-16 code units) a parent message, like a
     * cell, can print on stdout and stderr, until resetStreamOutput() or a
     * clear_output message of the same parent: the rest is not sent, and a
     * notice is printed on stderr. The messages without a parent header
     * share one count. 5,000,000 by default, 0 for no limit.
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
 * Whether a value is an object, which can be the key of a WeakMap.
 */
function isObject(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
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
