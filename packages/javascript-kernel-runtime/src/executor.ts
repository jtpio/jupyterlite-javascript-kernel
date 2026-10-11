// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

import { parse, type Comment } from 'acorn';
import { generate } from 'astring';

import type { IMimeBundle } from '@jupyterlab/nbformat';

import { normalizeBundle } from './display';
import {
  inspect,
  isDate,
  isError,
  isMap,
  isModuleNamespace,
  isRegExp,
  isSet
} from './inspect';
import { Introspection, type IDeclarationDoc } from './introspection';
import { escapeHtml, safe } from './utils';

/** Matches the word "eval" in a stack frame (user eval code). */
const RE_EVAL = /\beval\b/;

/**
 * The ECMAScript edition accepted by the kernel.
 *
 * The cells are parsed with the latest edition known to acorn, so this is
 * the latest edition of the installed acorn: `jlpm lint:check` verifies it,
 * bump it together with acorn. The browser decides which built-in APIs exist.
 */
export const ECMASCRIPT_EDITION = 2026;

/**
 * Parse the code of a cell. Cells are parsed as modules, so that they can
 * use import declarations and top-level await.
 */
function parseCode(code: string, comments?: Comment[]): any {
  return parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    onComment: comments
  });
}

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
 * Configuration for magic imports.
 */
export interface IMagicImportsConfig {
  enabled: boolean;
  baseUrl: string;
  enableAutoNpm: boolean;
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
    enableAutoNpm: true
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
  }

  /**
   * Convert user code to an async function.
   *
   * @param code - The user code to convert.
   * @returns The async function and whether it has a return value.
   */
  makeAsyncFromCode(code: string): IAsyncCodeResult {
    if (code.length === 0) {
      return {
        asyncFunction: async () => {},
        withReturn: false,
        docs: []
      };
    }

    const comments: Comment[] = [];
    const ast = parseCode(code, comments);

    // Handle last statement / add return if needed
    const { withReturn, modifiedUserCode, extraReturnCode } =
      this._handleLastStatement(code, ast);

    // Handle import statements and top-level declarations
    const {
      modifiedUserCode: finalCode,
      codeAddToGlobalScope,
      hoistedCode
    } = this._rewriteTopLevelStatements(modifiedUserCode, ast);

    // Put the hoisted code on the first line to keep line numbers. The ";"
    // stops a "use strict" directive, which would break the assignments
    const combinedCode = `;${hoistedCode}
      ${finalCode}
      ${codeAddToGlobalScope}
      ${extraReturnCode}
    `;

    const asyncFunctionFactory = this._createScopedFunction(`
      return async function() {
        ${combinedCode}
      };
    `) as () => () => Promise<any>;
    const asyncFunction = asyncFunctionFactory.call(this._globalScope);

    return {
      asyncFunction,
      withReturn,
      docs: this._declarationDocs(code, ast, comments)
    };
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

      for (const node of ast.body) {
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
    const text = () => inspect(value, { colors: true });

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
      const source = safe(() => Function.prototype.toString.call(value), '');
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
   * Clean stack trace to remove internal frames.
   *
   * @param error - The error with stack trace to clean.
   * @returns The cleaned stack trace string.
   */
  cleanStackTrace(error: Error): string {
    const header = `${error.name}: ${error.message}`;
    const stack = error.stack || '';
    const lines = stack.split('\n');
    const userFrames: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      // Some browsers repeat `Name: message` as the first stack line.
      if (trimmed.startsWith(`${error.name}:`)) {
        continue;
      }

      // Stop once we reach internal executor frames.
      if (
        trimmed.includes('makeAsyncFromCode') ||
        trimmed.includes('new Function') ||
        trimmed.includes('asyncFunction')
      ) {
        break;
      }

      // Only keep lines that reference user eval code.
      if (RE_EVAL.test(trimmed) || trimmed.includes('<anonymous>')) {
        userFrames.push(line);
      }
    }

    if (userFrames.length > 0) {
      return `${header}\n${userFrames.join('\n')}`;
    }

    return header;
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
          this.getBuiltinDocumentation(expression)
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
    const scopeFunction = this._globalScope.Function;
    const functionConstructor =
      typeof scopeFunction === 'function'
        ? (scopeFunction as FunctionConstructor)
        : Function;
    return functionConstructor(...args) as JSCallable;
  }

  /**
   * Replace a section of code with new code.
   */
  private _replaceCode(
    code: string,
    start: number,
    end: number,
    newCode: string
  ): string {
    return code.substring(0, start) + newCode + code.substring(end);
  }

  /**
   * Collect identifiers from a declaration pattern.
   */
  private _collectDeclaredIdentifiers(
    pattern: any,
    identifiers: string[]
  ): void {
    if (!pattern) {
      return;
    }

    switch (pattern.type) {
      case 'Identifier':
        identifiers.push(pattern.name);
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
   * Get the names declared by a function, class or variable declaration.
   */
  private _declaredNames(node: any): string[] {
    const names: string[] = [];
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        this._collectDeclaredIdentifiers(declaration.id, names);
      }
    } else if (
      ['FunctionDeclaration', 'ClassDeclaration'].includes(node.type)
    ) {
      names.push(node.id.name);
    }
    return names;
  }

  /**
   * Whether a node declares a global that cannot hold any value, like `name`
   * or `location`.
   */
  private _declaresBuiltinGlobal(node: any): boolean {
    return this._declaredNames(node).some(name => {
      let scope = this._globalScope;
      while (scope) {
        const descriptor = Object.getOwnPropertyDescriptor(scope, name);
        if (descriptor) {
          return descriptor.writable !== true;
        }
        scope = Object.getPrototypeOf(scope);
      }
      return false;
    });
  }

  /**
   * Handle the last statement to auto-return if it's an expression.
   */
  private _handleLastStatement(
    code: string,
    ast: any
  ): {
    withReturn: boolean;
    modifiedUserCode: string;
    extraReturnCode: string;
  } {
    if (ast.body.length === 0) {
      return {
        withReturn: false,
        modifiedUserCode: code,
        extraReturnCode: ''
      };
    }

    const lastNode = ast.body[ast.body.length - 1];

    // If the last node is an expression statement (and not an assignment)
    if (
      lastNode.type === 'ExpressionStatement' &&
      lastNode.expression.type !== 'AssignmentExpression'
    ) {
      const lastNodeStart = lastNode.start;
      const lastNodeExprEnd = lastNode.expression.end;
      const lastNodeRestEnd = lastNode.end;

      // Check for semicolon after the expression
      let semicolonFound = false;
      for (let i = lastNodeExprEnd; i < lastNodeRestEnd; i++) {
        if (code[i] === ';') {
          semicolonFound = true;
          break;
        }
      }

      if (!semicolonFound) {
        // Remove the last node from the code, with the parentheses around
        // the expression, as in `({ a: 1 })`
        const modifiedUserCode =
          code.substring(0, lastNodeStart) + code.substring(lastNodeRestEnd);
        const codeOfLastNode = code.substring(lastNodeStart, lastNodeRestEnd);
        const extraReturnCode = `return ${codeOfLastNode};`;

        return {
          withReturn: true,
          modifiedUserCode,
          extraReturnCode
        };
      }
    }

    return {
      withReturn: false,
      modifiedUserCode: code,
      extraReturnCode: ''
    };
  }

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

    if (this._shouldAppendEsmSuffix(sourcePath)) {
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

    try {
      return new URL(normalizedPath, normalizedBase).toString();
    } catch {
      return `${normalizedBase}${normalizedPath}`;
    }
  }

  /**
   * Rewrite import statements to dynamic imports, and top-level declarations
   * to assignments to the global scope.
   */
  private _rewriteTopLevelStatements(
    code: string,
    ast: any
  ): {
    modifiedUserCode: string;
    codeAddToGlobalScope: string;
    hoistedCode: string;
  } {
    let modifiedUserCode = code;
    let codeAddToGlobalScope = '';
    const hoistedCode: string[] = [];

    // Process statements in reverse order to maintain correct positions
    for (let i = ast.body.length - 1; i >= 0; i--) {
      const node = ast.body[i];

      if (node.type === 'ImportDeclaration') {
        const importSource = this._transformImportSource(node.source.value);
        const importSourceCode = JSON.stringify(importSource);

        if (node.specifiers.length === 0) {
          // Side-effect import: import 'module'
          modifiedUserCode = this._replaceCode(
            modifiedUserCode,
            node.start,
            node.end,
            `await import(${importSourceCode});\n`
          );
        } else {
          let hasDefaultImport = false;
          let defaultImportName = '';
          let hasNamespaceImport = false;
          let namespaceImportName = '';
          const importedNames: string[] = [];
          const localNames: string[] = [];

          // Get imported and local names
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportSpecifier') {
              if (specifier.imported.name === 'default') {
                hasDefaultImport = true;
                defaultImportName = specifier.local.name;
              } else {
                importedNames.push(specifier.imported.name);
                localNames.push(specifier.local.name);
              }
            } else if (specifier.type === 'ImportDefaultSpecifier') {
              hasDefaultImport = true;
              defaultImportName = specifier.local.name;
            } else if (specifier.type === 'ImportNamespaceSpecifier') {
              hasNamespaceImport = true;
              namespaceImportName = specifier.local.name;
            }
          }

          const importBinding = `__jsKernelImport${i}`;
          let newCodeOfNode = `const ${importBinding} = await import(${importSourceCode});\n`;

          const destructuredNames: string[] = [];
          if (hasDefaultImport) {
            destructuredNames.push(`default: ${defaultImportName}`);
            codeAddToGlobalScope +=
              this._addToGlobalThisCode(defaultImportName);
          }

          if (importedNames.length > 0) {
            for (let j = 0; j < importedNames.length; j++) {
              // Handle aliased imports: import { foo as bar } -> const { foo: bar }
              destructuredNames.push(
                importedNames[j] !== localNames[j]
                  ? `${importedNames[j]}: ${localNames[j]}`
                  : importedNames[j]
              );
              // Use local name for globalThis assignment since that's what's in scope
              codeAddToGlobalScope += this._addToGlobalThisCode(localNames[j]);
            }
          }

          if (destructuredNames.length > 0) {
            newCodeOfNode += `const { ${destructuredNames.join(
              ', '
            )} } = ${importBinding};\n`;
          }

          if (hasNamespaceImport) {
            newCodeOfNode += `const ${namespaceImportName} = ${importBinding};\n`;
            codeAddToGlobalScope +=
              this._addToGlobalThisCode(namespaceImportName);
          }

          modifiedUserCode = this._replaceCode(
            modifiedUserCode,
            node.start,
            node.end,
            newCodeOfNode
          );
        }
      } else if (this._declaresBuiltinGlobal(node)) {
        // Keep the declaration local, and copy it at the end like imports
        for (const name of this._declaredNames(node)) {
          codeAddToGlobalScope += this._addToGlobalThisCode(name);
        }
      } else if (node.type === 'FunctionDeclaration') {
        // Assign the function before the code runs, using a hoisted factory
        const factoryName = `__jsKernelFunction${i}`;
        const functionCode = modifiedUserCode.substring(node.start, node.end);
        modifiedUserCode = this._replaceCode(
          modifiedUserCode,
          node.start,
          node.end,
          `function ${factoryName}() { return ${functionCode} }`
        );
        hoistedCode.unshift(`${node.id.name} = ${factoryName}();`);
      } else if (node.type === 'ClassDeclaration') {
        const classCode = modifiedUserCode.substring(node.start, node.end);
        modifiedUserCode = this._replaceCode(
          modifiedUserCode,
          node.start,
          node.end,
          `${node.id.name} = ${classCode};`
        );
      } else if (node.type === 'VariableDeclaration') {
        modifiedUserCode = this._replaceCode(
          modifiedUserCode,
          node.start,
          node.end,
          this._rewriteVariableDeclaration(modifiedUserCode, node)
        );
      }
    }

    return {
      modifiedUserCode,
      codeAddToGlobalScope,
      hoistedCode: hoistedCode.join(' ')
    };
  }

  /**
   * Rewrite a variable declaration to an assignment, e.g. `let a = 1, b;`
   * to `a = 1, b = undefined;`.
   */
  private _rewriteVariableDeclaration(code: string, node: any): string {
    const declarations = node.declarations;
    const lastDeclaration = declarations[declarations.length - 1];

    // Wrap patterns in parentheses, and pad to keep the columns
    const isPattern = declarations[0].id.type !== 'Identifier';
    let newCode = (isPattern ? ';(' : '').padEnd(node.kind.length);

    let position = node.start + node.kind.length;
    for (const declaration of declarations) {
      if (!declaration.init) {
        newCode += `${code.substring(position, declaration.end)} = undefined`;
        position = declaration.end;
      }
    }
    newCode += code.substring(position, lastDeclaration.end);
    newCode += isPattern ? ')' : '';
    newCode += code.substring(lastDeclaration.end, node.end);
    return newCode.endsWith(';') ? newCode : `${newCode};`;
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
        stack: safe(() => String(value.stack), '')
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
      const canvas = element as HTMLCanvasElement;
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

  private _introspection: Introspection | null = null;
  private _config: ExecutorConfig;
  private _globalScope: Record<string, any>;
}
