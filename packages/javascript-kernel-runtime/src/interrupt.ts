// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Interruption of the cells: the errors thrown when the user interrupts the
// kernel or when a loop keeps the page busy for too long, the guard called
// by the loops of the cells, and the timers of the cells, cleared when the
// kernel is interrupted.

import { safe } from './utils';

/**
 * The name of the error thrown when the user interrupts the kernel, like in
 * the other Jupyter kernels.
 */
export const KEYBOARD_INTERRUPT = 'KeyboardInterrupt';

/**
 * The name of the error thrown when a loop runs for longer than the loop
 * timeout without letting the page respond.
 */
export const LOOP_TIMEOUT = 'LoopTimeoutError';

/**
 * The name of the loop guard in the compiled cells, which is also the source
 * URL of the guard: its frames are not shown in the tracebacks.
 */
export const LOOP_GUARD_NAME = '__jsKernelLoop__';

/**
 * The call to the loop guard inserted in the body of the loops. The code of
 * a function moved elsewhere, like `fn.toString()` sent to a Web Worker,
 * still runs without the guard.
 */
export function loopGuardCall(site: number): string {
  return `typeof ${LOOP_GUARD_NAME} == 'function' && ${LOOP_GUARD_NAME}(${site});`;
}

/**
 * Remove the calls to the loop guard from some code.
 */
export function stripLoopGuardCalls(code: string): string {
  return code.replace(
    new RegExp(
      `typeof ${LOOP_GUARD_NAME} == 'function' && ${LOOP_GUARD_NAME}\\(\\d+\\);`,
      'g'
    ),
    ''
  );
}

/**
 * Create an error with the Error constructor of a realm, so that
 * `error instanceof Error` holds in the code of the cells.
 */
export function createRuntimeError(
  scope: Record<string, any>,
  name: string,
  message: string
): Error {
  const scopeError = safe(() => scope.Error);
  const ErrorConstructor: ErrorConstructor =
    typeof scopeError === 'function' ? scopeError : Error;
  const error = new ErrorConstructor(message);
  Object.defineProperty(error, 'name', {
    value: name,
    writable: true,
    configurable: true,
    enumerable: false
  });
  return error;
}

/**
 * The kinds of loops.
 */
export type LoopKind =
  | 'for'
  | 'for-in'
  | 'for-of'
  | 'for-await'
  | 'while'
  | 'do-while';

/**
 * A loop of the code of a cell.
 */
export interface ILoopSite {
  kind: LoopKind;

  /**
   * The line (1-based) of the loop in its cell.
   */
  line: number;

  /**
   * The column (1-based) of the loop in its cell.
   */
  column: number;

  /**
   * The name of the cell, like In[3].
   */
  cell?: string;
}

/**
 * The flag of the guard: running, interrupted by the user, or stopped by
 * the loop timeout.
 */
const RUNNING = 0;
const INTERRUPTED = 1;
const TIMED_OUT = 2;

/**
 * The longest number of iterations of a loop between two checks of the
 * clock.
 */
const MAX_STRIDE = 16384;

/**
 * The time between two checks of the clock the guard aims at, in ms.
 */
const CHECK_INTERVAL = 4;

/**
 * The state read by the guard on every iteration of a loop.
 */
interface IGuardState {
  flag: number;

  /**
   * The iterations since the last check, by loop.
   */
  counts: Int32Array;

  /**
   * The iterations between two checks, by loop.
   */
  strides: Int32Array;
}

/**
 * The guard called by the loops of the cells, on every iteration.
 *
 * It stops the loops when the user interrupts the kernel, and the loops
 * keeping the page busy for longer than the timeout: the time is measured
 * from the first check of the task, and a message posted then resets it at
 * the next task. So it measures how long the page could not render or handle
 * the input of the user, through the microtasks too (`while (true) { await
 * null }`). The errors are sticky: the loops keep throwing them until the
 * next execution (interrupted) or the next task (timed out), even if the
 * code of the cell catches them.
 *
 * The guard only checks the clock every few milliseconds, with a number of
 * iterations adapted to the speed of each loop: a fast loop does not delay
 * the checks of a slow loop running after it.
 */
export class LoopGuard {
  /**
   * Instantiate a loop guard.
   */
  constructor(options: LoopGuard.IOptions) {
    const scope = options.globalScope;
    this._scope = scope;
    this._timeout = sanitizeTimeout(options.timeout);
    this._interruptBuffer = options.interruptBuffer ?? null;
    this._now = options.now ?? defaultClock(scope);

    // The guard is created in the realm of the cells, so that the engine can
    // inline it in their loops
    const state = this._state;
    const check = (site: number) => this._check(site);
    const scopeFunction = safe(() => scope.Function);
    const FunctionConstructor: FunctionConstructor =
      typeof scopeFunction === 'function' ? scopeFunction : Function;
    this.fn = new FunctionConstructor(
      'state',
      'check',
      `return function ${LOOP_GUARD_NAME}(site) { if (state.flag !== 0 || ++state.counts[site] >= state.strides[site]) check(site); }\n//# sourceURL=${LOOP_GUARD_NAME}`
    )(state, check);

    this._postTask = taskPoster(scope, () => {
      this._resetStrides();
      if (state.flag === TIMED_OUT) {
        state.flag = RUNNING;
      }
    });
  }

  /**
   * The function called by the loops, with the id of their site.
   */
  readonly fn: (site: number) => void;

  /**
   * The time in milliseconds a loop can keep the page busy, 0 for no limit.
   */
  get timeout(): number {
    return this._timeout;
  }
  set timeout(value: number) {
    this._timeout = sanitizeTimeout(value);
  }

  /**
   * The error thrown by the guard during the current execution, if any:
   * the execution fails with it, even if its code caught it.
   */
  get tripped(): Error | null {
    return this._tripped;
  }

  /**
   * Whether an execution is running.
   */
  get isExecuting(): boolean {
    return this._interrupt !== null;
  }

  /**
   * Register a loop, and return the id passed to the guard.
   */
  registerSite(site: ILoopSite): number {
    const id = this._sites.push(site) - 1;
    this._lastChecks.push(-1);
    const state = this._state;
    if (id >= state.strides.length) {
      // Typed arrays keep the guard fast, they grow by doubling
      const counts = new Int32Array(state.counts.length * 2);
      const strides = new Int32Array(state.strides.length * 2).fill(1);
      counts.set(state.counts);
      strides.set(state.strides);
      state.counts = counts;
      state.strides = strides;
    }
    return id;
  }

  /**
   * Start an execution: clear the interruption and the loop timeout of the
   * previous one, and restart the clock.
   */
  beginExecution(): void {
    this._state.flag = RUNNING;
    this._resetStrides();
    if (this._interruptBuffer) {
      Atomics.store(this._interruptBuffer, 0, 0);
    }
    this._tripped = null;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<never>((_, rejectPromise) => {
      reject = rejectPromise;
    });
    promise.catch(() => undefined);
    this._interrupt = { promise, reject };
  }

  /**
   * Wait for the promise of an execution, or for an interruption.
   */
  race<T>(promise: Promise<T>): Promise<T> {
    return this._interrupt
      ? Promise.race([promise, this._interrupt.promise])
      : promise;
  }

  /**
   * Interrupt the current execution: the loops throw a KeyboardInterrupt,
   * and the execution stops waiting for its promise. Does nothing when no
   * execution is running.
   */
  interrupt(): void {
    if (!this._interrupt) {
      return;
    }
    this._state.flag = INTERRUPTED;
    // The error is not thrown by the code of the cell, so it has no frames
    const error = createRuntimeError(
      this._scope,
      KEYBOARD_INTERRUPT,
      'Execution interrupted'
    );
    safe(() => {
      error.stack = `${KEYBOARD_INTERRUPT}: ${error.message}`;
    });
    this._interrupt.reject(error);
  }

  /**
   * End the current execution.
   */
  endExecution(): void {
    this._interrupt = null;
  }

  /**
   * Restart the clock of the loop timeout, after a call blocking the page
   * on purpose, like alert() or prompt(): the time spent waiting for the
   * user does not count.
   */
  resetClock(): void {
    if (this._taskStart >= 0) {
      this._taskStart = this._now();
      for (const site of this._checkedSites) {
        this._lastChecks[site] = this._taskStart;
      }
    }
  }

  /**
   * Stop listening for the tasks.
   */
  dispose(): void {
    this._postTask.dispose();
  }

  /**
   * Start counting the iterations again, at the start of a task or an
   * execution: the first iterations of the loops check the clock.
   */
  private _resetStrides(): void {
    const { counts, strides } = this._state;
    this._taskStart = -1;
    for (const site of this._checkedSites) {
      counts[site] = 0;
      strides[site] = 1;
      this._lastChecks[site] = -1;
    }
    this._checkedSites = [];
  }

  /**
   * Check the interruption and the clock, every `stride` iterations of a
   * loop.
   */
  private _check(site: number): void {
    const state = this._state;
    state.counts[site] = 0;
    if (
      this._interruptBuffer &&
      this._interrupt &&
      Atomics.load(this._interruptBuffer, 0) !== 0
    ) {
      state.flag = INTERRUPTED;
    }
    if (state.flag === INTERRUPTED) {
      throw this._trip(
        createRuntimeError(
          this._scope,
          KEYBOARD_INTERRUPT,
          'Execution interrupted'
        )
      );
    }
    if (state.flag === TIMED_OUT && this._tripped) {
      throw this._tripped;
    }

    const now = this._now();
    if (this._taskStart < 0) {
      this._taskStart = now;
      this._postTask.post();
    }
    // Check the clock about every CHECK_INTERVAL ms in each loop. The time
    // is measured from the last check of the same loop, so that the time of
    // the inner loops counts in the iterations of the outer loops
    const lastCheck = this._lastChecks[site];
    if (lastCheck !== undefined) {
      if (lastCheck < 0) {
        this._checkedSites.push(site);
      }
      const elapsed = lastCheck < 0 ? 0 : now - lastCheck;
      const stride = state.strides[site];
      this._lastChecks[site] = now;
      state.strides[site] = Math.max(
        1,
        Math.min(
          MAX_STRIDE,
          elapsed <= 0
            ? stride * 2
            : Math.round((stride * CHECK_INTERVAL) / elapsed),
          stride * 2
        )
      );
    }

    if (this._timeout > 0 && now - this._taskStart > this._timeout) {
      state.flag = TIMED_OUT;
      throw this._trip(
        createRuntimeError(
          this._scope,
          LOOP_TIMEOUT,
          this._timeoutMessage(this._sites[site])
        )
      );
    }
  }

  /**
   * Record the error thrown by the guard.
   */
  private _trip(error: Error): Error {
    this._tripped = error;
    return error;
  }

  /**
   * The message of the error of the loop timeout.
   */
  private _timeoutMessage(site: ILoopSite | undefined): string {
    const where = site
      ? `The ${site.kind} loop at line ${site.line}${site.cell ? ` of ${site.cell}` : ''}`
      : 'A loop';
    return (
      `${where} ran for more than ${this._timeout / 1000} s without letting ` +
      'the page respond, so it was stopped. Raise the limit with ' +
      'Jupyter.loopTimeout = 60000 (in ms, 0 turns it off), or run long ' +
      'computations in a Web Worker.'
    );
  }

  private _scope: Record<string, any>;
  private _state: IGuardState = {
    flag: RUNNING,
    counts: new Int32Array(64),
    strides: new Int32Array(64).fill(1)
  };
  private _sites: ILoopSite[] = [];
  private _lastChecks: number[] = [];
  private _checkedSites: number[] = [];
  private _timeout: number;
  private _interruptBuffer: Int32Array | null;
  private _now: () => number;
  private _postTask: ITaskPoster;
  private _taskStart = -1;
  private _tripped: Error | null = null;
  private _interrupt: {
    promise: Promise<never>;
    reject: (reason: unknown) => void;
  } | null = null;
}

/**
 * A namespace for LoopGuard statics.
 */
export namespace LoopGuard {
  /**
   * The instantiation options of a loop guard.
   */
  export interface IOptions {
    /**
     * The global object of the realm running the cells.
     */
    globalScope: Record<string, any>;

    /**
     * The time in milliseconds a loop can keep the page busy, 0 (the
     * default) for no limit.
     */
    timeout?: number;

    /**
     * A shared flag set by the host to interrupt the loops, when it runs in
     * another thread: the loops stop when its first element is not 0.
     */
    interruptBuffer?: Int32Array;

    /**
     * The current time in milliseconds. Defaults to performance.now of
     * globalScope, or else Date.now.
     */
    now?: () => number;
  }
}

/**
 * The timers created by the code of the cells, to clear them when the
 * kernel is interrupted: setTimeout and setInterval of the global scope are
 * wrapped to keep their ids. requestAnimationFrame is left alone, it drives
 * the drawing loops of libraries like p5.js.
 */
export class TimerRegistry {
  /**
   * Wrap the timers of a global scope. The timers are only tracked once
   * enable() is called.
   */
  install(scope: Record<string, any>): void {
    this.restore();
    const setTimeout = scope.setTimeout;
    const setInterval = scope.setInterval;
    const clearTimeout = scope.clearTimeout;
    const clearInterval = scope.clearInterval;
    if (
      typeof setTimeout !== 'function' ||
      typeof clearTimeout !== 'function'
    ) {
      return;
    }
    this._scope = scope;
    for (const name of TIMER_FUNCTIONS) {
      this._saved.set(name, Object.getOwnPropertyDescriptor(scope, name));
    }
    const live = this._live;
    const track = (id: unknown, kind: 'timeout' | 'interval') => {
      if (this._enabled) {
        live.set(id, kind);
      }
    };
    this._clear = id => {
      const clear = live.get(id) === 'interval' ? clearInterval : clearTimeout;
      clear.call(scope, id);
    };
    // The callbacks are wrapped in the realm of the cells: the errors they
    // throw are reported to its global scope
    const scopeFunction = safe(() => scope.Function);
    const wrapCallback = new (typeof scopeFunction === 'function'
      ? scopeFunction
      : Function)(
      'callback',
      'fired',
      'return function () { fired(); return callback.apply(this, arguments); }\n//# sourceURL=__jsKernelTimer__'
    ) as (callback: unknown, fired: () => void) => unknown;

    scope.setTimeout = function (
      this: unknown,
      callback: unknown,
      ...rest: unknown[]
    ) {
      // The timer is not live anymore once it fired
      const id: unknown = setTimeout.call(
        scope,
        typeof callback === 'function'
          ? wrapCallback(callback, () => live.delete(id))
          : callback,
        ...rest
      );
      track(id, 'timeout');
      return id;
    };
    if (typeof setInterval === 'function') {
      scope.setInterval = function (this: unknown, ...args: unknown[]) {
        const id = setInterval.apply(scope, args);
        track(id, 'interval');
        return id;
      };
    }
    scope.clearTimeout = function (this: unknown, id: unknown) {
      live.delete(id);
      return clearTimeout.call(scope, id);
    };
    if (typeof clearInterval === 'function') {
      scope.clearInterval = function (this: unknown, id: unknown) {
        live.delete(id);
        return clearInterval.call(scope, id);
      };
    }
  }

  /**
   * Start tracking the timers, once the runtime is ready: the timers of
   * its startup code are not cleared.
   */
  enable(): void {
    this._enabled = true;
  }

  /**
   * The number of timers waiting to fire.
   */
  get size(): number {
    return this._live.size;
  }

  /**
   * Clear the timers waiting to fire.
   */
  clearAll(): void {
    for (const id of [...this._live.keys()]) {
      safe(() => this._clear?.(id));
    }
    this._live.clear();
  }

  /**
   * Put back the timers of the global scope.
   */
  restore(): void {
    const scope = this._scope;
    if (!scope) {
      return;
    }
    for (const [name, descriptor] of this._saved) {
      if (descriptor) {
        Object.defineProperty(scope, name, descriptor);
      } else {
        delete scope[name];
      }
    }
    this._saved.clear();
    this._scope = null;
    this._clear = null;
  }

  private _scope: Record<string, any> | null = null;
  private _saved = new Map<string, PropertyDescriptor | undefined>();
  private _live = new Map<unknown, 'timeout' | 'interval'>();
  private _clear: ((id: unknown) => void) | null = null;
  private _enabled = false;
}

/**
 * The timer functions wrapped by the registry.
 */
const TIMER_FUNCTIONS = [
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval'
];

/**
 * Posts a message handled at the next task.
 */
interface ITaskPoster {
  post(): void;
  dispose(): void;
}

/**
 * Post the messages with a MessageChannel of the global scope, or else with
 * setTimeout: both run the handler at a later task, after the page could
 * render. Without them, the handler never runs, and the loop timeout
 * counts from the first loop.
 */
function taskPoster(
  scope: Record<string, any>,
  handler: () => void
): ITaskPoster {
  const Channel = safe(() => scope.MessageChannel);
  if (typeof Channel === 'function') {
    const channel = safe(() => new Channel());
    if (channel) {
      let pending = false;
      channel.port1.onmessage = () => {
        pending = false;
        handler();
      };
      return {
        post: () => {
          if (!pending) {
            pending = true;
            channel.port2.postMessage(null);
          }
        },
        dispose: () => {
          channel.port1.onmessage = null;
          channel.port1.close();
          channel.port2.close();
        }
      };
    }
  }
  const setTimeout = safe(() => scope.setTimeout);
  if (typeof setTimeout === 'function') {
    return {
      post: () => {
        setTimeout.call(scope, handler, 0);
      },
      dispose: () => undefined
    };
  }
  return { post: () => undefined, dispose: () => undefined };
}

/**
 * The clock of a global scope: its performance.now, or else Date.now.
 */
export function defaultClock(scope: Record<string, any>): () => number {
  const performance = safe(() => scope.performance);
  if (typeof performance?.now === 'function') {
    const now = performance.now;
    return () => now.call(performance);
  }
  return Date.now;
}

/**
 * A timeout as a number of milliseconds, 0 for no limit.
 */
function sanitizeTimeout(value: unknown): number {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 0;
}
