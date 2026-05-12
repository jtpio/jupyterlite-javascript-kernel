// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget } from './widget';

class _TextBase extends DOMWidget {
  protected override _defaults() {
    return {
      ...super._defaults(),
      value: '',
      placeholder: '',
      continuous_update: true
    };
  }

  get value(): string {
    return this.get('value') as string;
  }
  set value(v: string) {
    this.set('value', v);
  }
  get placeholder(): string {
    return this.get('placeholder') as string;
  }
  set placeholder(v: string) {
    this.set('placeholder', v);
  }
  get continuous_update(): boolean {
    return this.get('continuous_update') as boolean;
  }
  set continuous_update(v: boolean) {
    this.set('continuous_update', v);
  }
}

export class Text extends _TextBase {
  static override modelName = 'TextModel';
  static override viewName = 'TextView';
}

export class Textarea extends _TextBase {
  static override modelName = 'TextareaModel';
  static override viewName = 'TextareaView';
}

export class Password extends _TextBase {
  static override modelName = 'PasswordModel';
  static override viewName = 'PasswordView';
}

export class Combobox extends _TextBase {
  static override modelName = 'ComboboxModel';
  static override viewName = 'ComboboxView';

  constructor(state?: Record<string, unknown> & { options?: string[] }) {
    const { options, ...rest } = state ?? {};
    if (options !== undefined) {
      (rest as Record<string, unknown>).options = options;
    }
    super(rest as Record<string, unknown>);
  }

  protected override _defaults() {
    return { ...super._defaults(), options: [], ensure_option: false };
  }

  get options(): string[] {
    return this.get('options') as string[];
  }
  set options(v: string[]) {
    this.set('options', v);
  }
  get ensure_option(): boolean {
    return this.get('ensure_option') as boolean;
  }
  set ensure_option(v: boolean) {
    this.set('ensure_option', v);
  }
}

class _DisplayBase extends DOMWidget {
  protected override _defaults() {
    return { ...super._defaults(), value: '' };
  }

  get value(): string {
    return this.get('value') as string;
  }
  set value(v: string) {
    this.set('value', v);
  }
}

export class Label extends _DisplayBase {
  static override modelName = 'LabelModel';
  static override viewName = 'LabelView';
}

export class HTML extends _DisplayBase {
  static override modelName = 'HTMLModel';
  static override viewName = 'HTMLView';
}

export class HTMLMath extends _DisplayBase {
  static override modelName = 'HTMLMathModel';
  static override viewName = 'HTMLMathView';
}
