// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget } from './widget';

export class ColorPicker extends DOMWidget {
  static override modelName = 'ColorPickerModel';
  static override viewName = 'ColorPickerView';

  protected override _defaults() {
    return { ...super._defaults(), value: '#000000', concise: false };
  }

  get value(): string {
    return this.get('value') as string;
  }
  set value(v: string) {
    this.set('value', v);
  }
  get concise(): boolean {
    return this.get('concise') as boolean;
  }
  set concise(v: boolean) {
    this.set('concise', v);
  }
}
