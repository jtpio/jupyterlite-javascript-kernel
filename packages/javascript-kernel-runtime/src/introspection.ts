// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Code completion and inspection, from the values of the global scope of the
// runtime.

import { parse } from 'acorn';

import {
  getConstructorName,
  inspect,
  isClass,
  isMap,
  isModuleNamespace,
  isSet
} from './inspect';
import { closestNames } from './hints';
import { color, hasOwn, safe } from './utils';

/**
 * The documentation of a declaration, from its JSDoc comment.
 */
export interface IDeclarationDoc {
  name: string;
  doc: string;
}

/**
 * The reply to a completion request.
 */
export interface ICompletionReply {
  matches: string[];
  cursor_start: number;
  cursor_end: number;
  metadata: Record<string, any>;
}

/**
 * The reply to an inspection request.
 */
export interface IInspectionReply {
  found: boolean;
  data: Record<string, string>;
  metadata: Record<string, any>;
}

// The documentation of the values, from the JSDoc comments of the cells and
// of the functions of the kernel.
const docStore = new WeakMap<object, string>();

// The functions of the kernel, whose source code is not shown.
const kernelApi = new WeakSet<object>();

/**
 * Document a function of the kernel, like display(). The documentation is
 * shown when inspecting the function, instead of its source code.
 */
export function setDoc<T>(value: T, doc: string): T {
  docStore.set(value as unknown as object, doc);
  kernelApi.add(value as unknown as object);
  return value;
}

/**
 * The documentation of a value, if any.
 */
export function getDoc(value: unknown): string | undefined {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function')
    ? docStore.get(value as object)
    : undefined;
}

const IDENTIFIER = String.raw`[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*`;
const IDENTIFIER_RE = new RegExp(`^${IDENTIFIER}$`, 'u');

/**
 * The start of the names of the helpers of the kernel.
 */
const KERNEL_NAME_PREFIX = '__jsKernel';

const KEYWORDS = [
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'of',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield'
];
const KEYWORD_SET = new Set(KEYWORDS);

const MEMBER_RE = new RegExp(
  `(${IDENTIFIER}(?:\\s*\\??\\.\\s*${IDENTIFIER}|\\[(?:\\d+|'[^']*'|"[^"]*")\\])*)\\s*\\??\\.\\s*(${IDENTIFIER})?$`,
  'u'
);
const STRING_MEMBER_RE = new RegExp(
  `(?:'[^'\\\\]*'|"[^"\\\\]*"|\`[^\`\\\\$]*\`)\\s*\\.\\s*(${IDENTIFIER})?$`,
  'u'
);
const ARRAY_MEMBER_RE = new RegExp(`\\]\\s*\\.\\s*(${IDENTIFIER})?$`, 'u');
const CALL_MEMBER_RE = new RegExp(`\\)\\s*\\??\\.\\s*(${IDENTIFIER})?$`, 'u');
const NAME_RE = new RegExp(`(${IDENTIFIER})$`, 'u');
const CHAIN_RE = new RegExp(
  `${IDENTIFIER}(?:\\s*\\??\\.\\s*${IDENTIFIER})*`,
  'gu'
);
const CALLEE_RE = new RegExp(
  `(${IDENTIFIER}(?:\\s*\\??\\.\\s*${IDENTIFIER})*)\\s*$`,
  'u'
);
const IDENTIFIER_END_RE = /^[\p{ID_Continue}$‌‍]*/u;

const MDN_URL =
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/';

// The built-in objects of JavaScript, with a page on MDN
const BUILTINS = [
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'Atomics',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Function',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'RangeError',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Set',
  'SharedArrayBuffer',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'eval',
  'globalThis',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'unescape'
];

// The Jupyter protocol counts cursor positions in unicode code points, while
// JavaScript strings are indexed by UTF-16 code units.
function toUtf16Index(text: string, cursor: number): number {
  let index = 0;
  for (let count = 0; count < cursor && index < text.length; count++) {
    const code = text.charCodeAt(index);
    index +=
      code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
  }
  return index;
}

function toCodePointIndex(text: string, index: number): number {
  let count = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      i++;
    }
    count++;
  }
  return count;
}

type PropertyTypes = Map<string, string> & { depths: Map<string, number> };

function valueType(value: unknown): string {
  if (typeof value === 'function') {
    return isClass(value) ? 'class' : 'function';
  }
  if (value !== null && typeof value === 'object') {
    return isModuleNamespace(value) ? 'module' : 'instance';
  }
  return 'property';
}

// The properties of an object and of its prototypes, with their types and
// the depth of the prototype defining them. Getters are not called.
function propertyTypes(object: unknown): PropertyTypes {
  const names = new Map<string, string>() as PropertyTypes;
  names.depths = new Map();
  if (object === null || object === undefined) {
    return names;
  }
  let current: any =
    typeof object === 'object' || typeof object === 'function'
      ? object
      : Object(object);
  for (let depth = 0; current !== null && depth < 100; depth++) {
    const keys: string[] = safe(() => Object.getOwnPropertyNames(current), []);
    for (const key of keys) {
      if (names.has(key) || !IDENTIFIER_RE.test(key)) {
        continue;
      }
      const descriptor = safe(() =>
        Object.getOwnPropertyDescriptor(current, key)
      );
      names.set(
        key,
        descriptor && hasOwn(descriptor, 'value')
          ? valueType(descriptor.value)
          : 'property'
      );
      names.depths.set(key, depth);
    }
    current = safe(() => Object.getPrototypeOf(current), null);
  }
  return names;
}

// The own properties come first, then the ones of the prototypes, like the
// methods of a class before the ones of Object.
function sortNames(names: string[], depths: Map<string, number>): string[] {
  const rank = (name: string) =>
    name.startsWith('__') ? 2 : name.startsWith('_') ? 1 : 0;
  const depth = (name: string) => depths.get(name) ?? 0;
  return names.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      depth(a) - depth(b) ||
      a.localeCompare(b, 'en', { sensitivity: 'base' }) ||
      (a < b ? -1 : 1)
  );
}

function filterNames(types: PropertyTypes, prefix: string): string[] {
  let names = Array.from(types.keys()).filter(name => name.startsWith(prefix));
  if (names.length === 0) {
    const lower = prefix.toLowerCase();
    names = Array.from(types.keys()).filter(name =>
      name.toLowerCase().startsWith(lower)
    );
  }
  if (!prefix.startsWith('_')) {
    names = names.filter(name => !name.startsWith('__'));
  }
  return sortNames(names, types.depths);
}

function isInStringOrComment(text: string): boolean {
  // A rough scan, enough to avoid completing inside strings and comments
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') {
        i++;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end < 0) {
        return true;
      }
      i = end;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) {
        return true;
      }
      i = end + 1;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    }
  }
  return quote !== null;
}

/**
 * Find the expression to inspect at the cursor: the dotted name under the
 * cursor, or the function called by the innermost unclosed parenthesis.
 */
export function expressionAt(code: string, cursor: number): string | null {
  for (const match of code.matchAll(CHAIN_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start <= cursor && cursor <= end) {
      // Stop at the end of the identifier under the cursor
      const rest = code.slice(cursor, end);
      const identifierEnd =
        cursor + (IDENTIFIER_END_RE.exec(rest)?.[0].length ?? 0);
      const expression = code.slice(start, identifierEnd).replace(/\s+/g, '');
      if (/\.\s*$/.test(code.slice(0, start)) || KEYWORD_SET.has(expression)) {
        break;
      }
      return expression;
    }
    if (start > cursor) {
      break;
    }
  }
  let depth = 0;
  for (let i = cursor - 1; i >= 0; i--) {
    const char = code[i];
    if (char === ')') {
      depth++;
    } else if (char === '(') {
      if (depth === 0) {
        const match = CALLEE_RE.exec(code.slice(0, i));
        if (match && !KEYWORD_SET.has(match[1])) {
          return match[1].replace(/\s+/g, '');
        }
        return null;
      }
      depth--;
    }
  }
  return null;
}

function parseExpression(source: string): any {
  return safe(
    () => parse(source, { ecmaVersion: 'latest', sourceType: 'script' }) as any,
    null
  );
}

function parameters(source: string, node: any): string {
  if (!node || !node.params) {
    return '';
  }
  return node.params
    .map((param: any) => source.slice(param.start, param.end))
    .join(', ');
}

/**
 * The signature of a function, from its source code.
 */
export function signature(name: string, fn: unknown): string {
  const source = safe(() => Function.prototype.toString.call(fn), '');
  if (/\{\s*\[native code\]\s*\}$/.test(source)) {
    return `${name}(${(fn as any).length > 0 ? '…' : ''})`;
  }
  if (isClass(fn)) {
    const wrapped = `(${source})`;
    const ast = parseExpression(wrapped);
    const body = ast?.body[0].expression.body.body;
    const constructor = body?.find(
      (member: any) => member.kind === 'constructor'
    );
    return `new ${name}(${constructor ? parameters(wrapped, constructor.value) : ''})`;
  }
  for (const wrapped of [`(${source})`, `({${source}})`]) {
    const ast = parseExpression(wrapped);
    if (!ast) {
      continue;
    }
    let node = ast.body[0].expression;
    if (node.type === 'ObjectExpression') {
      node = node.properties[0]?.value;
    }
    if (node) {
      const prefix = (node.async ? 'async ' : '') + (node.generator ? '*' : '');
      return `${prefix}${name}(${parameters(wrapped, node)})`;
    }
  }
  return `${name}(…)`;
}

/**
 * Whether two names differ by at most 2 characters.
 */
function isSimilar(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) {
    return false;
  }
  let differences = 0;
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i++) {
    if (a[i] !== b[i]) {
      differences++;
      if (differences > 2) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Options of the introspection of a runtime.
 */
export interface IIntrospectionOptions {
  /**
   * The global scope of the runtime.
   */
  globalScope: Record<string, any>;

  /**
   * Evaluate an expression in the global scope.
   */
  evaluate: (expression: string) => unknown;

  /**
   * Some documentation for a built-in name, shown when it has no other
   * documentation.
   */
  builtinDocumentation?: (expression: string) => string | null;

  /**
   * The source code of a function, as written by the user. Defaults to
   * Function.prototype.toString.
   */
  functionSource?: (fn: unknown) => string;
}

/**
 * Code completion and inspection of the values of a runtime.
 */
export class Introspection {
  constructor(options: IIntrospectionOptions) {
    this._globalScope = options.globalScope;
    this._evaluate = options.evaluate;
    this._builtinDocumentation = options.builtinDocumentation;
    this._functionSource = options.functionSource;
  }

  /**
   * Document a global of the kernel which may not be a function, like `_`:
   * `doc` is called when the name is inspected and returns the documentation,
   * or undefined to fall back to the documentation of the value. null
   * removes it. The documented globals are not suggested for undefined names.
   */
  setGlobalDoc(name: string, doc: (() => string | undefined) | null): void {
    if (doc) {
      this._globalDocs.set(name, doc);
    } else {
      this._globalDocs.delete(name);
    }
  }

  /**
   * Register the documentation of the declarations of a cell, after it ran.
   */
  registerDocs(docs: IDeclarationDoc[]): void {
    for (const { name, doc } of docs) {
      const value = safe(() => this._evaluate(name));
      if (
        value !== null &&
        (typeof value === 'object' || typeof value === 'function')
      ) {
        docStore.set(value as object, doc);
      }
    }
  }

  /**
   * Complete the code at the cursor, a position in code points.
   */
  complete(code: string, cursorPosition: number): ICompletionReply {
    const cursor = toUtf16Index(code, cursorPosition);
    const before = code.slice(0, cursor);
    const empty: ICompletionReply = {
      matches: [],
      cursor_start: cursorPosition,
      cursor_end: cursorPosition,
      metadata: {}
    };

    let match = STRING_MEMBER_RE.exec(before);
    if (match) {
      return this._reply(code, cursor, match[1] || '', propertyTypes(''));
    }
    if (isInStringOrComment(before) || CALL_MEMBER_RE.test(before)) {
      // The result of a call is not evaluated
      return empty;
    }
    match = MEMBER_RE.exec(before);
    if (match) {
      if (/\.\s*$/.test(before.slice(0, match.index))) {
        return empty;
      }
      const expression = match[1];
      const object = safe(() => this._evaluate(expression));
      return this._reply(code, cursor, match[2] || '', propertyTypes(object));
    }
    match = ARRAY_MEMBER_RE.exec(before);
    if (match) {
      return this._reply(code, cursor, match[1] || '', propertyTypes([]));
    }
    match = NAME_RE.exec(before);
    const prefix = match ? match[1] : '';
    if (!prefix && /[\p{ID_Continue}$]$/u.test(before)) {
      return empty;
    }
    const types = propertyTypes(this._globalScope);
    for (const keyword of KEYWORDS) {
      if (!types.has(keyword)) {
        types.set(keyword, 'keyword');
        types.depths.set(keyword, 0);
      }
    }
    return this._reply(code, cursor, prefix, types);
  }

  /**
   * Inspect the expression at the cursor, a position in code points.
   */
  inspect(
    code: string,
    cursorPosition: number,
    detailLevel = 0
  ): IInspectionReply {
    const notFound: IInspectionReply = { found: false, data: {}, metadata: {} };
    const cursor = toUtf16Index(code, cursorPosition);
    const expression = expressionAt(code, cursor);
    if (!expression) {
      return notFound;
    }
    let value: unknown;
    try {
      value = this._evaluate(expression);
    } catch {
      const suggestions = this._similarNames(expression);
      if (suggestions.length === 0) {
        return notFound;
      }
      return {
        found: true,
        data: {
          'text/plain': `'${expression}' is not defined. Did you mean: ${suggestions.join(', ')}?`
        },
        metadata: {}
      };
    }
    return {
      found: true,
      data: { 'text/plain': this._describe(expression, value, detailLevel) },
      metadata: {}
    };
  }

  private _reply(
    code: string,
    cursor: number,
    prefix: string,
    types: PropertyTypes
  ): ICompletionReply {
    const matches = filterNames(types, prefix);
    const start = toCodePointIndex(code, cursor - prefix.length);
    const end = toCodePointIndex(code, cursor);
    return {
      matches,
      cursor_start: start,
      cursor_end: end,
      metadata: {
        _jupyter_types_experimental: matches.map(text => ({
          start,
          end,
          text,
          type: types.get(text)
        }))
      }
    };
  }

  private _describe(
    expression: string,
    value: unknown,
    detailLevel: number
  ): string {
    const label = (text: string) => color('red', text.padEnd(11));
    const indent = (text: string) =>
      text.split('\n').join('\n' + ' '.repeat(11));
    const lines: string[] = [];
    const globalDoc = this._globalDocs.get(expression);
    const doc =
      safe(() => globalDoc?.()) ??
      getDoc(value) ??
      this._builtinDocumentation?.(expression) ??
      undefined;
    const page = this._mdnPage(value);

    if (typeof value === 'function') {
      const source = safe(() => Function.prototype.toString.call(value), '');
      const isNative = /\{\s*\[native code\]\s*\}$/.test(source);
      const isKernelApi = kernelApi.has(value);
      if (!isKernelApi) {
        lines.push(`${label('Signature:')}${signature(expression, value)}`);
      }
      if (doc) {
        lines.push(`${label('Docstring:')}${indent(doc)}`);
      }
      lines.push(
        `${label('Type:')}${isClass(value) ? 'class' : getConstructorName(value) || 'Function'}`
      );
      if (
        !isNative &&
        !isKernelApi &&
        (detailLevel > 0 || source.split('\n').length <= 30)
      ) {
        lines.push(label('Source:'));
        lines.push(
          this._functionSource
            ? safe(() => this._functionSource!(value), source)
            : source
        );
      }
    } else {
      const type =
        value === null
          ? 'null'
          : typeof value === 'object'
            ? getConstructorName(value) || 'Object'
            : typeof value;
      lines.push(`${label('Type:')}${type}`);
      const text = inspect(value, {
        colors: true,
        depth: detailLevel > 0 ? 4 : 2
      });
      lines.push(`${label('Value:')}${indent(text)}`);
      if (typeof value === 'string' || Array.isArray(value)) {
        lines.push(`${label('Length:')}${value.length}`);
      } else if (isMap(value) || isSet(value)) {
        lines.push(`${label('Size:')}${value.size}`);
      }
      if (doc) {
        lines.push(`${label('Docstring:')}${indent(doc)}`);
      }
    }
    if (page) {
      lines.push(`${label('Docs:')}${page}`);
    }
    return lines.join('\n');
  }

  /**
   * The MDN page of a built-in value of the runtime.
   */
  private _mdnPage(value: unknown): string | null {
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function')
    ) {
      return null;
    }
    const pages = this._mdnPages();
    if (pages.has(value as object)) {
      return MDN_URL + pages.get(value as object);
    }
    if (typeof value === 'object') {
      const constructor = safe(() => Object.getPrototypeOf(value).constructor);
      if (
        constructor &&
        pages.has(constructor) &&
        constructor !== this._globalScope.Object
      ) {
        return MDN_URL + pages.get(constructor);
      }
    }
    return null;
  }

  // Maps the built-in objects of the runtime and their methods to their page
  private _mdnPages(): WeakMap<object, string> {
    if (this._pages) {
      return this._pages;
    }
    const pages = new WeakMap<object, string>();
    const register = (object: any, page: string) => {
      for (const key of safe(() => Object.getOwnPropertyNames(object), [])) {
        if (key === 'constructor' || key === 'prototype') {
          continue;
        }
        const descriptor = safe(() =>
          Object.getOwnPropertyDescriptor(object, key)
        );
        if (
          descriptor &&
          typeof descriptor.value === 'function' &&
          !pages.has(descriptor.value)
        ) {
          pages.set(descriptor.value, `${page}/${key}`);
        }
      }
    };
    for (const name of BUILTINS) {
      const value = safe(() => this._globalScope[name]);
      if (
        value === undefined ||
        value === null ||
        (typeof value !== 'object' && typeof value !== 'function') ||
        pages.has(value)
      ) {
        continue;
      }
      pages.set(value, name);
      if (name !== 'globalThis') {
        register(value, name);
        if (typeof value === 'function' && value.prototype) {
          register(value.prototype, name);
        }
      }
    }
    const int8Array = safe(() => this._globalScope.Int8Array);
    if (int8Array) {
      const typedArray = Object.getPrototypeOf(int8Array);
      pages.set(typedArray, 'TypedArray');
      register(typedArray, 'TypedArray');
      register(typedArray.prototype, 'TypedArray');
    }
    this._pages = pages;
    return pages;
  }

  /**
   * The names of the properties of an object, the global scope by default,
   * close to a name, like a typo of it: the closest first, at most three,
   * for the `Did you mean` hints of the errors. The documented globals of
   * the kernel, like `_`, and its helpers are not suggested.
   */
  closeNames(name: string, object: unknown = this._globalScope): string[] {
    let names: Iterable<string> = propertyTypes(object).keys();
    if (object === this._globalScope) {
      names = Array.from(names).filter(
        candidate =>
          !this._globalDocs.has(candidate) &&
          !candidate.startsWith(KERNEL_NAME_PREFIX)
      );
    }
    return closestNames(name, names);
  }

  private _similarNames(expression: string): string[] {
    const lower = expression.toLowerCase();
    const suggestions: string[] = [];
    for (const name of propertyTypes(this._globalScope).keys()) {
      // The documented globals of the kernel, like `_`, are not suggested:
      // most names would match them.
      if (this._globalDocs.has(name)) {
        continue;
      }
      const candidate = name.toLowerCase();
      if (
        candidate !== lower &&
        (candidate.includes(lower) ||
          lower.includes(candidate) ||
          isSimilar(lower, candidate))
      ) {
        suggestions.push(name);
        if (suggestions.length >= 5) {
          break;
        }
      }
    }
    return suggestions;
  }

  private _globalScope: Record<string, any>;
  private _evaluate: (expression: string) => unknown;
  private _builtinDocumentation?: (expression: string) => string | null;
  private _functionSource?: (fn: unknown) => string;
  private _globalDocs = new Map<string, () => string | undefined>();
  private _pages: WeakMap<object, string> | null = null;
}
