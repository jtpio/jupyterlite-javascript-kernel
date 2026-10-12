// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import { Parser, type Comment } from 'acorn';
import { simple as walkSimple } from 'acorn-walk';
import { generate } from 'astring';

import type { IMimeBundle } from '@jupyterlab/nbformat';

import { normalizeBundle } from './display';
import { resolveUrl } from './env';
import {
  inspect,
  isDate,
  isError,
  isMap,
  isModuleNamespace,
  isRegExp,
  isSet
} from './inspect';
import {
  LOOP_GUARD_NAME,
  loopGuardCall,
  stripLoopGuardCalls,
  type LoopGuard,
  type LoopKind
} from './interrupt';
import { Introspection, type IDeclarationDoc } from './introspection';
import {
  SourceEdits,
  lineStarts,
  offsetToLineColumn,
  type PositionMap
} from './source_edits';
import {
  CellSyntaxError,
  calibrate,
  createCellSource,
  formatError,
  formatStackLines,
  type ICalibration,
  type ICellSource,
  type IErrorParts,
  type ITracebackContext
} from './traceback';
import { escapeHtml, safe, stripAnsi } from './utils';

/**
 * The source URL of the probe measuring how the engine reports the
 * positions of the cells.
 */
const PROBE_URL = '__jsKernelProbe__';

/**
 * The maximum number of cells kept to show their code in the tracebacks.
 */
const MAX_CELLS = 500;

/**
 * The name of the helper defining the globals declared by the cells over the
 * accessors of the global scope, like `name` in a window.
 */
const DEFINE_GLOBAL_NAME = '__jsKernelDefine__';

/**
 * The names of the parameters of the compiled cells, for the helpers the
 * kernel passes to them: the loop guard and the definition of the globals.
 */
const HELPER_PARAMETERS = [LOOP_GUARD_NAME, DEFINE_GLOBAL_NAME];

/**
 * The minimum number of frames of the stack traces: the frames of the kernel
 * take some, even if they are not shown.
 */
const STACK_TRACE_LIMIT = 50;

/**
 * The kinds of the loop statements, by node type.
 */
const LOOP_KINDS: Record<string, LoopKind> = {
  ForStatement: 'for',
  ForInStatement: 'for-in',
  ForOfStatement: 'for-of',
  WhileStatement: 'while',
  DoWhileStatement: 'do-while'
};

/**
 * The ECMAScript edition accepted by the kernel.
 *
 * The cells are parsed with the latest edition known to acorn, so this is
 * the latest edition of the installed acorn: `jlpm lint:check` verifies it,
 * bump it together with acorn. The browser decides which built-in APIs exist.
 */
export const ECMASCRIPT_EDITION = 2026;

/**
 * The options of acorn for the code of the cells.
 */
const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  allowAwaitOutsideFunction: true
} as const;

/**
 * The types of the import and export statements.
 */
const MODULE_STATEMENTS = [
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ExportAllDeclaration'
];

/**
 * The parser of the cells. The export lists of a cell can name the
 * declarations of the previous cells, which acorn would report as undefined.
 * A cell parsed as a script, with `allowImportExportEverywhere`, can use the
 * import and export statements at the top level only, like a module.
 */
const CellParser = Parser.extend(
  BaseParser =>
    class extends BaseParser {
      checkLocalExport(): void {
        // The names can be declared by another cell
      }

      parse(): any {
        const program = super.parse();
        const parser = this as any;
        if (parser.options.allowImportExportEverywhere) {
          const topLevel = new Set(program.body);
          walkSimple(
            program,
            Object.fromEntries(
              MODULE_STATEMENTS.map(type => [
                type,
                (node: any) => {
                  if (!topLevel.has(node)) {
                    parser.raise(
                      node.start,
                      "'import' and 'export' may only appear at the top level"
                    );
                  }
                }
              ])
            )
          );
        }
        return program;
      }
    }
);

/**
 * Parse the code of a cell, like a REPL does.
 *
 * A cell which is an object literal, like `{ a: 1, b: 2 }`, is parsed as an
 * expression, not as a block. The other cells are parsed as modules, so that
 * they can use the import and export declarations, or else as scripts, for
 * the names reserved in strict mode, like `package`, with the import and
 * export declarations allowed at the top level. The cells run in sloppy
 * mode either way, with top-level await. When the code is neither a module
 * nor a script, the error found the furthest in the code is thrown.
 */
function parseCode(code: string, comments?: Comment[]): any {
  const objectLiteral = parseObjectLiteral(code, comments);
  if (objectLiteral) {
    return objectLiteral;
  }
  let error: any = null;
  for (const sourceType of ['module', 'script'] as const) {
    // The comments of a failed parse are dropped
    const found: Comment[] = [];
    try {
      const ast = CellParser.parse(code, {
        ...PARSE_OPTIONS,
        sourceType,
        allowImportExportEverywhere: sourceType === 'script',
        onComment: found
      });
      comments?.push(...found);
      return ast;
    } catch (e: any) {
      if (error === null || (e?.pos ?? -1) > (error?.pos ?? -1)) {
        error = e;
      }
    }
  }
  throw error;
}

/**
 * Parse a cell which is an object literal, like `{ a: 1 }`, or an expression
 * starting with one, as a program with an expression statement. Returns null
 * for the other cells, which are parsed as blocks, like Node.js REPL does.
 */
function parseObjectLiteral(code: string, comments?: Comment[]): any | null {
  if (!/^\s*\{/.test(code) || !/\}\s*$/.test(code)) {
    return null;
  }
  const found: Comment[] = [];
  const expression = safe(
    () =>
      CellParser.parseExpressionAt(code, code.indexOf('{'), {
        ...PARSE_OPTIONS,
        sourceType: 'module',
        onComment: found
      }) as any,
    null
  );
  if (!expression || code.slice(expression.end).trim() !== '') {
    return null;
  }
  comments?.push(...found);
  return {
    type: 'Program',
    start: 0,
    end: code.length,
    sourceType: 'module',
    body: [
      {
        type: 'ExpressionStatement',
        start: expression.start,
        end: expression.end,
        expression
      }
    ]
  };
}

/**
 * The declaration of an export statement, like `const a = 1` for
 * `export const a = 1`, or null for the exports without a named declaration.
 * The other statements are returned as they are.
 */
function unwrapExport(node: any): any | null {
  if (
    node.type !== 'ExportNamedDeclaration' &&
    node.type !== 'ExportDefaultDeclaration' &&
    node.type !== 'ExportAllDeclaration'
  ) {
    return node;
  }
  const declaration = node.declaration;
  if (
    declaration?.type === 'VariableDeclaration' ||
    ((declaration?.type === 'FunctionDeclaration' ||
      declaration?.type === 'ClassDeclaration') &&
      declaration.id)
  ) {
    return declaration;
  }
  return null;
}

/**
 * The message of the error for a declaration of a global which can not be
 * replaced, like `location` in a window.
 */
function fixedGlobalMessage(name: string): string {
  return `'${name}' is a built-in global and cannot be redeclared in a cell; pick another name`;
}

/**
 * How a top-level declaration of a cell is kept in the global scope:
 * - `assign`: assigned, for the names without a global or with a writable
 *   one
 * - `setter`: declared in the cell, then assigned, for the event handlers
 *   like `onmessage`, so that their setter installs the handler
 * - `define`: declared in the cell, then defined as a writable property of
 *   the global scope, for the accessors like `name` or `status`, whose
 *   setter would convert or ignore the value
 * - `fixed`: a global which can not be replaced, like `location` or `top`
 *   in a window, which is a syntax error
 */
type GlobalKind = 'assign' | 'setter' | 'define' | 'fixed';

/**
 * The symbol of the method returning the MIME bundle of an object.
 */
const JUPYTER_DISPLAY = Symbol.for('Jupyter.display');

/**
 * The methods returning a representation of an object, with its MIME type.
 */
const REPR_METHODS: [string, string][] = [
  ['_toHtml', 'text/html'],
  ['_toMarkdown', 'text/markdown'],
  ['_toSvg', 'image/svg+xml'],
  ['_toPng', 'image/png'],
  ['_toJpeg', 'image/jpeg'],
  ['_toLatex', 'text/latex'],
  ['_toJson', 'application/json']
];

/**
 * What the kernel uses of a canvas element, without the DOM types.
 */
interface ICanvasLike {
  width: number;
  height: number;
  toDataURL(type?: string): string;
  outerHTML?: string;
}

/**
 * Configuration for magic imports: the import statements of bare package
 * names, like `import _ from 'lodash-es'`, load the package from a CDN.
 */
export interface IMagicImportsConfig {
  /**
   * Whether the bare package names are loaded from the CDN. Without it, the
   * import sources are left to the module loader of the engine.
   */
  enabled: boolean;

  /**
   * The base URL of the CDN, `https://cdn.jsdelivr.net/` by default.
   */
  baseUrl: string;

  /**
   * Whether `npm/` is added in front of the package names, like jsDelivr
   * serves them. The sources starting with `npm/` or `gh/` are kept as is.
   */
  enableAutoNpm: boolean;

  /**
   * Whether `/+esm` is added after the package paths, for jsDelivr to serve
   * them as ES modules, unless they end with `.js`, `.mjs`, `.cjs`, `.wasm`
   * or `+esm`. True by default.
   */
  appendEsmSuffix?: boolean;
}

/**
 * The options of an executor, as plain data, which can be sent to another
 * realm or thread, like the configuration of a kernel.
 */
export interface IExecutorOptions {
  /**
   * The configuration of the magic imports. The fields left out keep their
   * current value.
   */
  magicImports?: Partial<IMagicImportsConfig>;
}

/**
 * Result of making code async.
 */
export interface IAsyncCodeResult {
  asyncFunction: () => Promise<any>;
  withReturn: boolean;
  /**
   * The documentation of the top-level declarations, from their JSDoc.
   */
  docs: IDeclarationDoc[];
  /**
   * The source URL of the code in the stack traces: its name, like In[3],
   * with a `#2` suffix when the name is already used.
   */
  name: string;
}

/**
 * Options of makeAsyncFromCode.
 */
export interface IMakeAsyncOptions {
  /**
   * The name of the code in the tracebacks, like In[3]. Defaults to
   * `<silent-k>`.
   */
  name?: string;
}

/**
 * Information about an extracted import.
 */
export interface IImportInfo {
  /** The original import source (e.g., 'canvas-confetti') */
  source: string;
  /** The transformed URL (e.g., 'https://cdn.jsdelivr.net/npm/canvas-confetti/+esm') */
  url: string;
  /** The local variable name for default import */
  defaultImport?: string;
  /** The local variable name for namespace import */
  namespaceImport?: string;
  /** Named imports: { importedName: localName } */
  namedImports: Record<string, string>;
}

type JSCallable = (...args: any[]) => any;

/**
 * Result of code completion.
 */
export interface ICompletionResult {
  matches: string[];
  cursorStart: number;
  cursorEnd?: number;
  metadata?: Record<string, unknown>;
  status?: string;
}

/**
 * Result of code completeness check.
 */
export type IIsCompleteResult =
  | KernelMessage.IIsCompleteReplyIncomplete
  | KernelMessage.IIsCompleteReplyOther;

/**
 * Result of code inspection.
 */
export type IInspectResult = KernelMessage.IInspectReply;

/**
 * Registry for tracking code declarations across cells.
 * Allows deduplication - later definitions override earlier ones.
 */
export interface ICodeRegistry {
  /** Function declarations by name (setup, draw, etc.) */
  functions: Map<string, any>;
  /** Variable declarations by name */
  variables: Map<string, any>;
  /** Class declarations by name */
  classes: Map<string, any>;
  /** Other top-level statements (expressions, etc.) in execution order */
  statements: any[];
}

/**
 * Configuration for the JavaScript executor.
 */
export class ExecutorConfig {
  /**
   * Instantiate a new ExecutorConfig.
   *
   * @param options - The options changing the defaults.
   */
  constructor(options: IExecutorOptions = {}) {
    this.update(options);
  }

  /**
   * Change the configuration with some options. The options left out, or
   * undefined, keep their current value.
   */
  update(options: IExecutorOptions): void {
    if (options.magicImports) {
      const changes: Partial<IMagicImportsConfig> = {};
      for (const [key, value] of Object.entries(options.magicImports)) {
        if (value !== undefined) {
          (changes as Record<string, unknown>)[key] = value;
        }
      }
      this._magicImports = { ...this._magicImports, ...changes };
    }
  }

  /**
   * Get the magic imports configuration.
   */
  get magicImports(): IMagicImportsConfig {
    return this._magicImports;
  }

  /**
   * Set the magic imports configuration.
   */
  set magicImports(value: IMagicImportsConfig) {
    this._magicImports = value;
  }

  private _magicImports: IMagicImportsConfig = {
    enabled: true,
    baseUrl: 'https://cdn.jsdelivr.net/',
    enableAutoNpm: true,
    appendEsmSuffix: true
  };
}

/**
 * JavaScript code executor with advanced features.
 */
export class JavaScriptExecutor {
  /**
   * Instantiate a new JavaScriptExecutor.
   *
   * @param globalScope - The global scope (globalThis) for code execution.
   * @param config - Optional executor configuration.
   */
  constructor(globalScope: Record<string, any>, config?: ExecutorConfig) {
    this._globalScope = globalScope;
    this._config = config || new ExecutorConfig();
    // The Function constructor of the realm, read before any code of the
    // cells runs, which could replace it
    const scopeFunction = safe(() => globalScope.Function);
    this._functionConstructor =
      typeof scopeFunction === 'function' ? scopeFunction : Function;
  }

  /**
   * The configuration of the executor, read when the cells are compiled.
   */
  get config(): ExecutorConfig {
    return this._config;
  }

  /**
   * The guard called by the loops of the cells, to interrupt them. Without
   * it (the default), the loops are not instrumented.
   *
   * The functions of a cell keep the guard of the cell, also when they are
   * called later, from another cell or a callback.
   */
  get loopGuard(): LoopGuard | null {
    return this._loopGuard;
  }
  set loopGuard(value: LoopGuard | null) {
    this._loopGuard = value;
  }

  /**
   * Convert user code to an async function, called with the global scope as
   * `this`.
   *
   * The code is registered for the tracebacks, under its name. A syntax
   * error is thrown as a CellSyntaxError, with its location in the code.
   *
   * @param code - The user code to convert.
   * @param options - The name of the code in the tracebacks.
   * @returns The async function and whether it has a return value.
   */
  makeAsyncFromCode(
    code: string,
    options: IMakeAsyncOptions = {}
  ): IAsyncCodeResult {
    this._calibrate();
    const displayName = options.name ?? `<silent-${++this._silentCount}>`;
    let name = displayName;
    for (let k = 2; this._cells.has(name); k++) {
      name = `${displayName}#${k}`;
    }

    if (code.length === 0) {
      return {
        asyncFunction: async () => {},
        withReturn: false,
        docs: [],
        name
      };
    }

    const comments: Comment[] = [];
    let ast: any;
    try {
      ast = parseCode(code, comments);
    } catch (error) {
      this._registerCell(name, createCellSource({ name: displayName, code }));
      throw this._toCellSyntaxError(error, name);
    }

    const fixed = this._fixedGlobalDeclaration(ast);
    if (fixed) {
      this._registerCell(name, createCellSource({ name: displayName, code }));
      const { line, column } = offsetToLineColumn(
        lineStarts(code),
        fixed.start
      );
      throw new CellSyntaxError(fixedGlobalMessage(fixed.name), {
        token: name,
        line,
        column
      });
    }

    const { edited, map, hoisted, withReturn } = this._rewriteCell(
      code,
      ast,
      options.name
    );

    // The hoisted code goes on a line of its own, before the code of the
    // cell, whose lines are kept. The ";" stops a "use strict" directive,
    // which would break the assignments. The source URL comes last, on its
    // own line, so that the code of the cell can not change it.
    const prefix = `;${hoisted}`;
    const body = `${prefix}\n${edited}\n//# sourceURL=${name}`;
    this._registerCell(
      name,
      createCellSource({
        name: displayName,
        code,
        body,
        cellStart: prefix.length + 1,
        map,
        editedLength: edited.length
      })
    );

    if (edited.includes(LOOP_GUARD_NAME)) {
      this._editedCode.set(name, edited);
    }

    // The helpers are parameters of the compiled function, which the code
    // of the cell can not replace
    const compiled = this._compile(body);
    const guard = this._loopGuard?.fn;
    const defineGlobal = this._defineGlobal;
    return {
      asyncFunction: function (this: unknown) {
        return compiled.call(this, guard, defineGlobal);
      },
      withReturn,
      docs: this._declarationDocs(code, ast, comments),
      name
    };
  }

  /**
   * The source code of a function, as written in its cell: without the
   * calls to the loop guard added by the kernel.
   *
   * @param fn - The function.
   */
  functionSource(fn: unknown): string {
    const source = safe(() => Function.prototype.toString.call(fn), '');
    if (!source.includes(LOOP_GUARD_NAME)) {
      return source;
    }
    // The function is in the edited code of a cell, from the newest
    for (const [name, edited] of [...this._editedCode].reverse()) {
      const start = edited.indexOf(source);
      const cell = this._cells.get(name);
      if (start < 0 || !cell) {
        continue;
      }
      const from = cell.map.toOriginal(start);
      const to = cell.map.toOriginal(start + source.length - 1) + 1;
      return cell.code.slice(from, to);
    }
    return stripLoopGuardCalls(source);
  }

  /**
   * Format a thrown value for an error reply: its location in the cell,
   * with a caret, `Name: message` and the frames, without the ones of the
   * kernel, then its cause and its aggregated errors.
   *
   * @param error - The thrown value.
   * @param options.currentToken - The name of the cell being executed (the
   * `name` of makeAsyncFromCode), for the errors it throws.
   * @param options.prefix - Printed before the header, like `Uncaught`.
   * @param options.colors - Whether to color with ANSI escape codes.
   */
  formatError(
    error: unknown,
    options: { currentToken?: string; prefix?: string; colors?: boolean } = {}
  ): IErrorParts {
    return formatError(error, this._tracebackContext(options.currentToken), {
      prefix: options.prefix,
      colors: options.colors
    });
  }

  /**
   * The lines shown after `Name: message` for an error: its frames mapped to
   * the cells, its cause and its aggregated errors. Returns null for the
   * values which are not errors, and the stacks which can not be read.
   *
   * @param error - The error.
   * @param colors - Whether to color with ANSI escape codes.
   */
  formatStackFrames(error: unknown, colors = true): string[] | null {
    return formatStackLines(error, this._tracebackContext(), colors);
  }

  /**
   * Extract import information from code without executing it.
   * Used to track imports for sketch generation.
   *
   * @param code - The code to analyze for imports.
   * @returns Array of import information objects.
   */
  extractImports(code: string): IImportInfo[] {
    if (code.length === 0) {
      return [];
    }

    try {
      const ast = parseCode(code);

      const imports: IImportInfo[] = [];

      for (const node of ast.body) {
        if (node.type === 'ImportDeclaration') {
          const source = String(node.source.value);
          const url = this._transformImportSource(source);

          const importInfo: IImportInfo = {
            source,
            url,
            namedImports: {}
          };

          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportDefaultSpecifier') {
              importInfo.defaultImport = specifier.local.name;
            } else if (specifier.type === 'ImportNamespaceSpecifier') {
              importInfo.namespaceImport = specifier.local.name;
            } else if (specifier.type === 'ImportSpecifier') {
              if (specifier.imported.name === 'default') {
                importInfo.defaultImport = specifier.local.name;
              } else {
                importInfo.namedImports[specifier.imported.name] =
                  specifier.local.name;
              }
            }
          }

          imports.push(importInfo);
        }
      }

      return imports;
    } catch {
      return [];
    }
  }

  /**
   * Generate async JavaScript code to load imports and assign them to globalThis.
   * This is used when generating the sketch iframe.
   *
   * @param imports - The import information objects.
   * @returns Generated JavaScript code string.
   */
  generateImportCode(imports: IImportInfo[]): string {
    if (imports.length === 0) {
      return '';
    }

    const lines: string[] = [];

    for (const imp of imports) {
      const importCall = `import(${JSON.stringify(imp.url)})`;

      if (imp.defaultImport) {
        lines.push(
          `const { default: ${imp.defaultImport} } = await ${importCall};`
        );
        lines.push(
          `globalThis["${imp.defaultImport}"] = ${imp.defaultImport};`
        );
      }

      if (imp.namespaceImport) {
        lines.push(`const ${imp.namespaceImport} = await ${importCall};`);
        lines.push(
          `globalThis["${imp.namespaceImport}"] = ${imp.namespaceImport};`
        );
      }

      const namedKeys = Object.keys(imp.namedImports);
      if (namedKeys.length > 0) {
        const destructure = namedKeys
          .map(k =>
            k === imp.namedImports[k] ? k : `${k}: ${imp.namedImports[k]}`
          )
          .join(', ');
        lines.push(`const { ${destructure} } = await ${importCall};`);
        for (const importedName of namedKeys) {
          const localName = imp.namedImports[importedName];
          lines.push(`globalThis["${localName}"] = ${localName};`);
        }
      }

      // Side-effect only import (no specifiers)
      if (
        !imp.defaultImport &&
        !imp.namespaceImport &&
        Object.keys(imp.namedImports).length === 0
      ) {
        lines.push(`await ${importCall};`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Import a module using the executor's import source resolution.
   */
  async importModule(source: string): Promise<Record<string, unknown>> {
    const importSource = this._transformImportSource(source);
    const importFunction = this._createScopedFunction(
      'source',
      'return import(source);'
    ) as (source: string) => Promise<Record<string, unknown>>;
    return importFunction.call(this._globalScope, importSource);
  }

  /**
   * Create a new empty code registry.
   */
  createCodeRegistry(): ICodeRegistry {
    return {
      functions: new Map(),
      variables: new Map(),
      classes: new Map(),
      statements: []
    };
  }

  /**
   * Register code from executed cells into the registry.
   * Later definitions of the same name will override earlier ones.
   * Import declarations are skipped (handled separately).
   *
   * @param code - The code to register.
   * @param registry - The registry to add declarations to.
   */
  registerCode(code: string, registry: ICodeRegistry): void {
    if (code.trim().length === 0) {
      return;
    }

    try {
      const ast = parseCode(code);

      for (const statement of ast.body) {
        // The declarations of the export statements are kept, the other
        // exports are left out
        const node = unwrapExport(statement);
        if (!node) {
          continue;
        }
        switch (node.type) {
          case 'FunctionDeclaration':
            // Store function by name - later definitions override
            if (node.id && node.id.name) {
              registry.functions.set(node.id.name, node);
            }
            break;

          case 'ClassDeclaration':
            // Store class by name - later definitions override
            if (node.id && node.id.name) {
              registry.classes.set(node.id.name, node);
            }
            break;

          case 'VariableDeclaration':
            // For variable declarations, extract each declarator
            for (const declarator of node.declarations) {
              if (declarator.id.type === 'Identifier') {
                // Store the whole declaration node with just this declarator
                const singleDecl = {
                  ...node,
                  declarations: [declarator]
                };
                registry.variables.set(declarator.id.name, singleDecl);
              } else if (declarator.id.type === 'ObjectPattern') {
                // Handle destructuring: const { a, b } = obj
                for (const prop of declarator.id.properties) {
                  if (
                    prop.type === 'Property' &&
                    prop.key.type === 'Identifier'
                  ) {
                    const name =
                      prop.value?.type === 'Identifier'
                        ? prop.value.name
                        : prop.key.name;
                    registry.variables.set(name, {
                      ...node,
                      declarations: [declarator],
                      _destructuredName: name
                    });
                  }
                }
              } else if (declarator.id.type === 'ArrayPattern') {
                // Handle array destructuring: const [a, b] = arr
                for (const element of declarator.id.elements) {
                  if (element && element.type === 'Identifier') {
                    registry.variables.set(element.name, {
                      ...node,
                      declarations: [declarator],
                      _destructuredName: element.name
                    });
                  }
                }
              }
            }
            break;

          case 'ImportDeclaration':
            // Skip imports - handled separately via extractImports
            break;

          case 'ExpressionStatement':
            registry.statements.push(node);
            break;

          default:
            // Other statements (if, for, while, etc.) - keep in order
            registry.statements.push(node);
            break;
        }
      }
    } catch {
      // If parsing fails, we can't register the code
    }
  }

  /**
   * Generate code from the registry.
   * Produces clean, deduplicated code for regeneration scenarios.
   * Includes globalThis assignments so declarations are accessible globally.
   *
   * @param registry - The registry to generate code from.
   * @returns Generated JavaScript code string.
   */
  generateCodeFromRegistry(registry: ICodeRegistry): string {
    const programBody: any[] = [];
    const globalAssignments: string[] = [];

    // Add variables first (they might be used by functions)
    const seenDestructuringDecls = new Set<string>();
    for (const [name, node] of registry.variables) {
      globalAssignments.push(`globalThis["${name}"] = ${name};`);

      // For destructuring, only add once per actual declaration
      if (node._destructuredName) {
        const declKey = generate(node.declarations[0]);
        if (seenDestructuringDecls.has(declKey)) {
          continue;
        }
        seenDestructuringDecls.add(declKey);
        // Remove the marker before generating
        const cleanNode = { ...node };
        delete cleanNode._destructuredName;
        programBody.push(cleanNode);
      } else {
        programBody.push(node);
      }
    }

    // Add classes
    for (const [name, node] of registry.classes) {
      programBody.push(node);
      globalAssignments.push(`globalThis["${name}"] = ${name};`);
    }

    // Add functions
    for (const [name, node] of registry.functions) {
      programBody.push(node);
      globalAssignments.push(`globalThis["${name}"] = ${name};`);
    }

    // Add other statements in order
    for (const node of registry.statements) {
      programBody.push(node);
    }

    // Create a program AST and generate code
    const program = {
      type: 'Program',
      body: programBody,
      sourceType: 'script'
    };

    // Generate the code and append globalThis assignments
    const generatedCode = generate(program);

    if (globalAssignments.length > 0) {
      return generatedCode + '\n' + globalAssignments.join('\n');
    }

    return generatedCode;
  }

  /**
   * Get the MIME bundle of a value.
   *
   * Objects can define their representations with:
   * - a [Symbol.for('Jupyter.display')]() method returning a MIME bundle
   * - a _toMime() method returning a MIME bundle
   * - _toHtml(), _toMarkdown(), _toSvg(), _toPng(), _toJpeg(), _toLatex()
   *   or _toJson() methods
   *
   * The plain text representation is formatted like util.inspect in Node.js,
   * and the data with a JSON representation is also shown as a tree.
   *
   * @param value - The value to convert to a MIME bundle.
   * @returns The MIME bundle representation of the value.
   */
  getMimeBundle(value: any): IMimeBundle {
    const text = () =>
      inspect(value, { colors: true, formatStack: this._formatStack });

    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function')
    ) {
      const custom = this._getCustomMimeBundle(value);
      if (custom) {
        if (!('text/plain' in custom)) {
          custom['text/plain'] = text();
        }
        return custom;
      }
    }

    if (typeof value === 'string') {
      // Check if it looks like HTML (must start with a valid tag: <div>, <p class="...">,
      // <!DOCTYPE>, <!-- -->, <br/>, etc.). Rejects non-HTML like "<a, b>".
      const trimmed = value.trim();
      if (
        /^<(?:[a-zA-Z][a-zA-Z0-9-]*[\s/>]|!(?:DOCTYPE|--))/.test(trimmed) &&
        trimmed.endsWith('>')
      ) {
        return {
          'text/html': value,
          'text/plain': value
        };
      }
      return { 'text/plain': text() };
    }

    if (typeof value === 'function') {
      const source = this.functionSource(value);
      return {
        'text/plain': text(),
        'text/html': `<pre style="margin:0"><code>${escapeHtml(source)}</code></pre>`
      };
    }

    if (value === null || typeof value !== 'object') {
      return { 'text/plain': text() };
    }

    // Handle DOM elements (Canvas, HTMLElement, etc.)
    if (this._isDOMElement(value)) {
      return this._getDOMElementMimeBundle(value);
    }

    // Objects which are already a MIME bundle, with MIME types in their data
    if (value.data && typeof value.data === 'object') {
      const dataKeys = Object.keys(value.data);
      if (dataKeys.some(key => key.includes('/'))) {
        return value.data;
      }
    }

    // Data with a JSON representation is also shown as an interactive tree
    const json = this._toJson(value);
    if (json !== undefined) {
      return { 'application/json': json, 'text/plain': text() };
    }
    return { 'text/plain': text() };
  }

  /**
   * Complete a line of code, at its end.
   *
   * @param codeLine - The line of code to complete.
   * @returns The completion result with matches and cursor position.
   */
  completeLine(codeLine: string): ICompletionResult {
    return this.completeRequest(codeLine, codeLine.length);
  }

  /**
   * Complete the code at the cursor position.
   *
   * @param code - The full code content.
   * @param cursorPos - The cursor position in the code, in code points.
   * @returns The completion result with matches and cursor positions.
   */
  completeRequest(code: string, cursorPos: number): ICompletionResult {
    const reply = this.introspection.complete(code, cursorPos);
    return {
      matches: reply.matches,
      cursorStart: reply.cursor_start,
      cursorEnd: reply.cursor_end,
      metadata: reply.metadata,
      status: 'ok'
    };
  }

  /**
   * The stack trace of an error, as plain text, with the frames mapped to
   * the cells and without the frames of the kernel.
   *
   * @deprecated Use formatError or formatStackFrames.
   *
   * @param error - The error with stack trace to clean.
   * @returns The cleaned stack trace string.
   */
  cleanStackTrace(error: Error): string {
    const header = `${error.name}: ${error.message}`;
    const lines = this.formatStackFrames(error, false) ?? [];
    return stripAnsi([header, ...lines].join('\n'));
  }

  /**
   * Check if code is syntactically complete.
   * Used for multi-line input in console-style interfaces.
   *
   * @param code - The code to check.
   * @returns The completeness status and suggested indentation.
   */
  isComplete(code: string): IIsCompleteResult {
    if (code.trim().length === 0) {
      return { status: 'complete' };
    }

    try {
      parseCode(code);
      return { status: 'complete' };
    } catch (e: any) {
      // The code is incomplete when the parser reaches its end too early,
      // or when it ends in the middle of a string, template or comment.
      const incomplete =
        e.pos >= code.length ||
        /^Unterminated (string constant|template|comment)/.test(e.message);

      if (incomplete) {
        // Determine indentation for next line
        const lines = code.split('\n');
        const lastLine = lines[lines.length - 1];
        const currentIndent = lastLine.match(/^(\s*)/)?.[1] || '';

        // Add more indent if we're opening a block
        const opensBlock = /[{([]$/.test(lastLine.trim());
        const indent = opensBlock ? currentIndent + '  ' : currentIndent;

        return { status: 'incomplete', indent };
      }

      // Syntax error that's not about incompleteness
      return { status: 'invalid' };
    }
  }

  /**
   * Inspect the expression at the cursor position, for the contextual help
   * and the tooltips.
   *
   * @param code - The code containing the expression to inspect.
   * @param cursorPos - The cursor position in the code, in code points.
   * @param detailLevel - The level of detail (0 for basic, higher for more).
   * @returns The inspection result.
   */
  inspect(
    code: string,
    cursorPos: number,
    detailLevel: KernelMessage.IInspectRequestMsg['content']['detail_level'] = 0
  ): IInspectResult {
    const reply = this.introspection.inspect(code, cursorPos, detailLevel);
    return {
      status: 'ok',
      found: reply.found,
      data: reply.data,
      metadata: reply.metadata
    };
  }

  /**
   * The code completion and inspection of the global scope.
   */
  get introspection(): Introspection {
    if (!this._introspection) {
      this._introspection = new Introspection({
        globalScope: this._globalScope,
        evaluate: expression =>
          this._createScopedFunction(`return (${expression});`).call(
            this._globalScope
          ),
        builtinDocumentation: expression =>
          this.getBuiltinDocumentation(expression),
        functionSource: fn => this.functionSource(fn)
      });
    }
    return this._introspection;
  }

  /**
   * Get predefined documentation for built-in JavaScript objects.
   * Subclasses can override this to add domain-specific documentation.
   *
   * @param expression - The expression to get documentation for.
   * @returns The documentation string, or null if not found.
   */
  protected getBuiltinDocumentation(expression: string): string | null {
    // Common JavaScript built-ins documentation
    const builtins: Record<string, string> = {
      console:
        'The console object provides access to the browser debugging console.',
      Math: 'The Math object provides mathematical constants and functions.',
      JSON: 'The JSON object provides methods for parsing and stringifying JSON.',
      Array:
        'The Array object is used to store multiple values in a single variable.',
      Object: "The Object class represents one of JavaScript's data types.",
      String:
        'The String object is used to represent and manipulate a sequence of characters.',
      Number: 'The Number object is a wrapper object for numeric values.',
      Date: 'The Date object represents a single moment in time.',
      Promise:
        'The Promise object represents the eventual completion of an async operation.',
      Map: 'The Map object holds key-value pairs and remembers the original insertion order.',
      Set: 'The Set object lets you store unique values of any type.'
    };

    return builtins[expression] ?? null;
  }

  /**
   * Add code to export top-level variables to global scope.
   */
  private _addToGlobalThisCode(key: string, identifier = key): string {
    // Keep declarations on both globalThis and this for compatibility with
    // different runtime invocation paths.
    return `globalThis["${key}"] = this["${key}"] = ${identifier};`;
  }

  /**
   * Create a function using the runtime realm's Function constructor.
   */
  private _createScopedFunction(...args: string[]): JSCallable {
    return this._functionConstructor(...args) as JSCallable;
  }

  /**
   * Collect the identifier nodes of a declaration pattern.
   */
  private _collectDeclaredIdentifiers(pattern: any, identifiers: any[]): void {
    if (!pattern) {
      return;
    }

    switch (pattern.type) {
      case 'Identifier':
        identifiers.push(pattern);
        break;
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'Property') {
            this._collectDeclaredIdentifiers(prop.value, identifiers);
          } else if (prop.type === 'RestElement') {
            this._collectDeclaredIdentifiers(prop.argument, identifiers);
          }
        }
        break;
      case 'ArrayPattern':
        for (const element of pattern.elements) {
          this._collectDeclaredIdentifiers(element, identifiers);
        }
        break;
      case 'AssignmentPattern':
        this._collectDeclaredIdentifiers(pattern.left, identifiers);
        break;
      case 'RestElement':
        this._collectDeclaredIdentifiers(pattern.argument, identifiers);
        break;
      default:
        break;
    }
  }

  /**
   * Get the identifier nodes declared by a function, class or variable
   * declaration.
   */
  private _declaredIdentifiers(node: any): any[] {
    const identifiers: any[] = [];
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        this._collectDeclaredIdentifiers(declaration.id, identifiers);
      }
    } else if (
      ['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) &&
      node.id
    ) {
      identifiers.push(node.id);
    }
    return identifiers;
  }

  /**
   * Get the names declared by a function, class or variable declaration.
   */
  private _declaredNames(node: any): string[] {
    return this._declaredIdentifiers(node).map(identifier => identifier.name);
  }

  /**
   * How a top-level declaration named `name` is kept in the global scope,
   * from the property of the global scope with this name.
   */
  private _globalKind(name: string): GlobalKind {
    let scope = this._globalScope;
    let own = true;
    while (scope) {
      const current = scope;
      const descriptor = safe(() =>
        Object.getOwnPropertyDescriptor(current, name)
      );
      if (descriptor) {
        if (descriptor.writable === true) {
          return 'assign';
        }
        if (name.startsWith('on') && descriptor.set) {
          return 'setter';
        }
        // A property of a prototype is shadowed by the defined one
        return own && !descriptor.configurable ? 'fixed' : 'define';
      }
      scope = safe(() => Object.getPrototypeOf(current), null);
      own = false;
    }
    return 'assign';
  }

  /**
   * The first identifier declared at the top level of a cell for a global
   * which can not be replaced, like `location` in a window, if any.
   */
  private _fixedGlobalDeclaration(ast: any): any | null {
    for (const statement of ast.body) {
      const node = unwrapExport(statement);
      if (!node) {
        continue;
      }
      const identifiers =
        node.type === 'ImportDeclaration'
          ? node.specifiers.map((specifier: any) => specifier.local)
          : this._declaredIdentifiers(node);
      const kept = this._keptGlobalNames(node);
      for (const identifier of identifiers) {
        if (
          !kept.has(identifier.name) &&
          this._globalKind(identifier.name) === 'fixed'
        ) {
          return identifier;
        }
      }
    }
    return null;
  }

  /**
   * The names of the globals which can not be replaced declared without a
   * value by a var declaration, like `var undefined;`. As in a script, the
   * declaration keeps the global: the name is assigned like the other var
   * declarations, `var window;` becoming `    window;`.
   */
  private _keptGlobalNames(node: any): Set<string> {
    const names = new Set<string>();
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      for (const declaration of node.declarations) {
        if (
          !declaration.init &&
          declaration.id.type === 'Identifier' &&
          this._globalKind(declaration.id.name) === 'fixed'
        ) {
          names.add(declaration.id.name);
        }
      }
    }
    return names;
  }

  /**
   * The code copying the local declaration of a name to the global scope,
   * for the names declared over a global without a writable property.
   */
  private _copyToGlobalCode(name: string): string {
    return this._globalKind(name) === 'define'
      ? `${DEFINE_GLOBAL_NAME}(this, "${name}", ${name});`
      : this._addToGlobalThisCode(name);
  }

  /**
   * Define a global declared by a cell as a writable property of the global
   * scope, and of the `this` of the cell when it is another object. Called by
   * the cells for the names of the accessors of the global scope.
   */
  private _defineGlobal = (scope: unknown, name: string, value: unknown) => {
    for (const target of new Set([this._globalScope, scope])) {
      if (
        target === null ||
        (typeof target !== 'object' && typeof target !== 'function')
      ) {
        continue;
      }
      try {
        Object.defineProperty(target, name, {
          value,
          writable: true,
          configurable: true,
          enumerable: true
        });
      } catch {
        throw new TypeError(fixedGlobalMessage(name));
      }
    }
  };

  /**
   * Transform import source with magic imports.
   */
  private _transformImportSource(source: string): string {
    if (!this._config.magicImports.enabled) {
      return source;
    }

    // Keep absolute, relative and import-map style specifiers unchanged.
    if (this._isDirectImportSource(source)) {
      return source;
    }

    const { path: sourcePath, suffix } = this._splitImportSourceSuffix(source);

    const transformedPath =
      ['npm/', 'gh/'].some(start => sourcePath.startsWith(start)) ||
      !this._config.magicImports.enableAutoNpm
        ? sourcePath
        : `npm/${sourcePath}`;

    let transformedSource = `${this._joinBaseAndPath(
      this._config.magicImports.baseUrl,
      transformedPath
    )}${suffix}`;

    if (
      this._config.magicImports.appendEsmSuffix !== false &&
      this._shouldAppendEsmSuffix(sourcePath)
    ) {
      transformedSource = this._appendEsmSuffix(transformedSource);
    }

    return transformedSource;
  }

  /**
   * Whether an import source should bypass magic import transformation.
   */
  private _isDirectImportSource(source: string): boolean {
    return (
      /^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/\/)/.test(source) ||
      source.startsWith('./') ||
      source.startsWith('../') ||
      source.startsWith('/') ||
      source.startsWith('#')
    );
  }

  /**
   * Whether a transformed import should include the jsDelivr `+esm` suffix.
   */
  private _shouldAppendEsmSuffix(sourcePath: string): boolean {
    const noEsmEnds = ['.js', '.mjs', '.cjs', '.wasm', '+esm'];
    return !noEsmEnds.some(end => sourcePath.endsWith(end));
  }

  /**
   * Append `+esm` before query/hash suffixes.
   */
  private _appendEsmSuffix(source: string): string {
    const { path, suffix } = this._splitImportSourceSuffix(source);
    const esmSuffix = path.endsWith('/') ? '+esm' : '/+esm';
    return `${path}${esmSuffix}${suffix}`;
  }

  /**
   * Split an import source into path and query/hash suffix.
   */
  private _splitImportSourceSuffix(source: string): {
    path: string;
    suffix: string;
  } {
    const queryIndex = source.indexOf('?');
    const hashIndex = source.indexOf('#');
    const splitIndex =
      queryIndex === -1
        ? hashIndex
        : hashIndex === -1
          ? queryIndex
          : Math.min(queryIndex, hashIndex);

    if (splitIndex === -1) {
      return { path: source, suffix: '' };
    }

    return {
      path: source.slice(0, splitIndex),
      suffix: source.slice(splitIndex)
    };
  }

  /**
   * Join a base URL and import path while preserving origin semantics.
   */
  private _joinBaseAndPath(baseUrl: string, path: string): string {
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const normalizedPath = path.replace(/^\/+/, '');

    return resolveUrl(normalizedPath, normalizedBase);
  }

  /**
   * Rewrite the code of a cell to run in the body of an async function:
   * import statements to dynamic imports, top-level declarations to
   * assignments to the global scope, and the last expression to a return.
   * The export keywords are removed, keeping the declarations.
   *
   * The rewrites are edits of the code of the cell, which keep its lines,
   * with a map of the positions for the tracebacks.
   */
  private _rewriteCell(
    code: string,
    ast: any,
    cellName?: string
  ): {
    edited: string;
    map: PositionMap;
    hoisted: string;
    withReturn: boolean;
  } {
    const edits = new SourceEdits(code);
    // First, so that the end of a loop goes before the texts inserted after
    // the statement
    this._instrumentLoops(edits, ast, cellName);
    // The var declarations are hoisted first, then the functions
    const hoistedVars: string[] = [];
    const hoisted: string[] = [];
    // The names of the builtin globals that the code of the cell can assign
    // again after their declaration
    const reassignable = new Set<string>();

    ast.body.forEach((statement: any, i: number) => {
      const node = this._rewriteExport(edits, statement, i);
      if (!node) {
        return;
      }
      // The var declarations without a value of the globals which can not be
      // replaced are assigned, which keeps the global
      const kept = this._keptGlobalNames(node);
      const names = this._declaredNames(node).filter(name => !kept.has(name));
      if (node.type === 'ImportDeclaration') {
        this._rewriteImport(edits, node, i);
      } else if (names.some(name => this._globalKind(name) !== 'assign')) {
        // Keep the declaration local, and copy it to the global scope where
        // it is declared, so that it is kept if a later line throws
        if (node.type !== 'VariableDeclaration' || node.kind !== 'const') {
          names.forEach(name => reassignable.add(name));
        }
        const copies = names
          .map(name => this._copyToGlobalCode(name))
          .join(' ');
        const separator =
          node.type === 'VariableDeclaration' && code[node.end - 1] !== ';'
            ? '; '
            : ' ';
        edits.insert(node.end, `${separator}${copies}`);
      } else if (node.type === 'FunctionDeclaration') {
        // Assign the function before the code runs, using a hoisted factory
        const factoryName = `__jsKernelFunction${i}`;
        edits.insert(node.start, `function ${factoryName}() { return `);
        edits.insert(node.end, ' }');
        hoisted.push(`${node.id.name} = ${factoryName}();`);
      } else if (node.type === 'ClassDeclaration') {
        edits.insert(node.start, `${node.id.name} = `);
        edits.insert(node.end, ';');
      } else if (node.type === 'VariableDeclaration') {
        this._rewriteVariableDeclaration(edits, node);
        // A var declaration keeps the value of the global, and the global
        // exists before the code of the cell runs
        if (node.kind === 'var') {
          for (const name of this._declaredNames(node)) {
            hoistedVars.push(
              `if (!("${name}" in globalThis)) globalThis["${name}"] = undefined;`
            );
          }
        }
      }
    });

    // Return the last expression, unless it ends with a semicolon or is an
    // assignment. The parentheses go around the statement, so that the
    // parentheses of `({ a: 1 })` are kept, and the value is not assigned,
    // so that the names of the anonymous functions are not inferred.
    const last = ast.body[ast.body.length - 1];
    const withReturn =
      !!last &&
      last.type === 'ExpressionStatement' &&
      last.expression.type !== 'AssignmentExpression' &&
      !code.slice(last.expression.end, last.end).includes(';');

    // Copy the builtin globals again at the end of the cell, before the
    // last expression, with the values of their last assignments
    if (reassignable.size > 0) {
      const copies = [...reassignable]
        .map(name => this._copyToGlobalCode(name))
        .join(' ');
      if (withReturn) {
        edits.insert(last.start, `;${copies} `);
      } else {
        edits.insert(last.end, `; ${copies}`);
      }
    }

    if (withReturn) {
      edits.insert(last.start, 'return (');
      edits.insert(last.end, ')');
    }

    const { code: edited, map } = edits.apply();
    return {
      edited,
      map,
      hoisted: [...hoistedVars, ...hoisted].join(' '),
      withReturn
    };
  }

  /**
   * Remove the export keywords of a top-level statement, since a cell is not
   * a module, and return the declaration to rewrite: `export const a = 1`
   * declares `a` like `const a = 1`. The exported lists are removed, the
   * re-exports load their module, and the anonymous default exports are
   * evaluated. Returns null when the statement is rewritten. The other
   * statements are returned as they are.
   */
  private _rewriteExport(edits: SourceEdits, node: any, index: number): any {
    const code = edits.source;
    if (
      node.type !== 'ExportNamedDeclaration' &&
      node.type !== 'ExportDefaultDeclaration' &&
      node.type !== 'ExportAllDeclaration'
    ) {
      return node;
    }
    if (node.source) {
      this._rewriteImport(edits, { ...node, specifiers: [] }, index);
      return null;
    }
    // Replace the export keywords, or the export list, with a semicolon and
    // spaces, keeping the columns and the line breaks. The semicolon ends the
    // previous statement when it has none, like `f()` before `export default
    // (a)`, which would be a call of its result otherwise.
    const declaration = node.declaration;
    const end = declaration ? declaration.start : node.end;
    edits.replace(
      node.start,
      end,
      ';' + code.slice(node.start + 1, end).replace(/[^\r\n\u2028\u2029]/g, ' ')
    );
    if (!declaration) {
      return null;
    }
    const unwrapped = unwrapExport(node);
    if (unwrapped) {
      return unwrapped;
    }
    // An anonymous function or class, or an expression, which could start
    // with a brace
    edits.insert(declaration.start, '(');
    edits.insert(declaration.end, code[node.end - 1] === ';' ? ')' : ');');
    return null;
  }

  /**
   * Insert a call to the loop guard at the start of the body of every loop
   * of a cell, in its functions too. The body becomes a block when it is a
   * single statement. The inserted texts have no line breaks, so the lines
   * of the cell are kept.
   */
  private _instrumentLoops(
    edits: SourceEdits,
    ast: any,
    cellName?: string
  ): void {
    const guard = this._loopGuard;
    if (!guard) {
      return;
    }
    let starts: number[] | null = null;
    const instrument = (node: any) => {
      starts ??= lineStarts(edits.source);
      const { line, column } = offsetToLineColumn(starts, node.start);
      const kind =
        node.type === 'ForOfStatement' && node.await
          ? 'for-await'
          : LOOP_KINDS[node.type];
      const call = loopGuardCall(
        guard.registerSite({ kind, line, column: column + 1, cell: cellName })
      );
      const body = node.body;
      if (body.type === 'BlockStatement') {
        edits.insert(body.start + 1, call);
      } else {
        edits.insert(body.start, `{${call}`);
        edits.insert(body.end, '}');
      }
    };
    walkSimple(
      ast,
      Object.fromEntries(
        Object.keys(LOOP_KINDS).map(type => [type, instrument])
      )
    );
  }

  /**
   * Rewrite an import statement to a dynamic import, on one line followed by
   * the line breaks of the statement, with the copies of the imported names
   * to the global scope.
   */
  private _rewriteImport(edits: SourceEdits, node: any, index: number): void {
    const code = edits.source;
    const importSource = this._transformImportSource(node.source.value);
    const importSourceCode = JSON.stringify(importSource);
    const lineBreaks = '\n'.repeat(
      lineStarts(code.slice(node.start, node.end)).length - 1
    );

    if (node.specifiers.length === 0) {
      // Side-effect import: import 'module'
      edits.replace(
        node.start,
        node.end,
        `await import(${importSourceCode});${lineBreaks}`
      );
      return;
    }

    const importBinding = `__jsKernelImport${index}`;
    const statements = [
      `const ${importBinding} = await import(${importSourceCode});`
    ];
    const destructuredNames: string[] = [];
    const localNames: string[] = [];
    let namespaceImportName = '';
    for (const specifier of node.specifiers) {
      const localName = specifier.local.name;
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaceImportName = localName;
        continue;
      }
      // Handle aliased imports: import { foo as bar } -> const { foo: bar }
      const importedName =
        specifier.type === 'ImportDefaultSpecifier'
          ? 'default'
          : specifier.imported.name;
      destructuredNames.push(
        importedName === localName ? localName : `${importedName}: ${localName}`
      );
      localNames.push(localName);
    }
    if (destructuredNames.length > 0) {
      statements.push(
        `const { ${destructuredNames.join(', ')} } = ${importBinding};`
      );
    }
    if (namespaceImportName) {
      statements.push(`const ${namespaceImportName} = ${importBinding};`);
      localNames.push(namespaceImportName);
    }
    for (const name of localNames) {
      statements.push(this._copyToGlobalCode(name));
    }
    edits.replace(node.start, node.end, statements.join(' ') + lineBreaks);
  }

  /**
   * Rewrite a variable declaration to an assignment, e.g. `let a = 1, b;`
   * to `    a = 1, b = undefined;`. The var declarations without a value keep
   * the value of the global: `var b;` becomes `    b;`.
   */
  private _rewriteVariableDeclaration(edits: SourceEdits, node: any): void {
    const declarations = node.declarations;
    const lastDeclaration = declarations[declarations.length - 1];

    // Wrap patterns in parentheses, and pad to keep the columns
    const isPattern = declarations[0].id.type !== 'Identifier';
    edits.replace(
      node.start,
      node.start + node.kind.length,
      (isPattern ? ';(' : '').padEnd(node.kind.length)
    );
    for (const declaration of declarations) {
      if (!declaration.init && node.kind !== 'var') {
        edits.insert(declaration.end, ' = undefined');
      }
    }
    if (isPattern) {
      edits.insert(lastDeclaration.end, ')');
    }
    if (edits.source[node.end - 1] !== ';') {
      edits.insert(node.end, ';');
    }
  }

  /**
   * Compile the body of a cell to an async function, in the realm of the
   * global scope.
   */
  private _compile(body: string): (...helpers: unknown[]) => Promise<any> {
    if (!this._asyncFunction) {
      this._asyncFunction = this._createScopedFunction(
        'return (async function () {}).constructor'
      )() as (...args: string[]) => (...helpers: unknown[]) => Promise<any>;
    }
    return this._asyncFunction(...HELPER_PARAMETERS, body);
  }

  /**
   * Measure, once, how the engine reports the positions of the cells, with
   * a probe compiled like a cell. Also raise the number of frames of the
   * stack traces, since the frames of the kernel take some.
   */
  private _calibrate(): ICalibration | null {
    if (this._calibration !== undefined) {
      return this._calibration;
    }
    const errorConstructor = safe(() => this._globalScope.Error);
    if (
      typeof errorConstructor?.stackTraceLimit === 'number' &&
      errorConstructor.stackTraceLimit < STACK_TRACE_LIMIT
    ) {
      safe(() => {
        errorConstructor.stackTraceLimit = STACK_TRACE_LIMIT;
      });
    }
    // The body of an async function runs synchronously until its first
    // await, so the error is created when the probe is called
    const holder: { e?: unknown } = {};
    safe(() => {
      const probe = this._compile(
        `;\nthis.e =\nnew Error()\n//# sourceURL=${PROBE_URL}`
      );
      void probe.call(holder);
    });
    this._calibration = calibrate(holder.e, PROBE_URL);
    return this._calibration;
  }

  /**
   * Register the code of a cell for the tracebacks, forgetting the oldest
   * cells beyond MAX_CELLS.
   */
  private _registerCell(name: string, source: ICellSource): void {
    this._cells.set(name, source);
    for (const oldest of this._cells.keys()) {
      if (this._cells.size <= MAX_CELLS) {
        break;
      }
      this._cells.delete(oldest);
      this._editedCode.delete(oldest);
    }
  }

  /**
   * A syntax error of acorn as a CellSyntaxError, with its location and
   * without the `(line:column)` suffix of its message.
   */
  private _toCellSyntaxError(error: any, name: string): unknown {
    const loc = safe(() => error.loc);
    if (
      !(error instanceof SyntaxError) ||
      typeof loc?.line !== 'number' ||
      typeof loc?.column !== 'number'
    ) {
      return error;
    }
    const message = error.message.replace(/ \(\d+:\d+\)$/, '');
    return new CellSyntaxError(message, {
      token: name,
      line: loc.line,
      column: loc.column
    });
  }

  /**
   * The context of the tracebacks: the cells and the calibration.
   */
  private _tracebackContext(currentToken?: string): ITracebackContext {
    return {
      cells: this._cells,
      calibration: this._calibrate(),
      currentToken
    };
  }

  /**
   * The JSON representation of a value, shown as an interactive tree, or
   * undefined for values without one.
   */
  private _toJson(value: any): any {
    // Copy the data, so that it can be sent whatever its realm
    const copy = (data: unknown) =>
      safe(() => JSON.parse(JSON.stringify(data)), undefined);

    if (isError(value)) {
      return {
        name: safe(() => String(value.name), 'Error'),
        message: safe(() => String(value.message), ''),
        stack: safe(() => this.cleanStackTrace(value), '')
      };
    }
    if (isDate(value)) {
      const time = Date.prototype.getTime.call(value);
      return Number.isNaN(time)
        ? undefined
        : Date.prototype.toISOString.call(value);
    }
    if (isMap(value)) {
      return copy(Object.fromEntries(Map.prototype.entries.call(value)));
    }
    if (isSet(value)) {
      return copy(Array.from(Set.prototype.values.call(value)));
    }
    if (
      isRegExp(value) ||
      ArrayBuffer.isView(value) ||
      isModuleNamespace(value) ||
      safe(
        () =>
          [
            '[object Promise]',
            '[object WeakMap]',
            '[object WeakSet]',
            '[object ArrayBuffer]'
          ].includes(Object.prototype.toString.call(value)),
        false
      )
    ) {
      return undefined;
    }
    return copy(value);
  }

  /**
   * Get the MIME bundle of the custom representations of an object, or null
   * if it has none.
   */
  private _getCustomMimeBundle(value: any): IMimeBundle | null {
    const data: IMimeBundle = {};
    const add = (bundle: unknown) => {
      Object.assign(
        data,
        safe(() => normalizeBundle(bundle), {})
      );
    };

    const jupyterDisplay = safe(() => value[JUPYTER_DISPLAY]);
    if (typeof jupyterDisplay === 'function') {
      add(safe(() => jupyterDisplay.call(value)));
    }
    if (typeof safe(() => value._toMime) === 'function') {
      add(safe(() => value._toMime()));
    }
    for (const [method, mimeType] of REPR_METHODS) {
      if (
        !(mimeType in data) &&
        typeof safe(() => value[method]) === 'function'
      ) {
        const result = safe(() => value[method]());
        if (result !== undefined && result !== null) {
          add({ [mimeType]: result });
        }
      }
    }
    if (Object.keys(data).length === 0) {
      return null;
    }

    // A custom plain text, from an inspect() method
    if (!('text/plain' in data) && typeof value.inspect === 'function') {
      const text = safe(() => value.inspect());
      if (typeof text === 'string') {
        data['text/plain'] = text;
      }
    }
    return data;
  }

  /**
   * Check if value is a DOM element.
   */
  private _isDOMElement(value: any): boolean {
    return (
      this._isInstanceOfRealm(value, 'HTMLElement') ||
      this._isInstanceOfRealm(value, 'SVGElement')
    );
  }

  /**
   * Get MIME bundle for DOM elements.
   */
  private _getDOMElementMimeBundle(element: any): IMimeBundle {
    const isCanvasElement =
      this._isInstanceOfRealm(element, 'HTMLCanvasElement') ||
      (typeof element?.toDataURL === 'function' &&
        typeof element?.getContext === 'function');

    // For canvas elements, try to get image data
    if (isCanvasElement) {
      const canvas = element as ICanvasLike;
      try {
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        return {
          'image/png': base64,
          'text/plain': `<canvas width="${canvas.width}" height="${canvas.height}">`
        };
      } catch {
        const canvasHtml =
          typeof canvas.outerHTML === 'string'
            ? canvas.outerHTML
            : '<canvas></canvas>';
        return { 'text/plain': canvasHtml };
      }
    }

    // For other elements, return HTML
    const elementHtml =
      typeof element?.outerHTML === 'string'
        ? element.outerHTML
        : String(element);
    return {
      'text/html': elementHtml,
      'text/plain': elementHtml
    };
  }

  /**
   * Check `instanceof` against runtime-realm constructors when available.
   *
   * Looks up the constructor by name in both the runtime scope and
   * `globalThis`, so callers don't need to pass a fallback constructor.
   */
  private _isInstanceOfRealm(value: any, ctorName: string): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    // Check against the runtime scope constructor (e.g. iframe window).
    const scopeCtor = this._globalScope?.[ctorName];
    if (typeof scopeCtor === 'function') {
      try {
        if (value instanceof scopeCtor) {
          return true;
        }
      } catch {
        // Ignore invalid instanceof checks.
      }
    }

    // Fall back to the current realm's globalThis constructor.
    const globalCtor = (globalThis as Record<string, any>)[ctorName];
    if (typeof globalCtor === 'function') {
      try {
        return value instanceof globalCtor;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * The documentation of the top-level declarations of a cell, from the
   * JSDoc comments just before them.
   */
  private _declarationDocs(
    code: string,
    ast: any,
    comments: Comment[]
  ): IDeclarationDoc[] {
    const docs: IDeclarationDoc[] = [];
    const findDoc = (start: number): string | null => {
      for (let i = comments.length - 1; i >= 0; i--) {
        const comment = comments[i];
        if (comment.end > start) {
          continue;
        }
        if (
          comment.type === 'Block' &&
          comment.value.startsWith('*') &&
          code.slice(comment.end, start).trim() === ''
        ) {
          return comment.value
            .replace(/^\*/, '')
            .split('\n')
            .map(line => line.replace(/^\s*\* ?/, ''))
            .join('\n')
            .trim();
        }
        return null;
      }
      return null;
    };
    const declare = (node: any, outer: any) => {
      const doc = findDoc(outer.start);
      if (!doc) {
        return;
      }
      if (node.type === 'VariableDeclaration') {
        for (const declaration of node.declarations) {
          if (declaration.id.type === 'Identifier') {
            docs.push({ name: declaration.id.name, doc });
          }
        }
      } else if (
        (node.type === 'FunctionDeclaration' ||
          node.type === 'ClassDeclaration') &&
        node.id
      ) {
        docs.push({ name: node.id.name, doc });
      }
    };
    for (const node of ast.body) {
      if (
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportDefaultDeclaration'
      ) {
        if (node.declaration) {
          declare(node.declaration, node);
        }
      } else {
        declare(node, node);
      }
    }
    return docs;
  }

  /**
   * Formats the frames of the errors shown by inspect.
   */
  private _formatStack = (error: unknown, colors: boolean) =>
    this.formatStackFrames(error, colors);

  private _asyncFunction:
    | ((...args: string[]) => (...helpers: unknown[]) => Promise<any>)
    | null = null;
  private _calibration: ICalibration | null | undefined = undefined;
  private _cells = new Map<string, ICellSource>();
  /**
   * The edited code of the cells with loops, to show the source of their
   * functions without the loop guard.
   */
  private _editedCode = new Map<string, string>();
  private _loopGuard: LoopGuard | null = null;
  private _functionConstructor: FunctionConstructor;
  private _silentCount = 0;
  private _introspection: Introspection | null = null;
  private _config: ExecutorConfig;
  private _globalScope: Record<string, any>;
}
