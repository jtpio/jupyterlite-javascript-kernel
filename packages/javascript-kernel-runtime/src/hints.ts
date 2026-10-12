// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// The hints shown after the tracebacks of the common errors, like a typo in
// a name (`Did you mean: console?`), a package the CDN does not have, or a
// request blocked by the network. They are lines of the traceback only: the
// name and the message of the error are kept as is.

import { safe } from './utils';

/**
 * A hint of the host for an error, shown after its traceback: a short text,
 * or null for no hint. The hosts add their own, like the kernel whose realm
 * has no DOM suggesting the one which has it.
 */
export type ErrorHint = (
  error: unknown,
  context: IErrorHintContext
) => string | null;

/**
 * What the hints know of an error.
 */
export interface IErrorHintContext {
  /**
   * The global scope of the cells.
   */
  globalScope: Record<string, any>;

  /**
   * The import which failed with this error, when the error is the failure
   * of a magic import, like `import _ from 'lodahs-es'`.
   */
  failedImport?: IFailedImport;
}

/**
 * A magic import which failed.
 */
export interface IFailedImport {
  /**
   * The source of the import, as written in the code, like 'lodahs-es'.
   */
  source: string;

  /**
   * The URL the source was rewritten to.
   */
  url: string;

  /**
   * The HTTP status of the URL, checked with a HEAD request after the
   * failure, 0 when the request failed, like when the CDN can not be
   * reached, or null when it was not checked, like in an engine without
   * fetch().
   */
  status: number | null;
}

/**
 * The messages of the errors of fetch() which got no response: Chromium,
 * Firefox and Safari.
 */
const FETCH_FAILED_RE =
  /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/;

/**
 * A name, like in the messages of the errors.
 */
const NAME = '[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200c\\u200d]*';

/**
 * The messages of the ReferenceErrors of an undefined name: V8 and
 * SpiderMonkey (`x is not defined`), QuickJS (`'x' is not defined`) and
 * JavaScriptCore (`Can't find variable: x`).
 */
const UNDEFINED_NAME_RE = new RegExp(
  `^(?:'(${NAME})' is not defined|(${NAME}) is not defined|Can't find variable: (${NAME}))$`,
  'u'
);

/**
 * A chain of names, like `Math.floor` or `a.b.c`.
 */
const CHAIN = `${NAME}(?:\\.${NAME})*`;

/**
 * The messages of the TypeErrors of a member which is not a function, like
 * `Math.flor is not a function`, in V8 and SpiderMonkey, and in
 * JavaScriptCore with the expression after it.
 */
const NOT_A_FUNCTION_RE = new RegExp(
  `^(${NAME}(?:\\.${NAME})+) is not a function(?:\\. \\(In .*\\))?$`,
  'u'
);

/**
 * The messages of the TypeErrors of a member read on undefined or null,
 * which name the chain: SpiderMonkey (`can't access property "x", a.b is
 * undefined`) and JavaScriptCore (`undefined is not an object (evaluating
 * 'a.b.x')`).
 */
const UNDEFINED_CHAIN_RES = [
  new RegExp(
    `^can't access property (?:"[^"]*"|\\S+), (${CHAIN}) is (?:undefined|null)$`,
    'u'
  ),
  new RegExp(
    `^(?:undefined|null) is not an object \\(evaluating '(${CHAIN})\\.${NAME}'\\)$`,
    'u'
  )
];

/**
 * The message of V8, which does not name the chain: it is read from the
 * code, before the column of the error.
 */
const UNDEFINED_MEMBER_RE =
  /^Cannot (?:read|set) properties of (?:undefined|null) \(/;

/**
 * The chain of names just before a dot, at the end of some code.
 */
const CHAIN_BEFORE_DOT_RE = new RegExp(
  `(?:^|[^\\p{ID_Continue}$.])(${CHAIN})\\.$`,
  'u'
);

/**
 * The maximum number of names suggested.
 */
const MAX_SUGGESTIONS = 3;

/**
 * The name of an error, from any realm.
 */
export function errorName(error: unknown): string {
  return safe(() => String((error as any).name), '');
}

/**
 * The message of an error, from any realm.
 */
export function errorMessage(error: unknown): string {
  return safe(() => String((error as any).message), '');
}

/**
 * The name of a ReferenceError for a name which is not defined, like
 * `consle` for `ReferenceError: consle is not defined`, or null for the
 * other errors.
 */
export function undefinedName(error: unknown): string | null {
  if (errorName(error) !== 'ReferenceError') {
    return null;
  }
  const match = UNDEFINED_NAME_RE.exec(errorMessage(error));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

/**
 * The names close to a name, like a typo of it, from some candidates: the
 * closest first, at most three. A name which only differs in case is the
 * closest. The names shorter than three characters get no suggestion, as
 * most short names would match them.
 */
export function closestNames(
  name: string,
  candidates: Iterable<string>
): string[] {
  if (name.length < 3) {
    return [];
  }
  const lower = name.toLowerCase();
  // The largest distance of the names kept, which only decreases
  let best = name.length <= 4 ? 1 : 2;
  let names: string[] = [];
  for (const candidate of candidates) {
    if (candidate === name) {
      continue;
    }
    const distance = editDistance(lower, candidate.toLowerCase(), best + 1);
    if (distance < best) {
      best = distance;
      names = [candidate];
    } else if (distance === best && names.length < MAX_SUGGESTIONS) {
      names.push(candidate);
    }
  }
  return names;
}

/**
 * The number of insertions, deletions, substitutions and transpositions of
 * adjacent characters from a text to another (the optimal string alignment
 * distance), or `max` once it is at least `max`.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) >= max) {
    return max;
  }
  let previous2: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, previous2[j - 2] + 1);
      }
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin >= max) {
      return max;
    }
    previous2 = previous;
    previous = current;
  }
  return Math.min(previous[b.length], max);
}

/**
 * What the built-in hints need.
 */
export interface IBuiltinHintOptions {
  /**
   * The global scope of the cells.
   */
  globalScope: Record<string, any>;

  /**
   * The names of the properties of an object close to a name, for the
   * suggestions.
   */
  closeNames: (name: string, object: unknown) => string[];

  /**
   * The line of code of the error and the column (0-based) of the error in
   * it, when they are known.
   */
  at: { text: string; column: number } | null;
}

/**
 * The hints the kernel shows for the common errors of the cells:
 * `Did you mean: console?` for a ReferenceError of a name close to a global,
 * `Did you mean: Math.floor?` for a member close to a member of the object,
 * and what to check when fetch() got no response.
 */
export function builtinHints(
  error: unknown,
  options: IBuiltinHintOptions
): string[] {
  const hints: string[] = [];
  const name = undefinedName(error);
  if (name !== null) {
    const names = options.closeNames(name, options.globalScope);
    if (names.length > 0) {
      hints.push(`Did you mean: ${names.join(', ')}?`);
    }
    return hints;
  }
  if (errorName(error) !== 'TypeError') {
    return hints;
  }
  const message = errorMessage(error);
  if (FETCH_FAILED_RE.test(message)) {
    hints.push(
      'The request got no response: check the URL and the network connection. A server of another origin must also allow the requests of this page, with CORS headers: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS'
    );
    return hints;
  }
  const chain = memberChain(message, options.at);
  if (chain) {
    const suggestion = memberSuggestion(chain, options);
    if (suggestion) {
      hints.push(suggestion);
    }
  }
  return hints;
}

/**
 * The chain of names of a TypeError of a member which is not a function, or
 * of a member read on undefined, like `Math.flor`.
 */
function memberChain(
  message: string,
  at: IBuiltinHintOptions['at']
): string | null {
  const match =
    NOT_A_FUNCTION_RE.exec(message) ??
    UNDEFINED_CHAIN_RES.map(re => re.exec(message)).find(Boolean);
  if (match) {
    return match[1];
  }
  if (at && UNDEFINED_MEMBER_RE.test(message)) {
    // V8 points at the name of the member read, after the dot
    return CHAIN_BEFORE_DOT_RE.exec(at.text.slice(0, at.column))?.[1] ?? null;
  }
  return null;
}

/**
 * Suggest the members close to the last name of a chain, when the object
 * before it, read from the global scope, has no such member. A chain of a
 * single name, like `node` in `node.width`, is a value which is undefined,
 * not a member with a typo.
 */
function memberSuggestion(
  chain: string,
  options: IBuiltinHintOptions
): string | null {
  const names = chain.split('.');
  const last = names.pop()!;
  if (names.length === 0) {
    return null;
  }
  let object: unknown = options.globalScope;
  for (const name of names) {
    if (!safe(() => name in (object as object), false)) {
      return null;
    }
    object = safe(() => (object as any)[name]);
    if (
      object === null ||
      (typeof object !== 'object' && typeof object !== 'function')
    ) {
      return null;
    }
  }
  if (safe(() => last in (object as object), true)) {
    return null;
  }
  const close = options.closeNames(last, object);
  if (close.length === 0) {
    return null;
  }
  const prefix = names.join('.');
  return `Did you mean: ${close.map(name => `${prefix}.${name}`).join(', ')}?`;
}
