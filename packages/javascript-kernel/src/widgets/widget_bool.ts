// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget } from './widget';

export class Checkbox extends DOMWidget {
  static override modelName = 'CheckboxModel';
  static override viewName = 'CheckboxView';

  protected override _defaults() {
    return { ...super._defaults(), value: false, indent: true };
  }

  get value(): boolean {
    return this.get('value') as boolean;
  }
  set value(v: boolean) {
    this.set('value', v);
  }
  get indent(): boolean {
    return this.get('indent') as boolean;
  }
  set indent(v: boolean) {
    this.set('indent', v);
  }
}

export class ToggleButton extends DOMWidget {
  static override modelName = 'ToggleButtonModel';
  static override viewName = 'ToggleButtonView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: false,
      tooltip: '',
      icon: '',
      button_style: ''
    };
  }

  get value(): boolean {
    return this.get('value') as boolean;
  }
  set value(v: boolean) {
    this.set('value', v);
  }
  get tooltip(): string {
    return this.get('tooltip') as string;
  }
  set tooltip(v: string) {
    this.set('tooltip', v);
  }
  get icon(): string {
    return this.get('icon') as string;
  }
  set icon(v: string) {
    this.set('icon', v);
  }
  get button_style(): string {
    return this.get('button_style') as string;
  }
  set button_style(v: string) {
    this.set('button_style', v);
  }
}

export class Valid extends DOMWidget {
  static override modelName = 'ValidModel';
  static override viewName = 'ValidView';

  protected override _defaults() {
    return { ...super._defaults(), value: false, readout: 'Invalid' };
  }

  get value(): boolean {
    return this.get('value') as boolean;
  }
  set value(v: boolean) {
    this.set('value', v);
  }
  get readout(): string {
    return this.get('readout') as string;
  }
  set readout(v: string) {
    this.set('readout', v);
  }
}
