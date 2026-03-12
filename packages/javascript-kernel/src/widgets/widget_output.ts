// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget } from './widget';
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
    this.set('outputs', [...v]);
  }

  get currentMessageId(): string | null {
    return this._manager.getCurrentMessageId();
  }

  clearOutput(_options: { wait?: boolean } = {}): void {
    this.outputs = [];
  }

  appendStdout(text: string): void {
    this._appendOutput({ output_type: 'stream', name: 'stdout', text });
  }

  appendStderr(text: string): void {
    this._appendOutput({ output_type: 'stream', name: 'stderr', text });
  }

  appendDisplayData(
    data: Record<string, unknown>,
    metadata: Record<string, unknown> = {}
  ): void {
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

  private _appendOutput(output: Record<string, unknown>): void {
    this.outputs = [...this.outputs, output];
  }

  private _captureWrapper<T extends (...args: any[]) => any>(
    callback: T,
    options: IOutputCaptureOptions
  ): T {
    return _wrapCapturedOutputCallback(this, callback, options);
  }

  _captureDepth = 0;
}

function _wrapCapturedOutputCallback<T extends (...args: any[]) => any>(
  output: Output,
  callback: T,
  options: IOutputCaptureOptions
): T {
  return function (this: unknown, ...args: any[]): any {
    const shouldClear = options.clearOutput ?? false;
    if (shouldClear) {
      output.clearOutput({ wait: options.wait });
    }

    const messageId = output.currentMessageId;
    if (messageId) {
      if (output._captureDepth === 0) {
        output.msg_id = messageId;
      }
      output._captureDepth += 1;
    }

    const finish = (): void => {
      if (!messageId) {
        return;
      }
      output._captureDepth = Math.max(0, output._captureDepth - 1);
      if (output._captureDepth === 0 && output.msg_id === messageId) {
        output.msg_id = '';
      }
    };

    try {
      const result = callback.apply(this, args);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return Promise.resolve(result).finally(finish);
      }
      finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  } as T;
}
