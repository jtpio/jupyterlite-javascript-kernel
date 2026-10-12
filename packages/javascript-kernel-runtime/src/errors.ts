// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
};

/**
 * Normalize unknown thrown values into Error instances.
 *
 * Supports cross-realm Error objects (for example iframe-thrown errors)
 * by preserving their name/message/stack fields even when `instanceof Error`
 * is false in the current realm.
 */
export function normalizeError(error: unknown, fallbackName = 'Error'): Error {
  if (error instanceof Error) {
    return error;
  }

  if (isErrorLike(error)) {
    const normalized = new Error(
      typeof error.message === 'string' ? error.message : safeToString(error)
    );
    normalized.name =
      typeof error.name === 'string' && error.name ? error.name : fallbackName;

    if (typeof error.stack === 'string' && error.stack.length > 0) {
      normalized.stack = error.stack;
    }

    return normalized;
  }

  const normalized = new Error(safeToString(error));
  normalized.name = fallbackName;
  return normalized;
}

function isErrorLike(error: unknown): error is ErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    ('name' in error || 'message' in error || 'stack' in error)
  );
}

function safeToString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'Unknown error';
  }
}

/**
 * The error of prompt() when the user can not be asked for input, like the
 * StdinNotImplementedError of IPython: the frontend does not support input
 * requests, or the host can not send them. A `requestInput` of the host
 * throws it, and the cell fails with it.
 */
export class StdinNotImplementedError extends Error {
  constructor(
    message = 'prompt() was called, but this frontend does not support input requests.'
  ) {
    super(message);
    this.name = 'StdinNotImplementedError';
  }
}
