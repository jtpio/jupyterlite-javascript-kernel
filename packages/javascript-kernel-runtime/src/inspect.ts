// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Formats values like util.inspect in Node.js. The console and the plain text
// outputs of the cells use it.
//
// The values can come from another realm (the iframe of the kernel), so the
// types are checked with the internal slots of the values (for instance with
// the getter of Map.prototype.size) rather than with instanceof.

import { color, hasOwn, safe, stripAnsi } from './utils';

/**
 * Options of inspect.
 */
export interface IInspectOptions {
  /**
   * The depth of the nested objects to show, Infinity or null for all.
   */
  depth?: number | null;

  /**
   * Whether to color the output with ANSI escape codes.
   */
  colors?: boolean;

  /**
   * The length of a line before the entries are split on several lines.
   */
  breakLength?: number;

  /**
   * The maximum number of items of arrays, maps and sets to show.
   */
  maxArrayLength?: number;

  /**
   * The maximum number of characters of strings to show.
   */
  maxStringLength?: number;

  /**
   * Format the lines after `Name: message` of an error: its frames, its
   * cause and its aggregated errors. Returns null to show the stack of the
   * error as is. The kernel uses it to show the locations in the cells.
   */
  formatStack?: (error: unknown, colors: boolean) => string[] | null;
}

/**
 * The state of a promise: 0 for pending, 1 for fulfilled, 2 for rejected,
 * with its value or its reason.
 */
export type PromiseState = [number, unknown];

/**
 * A function returning the state of a promise, when the JavaScript engine
 * can tell it.
 */
export type PromiseStateResolver = (promise: unknown) => PromiseState | null;

let promiseStateResolver: PromiseStateResolver | null = null;

/**
 * Set the function returning the state of a promise. Browsers can not tell
 * it, so the promises are shown without their state by default.
 */
export function setPromiseStateResolver(
  resolver: PromiseStateResolver | null
): void {
  promiseStateResolver = resolver;
}

/**
 * The symbol of the custom inspection functions of Node.js.
 */
export const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

const STYLES: Record<string, string> = {
  number: 'yellow',
  bigint: 'yellow',
  boolean: 'yellow',
  undefined: 'gray',
  null: 'bold',
  string: 'green',
  symbol: 'green',
  date: 'magenta',
  regexp: 'red',
  special: 'cyan',
  module: 'underline'
};

const DEFAULTS = {
  depth: 2,
  colors: false,
  breakLength: 80,
  maxArrayLength: 100,
  maxStringLength: 10000
};

interface IContext {
  depth: number;
  colors: boolean;
  breakLength: number;
  maxArrayLength: number;
  maxStringLength: number;
  formatStack?: (error: unknown, colors: boolean) => string[] | null;
  seen: unknown[];
  indentation: number;
}

const IDENTIFIER = String.raw`[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*`;
const IDENTIFIER_RE = new RegExp(`^${IDENTIFIER}$`, 'u');

/**
 * Format a value like util.inspect in Node.js.
 */
export function inspect(value: unknown, options: IInspectOptions = {}): string {
  const depth =
    options.depth === null ? Infinity : (options.depth ?? DEFAULTS.depth);
  const ctx: IContext = {
    ...DEFAULTS,
    ...options,
    depth,
    seen: [],
    indentation: 0
  };
  return formatValue(ctx, value, 0);
}

function stylize(ctx: IContext, text: string, style: string): string {
  return ctx.colors && STYLES[style] ? color(STYLES[style], text) : text;
}

const STRING_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\t': '\\t',
  '\r': '\\r',
  '\b': '\\b',
  '\f': '\\f',
  '\v': '\\v',
  '\\': '\\\\'
};

/**
 * Quote a string like Node.js does, with single quotes when possible.
 */
export function quoteString(text: string): string {
  let quote = "'";
  if (text.includes("'")) {
    if (!text.includes('"')) {
      quote = '"';
    } else if (!text.includes('`') && !text.includes('${')) {
      quote = '`';
    }
  }
  let result = '';
  for (const char of text) {
    if (char === quote) {
      result += '\\' + char;
    } else if (STRING_ESCAPES[char]) {
      result += STRING_ESCAPES[char];
    } else if (char < ' ' || char === '\x7f') {
      result += '\\x' + char.charCodeAt(0).toString(16).padStart(2, '0');
    } else {
      result += char;
    }
  }
  return quote + result + quote;
}

/**
 * Format a primitive value.
 */
export function formatPrimitive(
  value: unknown,
  options: { colors?: boolean; maxStringLength?: number } = {}
): string {
  const ctx = { ...DEFAULTS, ...options, seen: [], indentation: 0 };
  return formatPrimitiveValue(ctx as IContext, value);
}

function formatPrimitiveValue(ctx: IContext, value: unknown): string {
  switch (typeof value) {
    case 'string': {
      let text = value;
      let trailer = '';
      if (text.length > ctx.maxStringLength) {
        trailer = `... ${text.length - ctx.maxStringLength} more characters`;
        text = text.slice(0, ctx.maxStringLength);
      }
      return stylize(ctx, quoteString(text), 'string') + trailer;
    }
    case 'number':
      return stylize(
        ctx,
        Object.is(value, -0) ? '-0' : String(value),
        'number'
      );
    case 'bigint':
      return stylize(ctx, `${value}n`, 'bigint');
    case 'boolean':
      return stylize(ctx, String(value), 'boolean');
    case 'undefined':
      return stylize(ctx, 'undefined', 'undefined');
    case 'symbol':
      return stylize(ctx, value.toString(), 'symbol');
  }
  return String(value);
}

function formatValue(ctx: IContext, value: any, level: number): string {
  if (value === null) {
    return stylize(ctx, 'null', 'null');
  }
  if (typeof value !== 'object' && typeof value !== 'function') {
    return formatPrimitiveValue(ctx, value);
  }
  const custom = safe(() => value[customInspectSymbol]);
  if (typeof custom === 'function') {
    const options = {
      ...ctx,
      depth: ctx.depth - level,
      stylize: (text: string, style: string) => stylize(ctx, text, style)
    };
    const result = custom.call(value, ctx.depth - level, options, inspect);
    if (result !== value) {
      return typeof result === 'string'
        ? result
        : formatValue(ctx, result, level);
    }
  }
  if (ctx.seen.includes(value)) {
    return stylize(ctx, '[Circular]', 'special');
  }
  return formatObject(ctx, value, level);
}

/**
 * The name of the constructor of an object, or null for objects without
 * prototype.
 */
export function getConstructorName(object: unknown): string | null {
  let current: any = object;
  for (let i = 0; current !== null && current !== undefined && i < 100; i++) {
    const descriptor = safe(() =>
      Object.getOwnPropertyDescriptor(current, 'constructor')
    );
    if (
      descriptor &&
      typeof descriptor.value === 'function' &&
      descriptor.value.name !== ''
    ) {
      return descriptor.value.name;
    }
    current = safe(() => Object.getPrototypeOf(current), null);
  }
  return null;
}

function getPrefix(
  constructorName: string | null,
  tag: string,
  fallback: string,
  size = ''
): string {
  if (constructorName === null) {
    return tag && tag !== fallback
      ? `[${fallback}${size}: null prototype] [${tag}] `
      : `[${fallback}${size}: null prototype] `;
  }
  if (tag && constructorName !== tag) {
    return `${constructorName}${size} [${tag}] `;
  }
  return `${constructorName}${size} `;
}

/**
 * Whether a function is a class.
 */
export function isClass(fn: unknown): boolean {
  const source = safe(() => Function.prototype.toString.call(fn), '');
  return /^class\b/.test(source);
}

function functionBase(
  fn: any,
  constructorName: string | null,
  tag: string
): string {
  if (isClass(fn)) {
    let base = `[class ${fn.name || '(anonymous)'}`;
    const superclass = safe(() => Object.getPrototypeOf(fn));
    if (typeof superclass === 'function' && superclass.name) {
      base += ` extends ${superclass.name}`;
    }
    return base + ']';
  }
  let type = 'Function';
  if (
    ['AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction'].includes(
      constructorName ?? ''
    )
  ) {
    type = constructorName as string;
  }
  let base = `[${type}`;
  if (constructorName === null) {
    base += ' (null prototype)';
  }
  base += fn.name ? `: ${fn.name}` : ' (anonymous)';
  base += ']';
  if (
    constructorName !== type &&
    constructorName !== 'Function' &&
    constructorName !== null
  ) {
    base += ` ${constructorName}`;
  }
  if (tag && constructorName !== tag) {
    base += ` [${tag}]`;
  }
  return base;
}

function formatErrorValue(ctx: IContext, error: any, level: number): string {
  const name = safe(() => String(error.name), 'Error');
  const message = safe(() => String(error.message), '');
  const head = message ? `${name}: ${message}` : name;
  if (level > 0) {
    return `[${head}]`;
  }
  const lines = ctx.formatStack
    ? safe(() => ctx.formatStack!(error, ctx.colors), null)
    : null;
  if (lines) {
    return [head, ...lines].join('\n');
  }
  const stack = safe(() => error.stack, '');
  if (typeof stack !== 'string' || stack === '') {
    return head;
  }
  // V8 starts the stack with the message, other engines only list the frames
  return stack.startsWith(head)
    ? stack.trimEnd()
    : `${head}\n${stack.trimEnd()}`;
}

function formatKey(ctx: IContext, key: string | symbol): string {
  if (typeof key === 'symbol') {
    return `[${stylize(ctx, key.toString(), 'symbol')}]`;
  }
  if (IDENTIFIER_RE.test(key)) {
    return key;
  }
  return stylize(ctx, quoteString(key), 'string');
}

function formatNested(ctx: IContext, value: unknown, level: number): string {
  ctx.indentation += 2;
  const result = formatValue(ctx, value, level + 1);
  ctx.indentation -= 2;
  return result;
}

function formatProperty(
  ctx: IContext,
  object: any,
  level: number,
  key: string | symbol
): string {
  const descriptor: PropertyDescriptor = safe(() =>
    Object.getOwnPropertyDescriptor(object, key)
  ) || { value: safe(() => object[key]) };
  let text;
  if (hasOwn(descriptor, 'value')) {
    text = formatNested(ctx, descriptor.value, level);
  } else if (descriptor.get) {
    text = stylize(
      ctx,
      descriptor.set ? '[Getter/Setter]' : '[Getter]',
      'special'
    );
  } else if (descriptor.set) {
    text = stylize(ctx, '[Setter]', 'special');
  } else {
    text = stylize(ctx, 'undefined', 'undefined');
  }
  return `${formatKey(ctx, key)}: ${text}`;
}

function formatArrayLike(
  ctx: IContext,
  value: any,
  level: number,
  length: number,
  getItem: ((index: number) => unknown) | null
): string[] {
  const output: string[] = [];
  const max = Math.min(ctx.maxArrayLength, length);
  let i = 0;
  while (i < length && output.length < max) {
    if (getItem === null && !hasOwn(value, i)) {
      let j = i;
      while (j < length && !hasOwn(value, j)) {
        j++;
      }
      const holes = j - i;
      output.push(
        stylize(
          ctx,
          `<${holes} empty item${holes > 1 ? 's' : ''}>`,
          'undefined'
        )
      );
      i = j;
      continue;
    }
    output.push(
      formatNested(ctx, getItem === null ? value[i] : getItem(i), level)
    );
    i++;
  }
  if (i < length) {
    const remaining = length - i;
    output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
  }
  return output;
}

const typedArrayPrototype = Object.getPrototypeOf(Int8Array.prototype);
const typedArrayLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'length'
)!.get!;
const typedArrayTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag
)!.get!;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
)!.get!;
const regExpSource = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  'source'
)!.get!;

const isTypedArray = (value: unknown): boolean =>
  safe(() => typedArrayTag.call(value) !== undefined, false);

/**
 * Whether a value is a Map, from any realm.
 */
export const isMap = (value: unknown): value is Map<unknown, unknown> =>
  safe(() => (mapSize.call(value), true), false);

/**
 * Whether a value is a Set, from any realm.
 */
export const isSet = (value: unknown): value is Set<unknown> =>
  safe(() => (setSize.call(value), true), false);

/**
 * Whether a value is a Date, from any realm.
 */
export const isDate = (value: unknown): value is Date =>
  safe(() => (Date.prototype.getTime.call(value), true), false);

/**
 * Whether a value is a RegExp, from any realm.
 */
export const isRegExp = (value: unknown): value is RegExp =>
  safe(() => (regExpSource.call(value), true), false);

/**
 * Whether a value is an Error, from any realm.
 */
export const isError = (value: unknown): value is Error =>
  value instanceof Error ||
  safe(() => Object.prototype.toString.call(value) === '[object Error]', false);

const isArrayBuffer = (value: unknown): boolean =>
  safe(() => (arrayBufferByteLength.call(value), true), false);
const isPromise = (value: unknown): boolean =>
  safe(
    () => Object.prototype.toString.call(value) === '[object Promise]',
    false
  );
const isWeakCollection = (value: unknown): boolean =>
  safe(
    () =>
      ['[object WeakMap]', '[object WeakSet]'].includes(
        Object.prototype.toString.call(value)
      ),
    false
  );

/**
 * Whether a value is the namespace of an ES module.
 */
export const isModuleNamespace = (value: any): boolean =>
  safe(
    () =>
      value[Symbol.toStringTag] === 'Module' &&
      Object.getPrototypeOf(value) === null,
    false
  );

const isBoxedPrimitive = (value: unknown): boolean =>
  safe(
    () =>
      [
        '[object Number]',
        '[object String]',
        '[object Boolean]',
        '[object BigInt]',
        '[object Symbol]'
      ].includes(Object.prototype.toString.call(value)),
    false
  );

function formatObject(ctx: IContext, value: any, level: number): string {
  const constructorName = getConstructorName(value);
  let tag = safe(() => value[Symbol.toStringTag], '');
  if (typeof tag !== 'string' || tag === constructorName) {
    tag = '';
  }

  let keys: string[] = safe(() => Object.keys(value), []);
  const symbols = safe(() => Object.getOwnPropertySymbols(value), []).filter(
    symbol =>
      safe(
        () => Object.prototype.propertyIsEnumerable.call(value, symbol),
        false
      )
  );

  let base = '';
  let braces = ['{', '}'];
  let isArrayLike = false;
  let formatter: () => string[] = () => [];

  if (Array.isArray(value)) {
    isArrayLike = true;
    const prefix =
      constructorName !== 'Array' || tag
        ? getPrefix(constructorName, tag, 'Array', `(${value.length})`)
        : '';
    braces = [`${prefix}[`, ']'];
    keys = keys.filter(
      key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length
    );
    formatter = () => formatArrayLike(ctx, value, level, value.length, null);
  } else if (typeof value === 'function') {
    base = functionBase(value, constructorName, tag);
    keys = keys.filter(key => key !== 'prototype');
    if (keys.length === 0 && symbols.length === 0) {
      return stylize(ctx, base, 'special');
    }
  } else if (isTypedArray(value)) {
    isArrayLike = true;
    const length = typedArrayLength.call(value);
    const name = constructorName || typedArrayTag.call(value);
    braces = [
      `${getPrefix(name, tag === name ? '' : tag, typedArrayTag.call(value), `(${length})`)}[`,
      ']'
    ];
    keys = keys.filter(key => !/^(0|[1-9][0-9]*)$/.test(key));
    formatter = () => formatArrayLike(ctx, value, level, length, i => value[i]);
  } else if (isMap(value)) {
    braces = [
      `${getPrefix(constructorName, tag, 'Map', `(${mapSize.call(value)})`)}{`,
      '}'
    ];
    formatter = () => {
      const output: string[] = [];
      for (const [key, item] of Map.prototype.entries.call(value)) {
        if (output.length >= ctx.maxArrayLength) {
          output.push(`... ${mapSize.call(value) - output.length} more items`);
          break;
        }
        output.push(
          `${formatNested(ctx, key, level)} => ${formatNested(ctx, item, level)}`
        );
      }
      return output;
    };
  } else if (isSet(value)) {
    braces = [
      `${getPrefix(constructorName, tag, 'Set', `(${setSize.call(value)})`)}{`,
      '}'
    ];
    isArrayLike = true;
    formatter = () => {
      const output: string[] = [];
      for (const item of Set.prototype.values.call(value)) {
        if (output.length >= ctx.maxArrayLength) {
          output.push(`... ${setSize.call(value) - output.length} more items`);
          break;
        }
        output.push(formatNested(ctx, item, level));
      }
      return output;
    };
  } else if (isError(value)) {
    base = formatErrorValue(ctx, value, level);
    keys = keys.filter(key => key !== 'stack' && key !== 'message');
    if (keys.length === 0 && symbols.length === 0) {
      return base;
    }
  } else if (isRegExp(value)) {
    base = stylize(ctx, RegExp.prototype.toString.call(value), 'regexp');
    if (keys.length === 0 && symbols.length === 0) {
      return base;
    }
  } else if (isDate(value)) {
    const time = Date.prototype.getTime.call(value);
    base = stylize(
      ctx,
      Number.isNaN(time)
        ? 'Invalid Date'
        : Date.prototype.toISOString.call(value),
      'date'
    );
    if (keys.length === 0 && symbols.length === 0) {
      return base;
    }
  } else if (isPromise(value)) {
    braces = [`${getPrefix(constructorName, tag, 'Promise')}{`, '}'];
    formatter = () => {
      const state = promiseStateResolver?.(value);
      if (!state) {
        return [];
      }
      if (state[0] === 0) {
        return [stylize(ctx, '<pending>', 'special')];
      }
      const text = formatNested(ctx, state[1], level);
      return [
        state[0] === 2
          ? `${stylize(ctx, '<rejected>', 'special')} ${text}`
          : text
      ];
    };
  } else if (isArrayBuffer(value)) {
    braces = [`${getPrefix(constructorName, tag, 'ArrayBuffer')}{`, '}'];
    formatter = () => {
      const bytes = new Uint8Array(value);
      const shown = Array.from(bytes.slice(0, 50), byte =>
        byte.toString(16).padStart(2, '0')
      ).join(' ');
      const more =
        bytes.length > 50 ? ` ... ${bytes.length - 50} more bytes` : '';
      return [
        `[Uint8Contents]: <${shown}${more}>`,
        `byteLength: ${formatPrimitiveValue(ctx, bytes.length)}`
      ];
    };
  } else if (isWeakCollection(value)) {
    braces = [`${getPrefix(constructorName, tag, 'Object')}{`, '}'];
    formatter = () => [stylize(ctx, '<items unknown>', 'special')];
  } else if (isModuleNamespace(value)) {
    braces = ['[Module: null prototype] {', '}'];
    keys = safe(() => Object.getOwnPropertyNames(value), []);
    formatter = () => [];
  } else if (isBoxedPrimitive(value)) {
    const primitive = value.valueOf();
    const type =
      typeof primitive === 'bigint'
        ? 'BigInt'
        : (typeof primitive).replace(/^./, c => c.toUpperCase());
    base = `[${type}: ${formatPrimitiveValue({ ...ctx }, primitive)}]`;
    if (typeof primitive === 'string') {
      keys = keys.filter(key => !/^(0|[1-9][0-9]*)$/.test(key));
    }
    if (keys.length === 0 && symbols.length === 0) {
      return base;
    }
  } else if (constructorName !== 'Object' || tag) {
    braces = [`${getPrefix(constructorName, tag, 'Object')}{`, '}'];
  }

  if (level > ctx.depth) {
    const name = Array.isArray(value)
      ? 'Array'
      : constructorName || tag || 'Object';
    return stylize(ctx, `[${name}]`, 'special');
  }

  ctx.seen.push(value);
  let output: string[];
  try {
    output = formatter();
    for (const key of keys) {
      output.push(formatProperty(ctx, value, level, key));
    }
    for (const symbol of symbols) {
      output.push(formatProperty(ctx, value, level, symbol));
    }
  } finally {
    ctx.seen.pop();
  }
  return reduceToSingleString(ctx, output, base, braces, isArrayLike, value);
}

// Puts the short entries of long arrays on several columns.
function groupArrayElements(
  ctx: IContext,
  output: string[],
  value: unknown
): string[] {
  let totalLength = 0;
  let maxLength = 0;
  let outputLength = output.length;
  if (outputLength > 0 && output[outputLength - 1].startsWith('... ')) {
    outputLength--;
  }
  const separatorSpace = 2;
  const lengths: number[] = [];
  for (let i = 0; i < outputLength; i++) {
    const length = stripAnsi(output[i]).length;
    lengths.push(length);
    totalLength += length + separatorSpace;
    maxLength = Math.max(maxLength, length);
  }
  const actualMax = maxLength + separatorSpace;
  if (
    actualMax * 3 + ctx.indentation < ctx.breakLength &&
    (totalLength / actualMax > 5 || maxLength <= 6)
  ) {
    const averageBias = Math.sqrt(actualMax - totalLength / output.length);
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    const columns = Math.min(
      Math.round(Math.sqrt(2.5 * biasedMax * outputLength) / biasedMax),
      Math.floor((ctx.breakLength - ctx.indentation) / actualMax),
      12,
      15
    );
    if (columns <= 1) {
      return output;
    }
    const maxLineLength: number[] = [];
    for (let i = 0; i < columns; i++) {
      let lineLength = 0;
      for (let j = i; j < outputLength; j += columns) {
        lineLength = Math.max(lineLength, lengths[j]);
      }
      maxLineLength.push(lineLength + separatorSpace);
    }
    const numeric =
      Array.isArray(value) &&
      value
        .slice(0, outputLength)
        .every(item => typeof item === 'number' || typeof item === 'bigint');
    const grouped: string[] = [];
    for (let i = 0; i < outputLength; i += columns) {
      const max = Math.min(i + columns, outputLength);
      let line = '';
      let j = i;
      for (; j < max - 1; j++) {
        const padding = maxLineLength[j - i] + output[j].length - lengths[j];
        line += numeric
          ? `${output[j]}, `.padStart(padding, ' ')
          : `${output[j]}, `.padEnd(padding, ' ');
      }
      if (numeric) {
        const padding =
          maxLineLength[j - i] + output[j].length - lengths[j] - separatorSpace;
        line += output[j].padStart(padding, ' ');
      } else {
        line += output[j];
      }
      grouped.push(line);
    }
    if (outputLength < output.length) {
      grouped.push(output[outputLength]);
    }
    return grouped;
  }
  return output;
}

function reduceToSingleString(
  ctx: IContext,
  output: string[],
  base: string,
  braces: string[],
  isArrayLike: boolean,
  value: unknown
): string {
  const prefix = base ? `${base} ` : '';
  if (output.length === 0) {
    return `${prefix}${braces[0]}${braces[1]}`;
  }
  const entries = output.length;
  if (isArrayLike && entries > 6) {
    output = groupArrayElements(ctx, output, value);
  }
  if (entries === output.length) {
    const start =
      output.length + ctx.indentation + braces[0].length + base.length + 10;
    let totalLength = start + output.length;
    const fits =
      totalLength <= ctx.breakLength &&
      output.every(entry => {
        totalLength += stripAnsi(entry).length;
        return totalLength <= ctx.breakLength;
      });
    if (fits && !base.includes('\n')) {
      const joined = output.join(', ');
      if (!joined.includes('\n')) {
        return `${prefix}${braces[0]} ${joined} ${braces[1]}`;
      }
    }
  }
  const indentation = `\n${' '.repeat(ctx.indentation)}`;
  return `${prefix}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
}
