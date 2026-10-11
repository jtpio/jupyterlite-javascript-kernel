// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  _NumericTextBase,
  _ProgressBase,
  _RangeSliderBase,
  _SliderBase
} from './widget_number';
import { DOMWidget } from './widget';

export class IntSlider extends _SliderBase {
  static override modelName = 'IntSliderModel';
  static override viewName = 'IntSliderView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      readout_format: 'd'
    };
  }

  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

export class IntRangeSlider extends _RangeSliderBase {
  static override modelName = 'IntRangeSliderModel';
  static override viewName = 'IntRangeSliderView';

  protected override _defaults() {
    return { ...super._defaults(), readout_format: 'd' };
  }

  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

export class Play extends DOMWidget {
  static override modelName = 'PlayModel';
  static override viewName = 'PlayView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      repeat: false,
      playing: false,
      show_repeat: true,
      interval: 100
    };
  }

  get value(): number {
    return this.get('value') as number;
  }
  set value(v: number) {
    this.set('value', v);
  }
  get min(): number {
    return this.get('min') as number;
  }
  set min(v: number) {
    this.set('min', v);
  }
  get max(): number {
    return this.get('max') as number;
  }
  set max(v: number) {
    this.set('max', v);
  }
  get step(): number {
    return this.get('step') as number;
  }
  set step(v: number) {
    this.set('step', v);
  }
  get repeat(): boolean {
    return this.get('repeat') as boolean;
  }
  set repeat(v: boolean) {
    this.set('repeat', v);
  }
  get playing(): boolean {
    return this.get('playing') as boolean;
  }
  set playing(v: boolean) {
    this.set('playing', v);
  }
  get show_repeat(): boolean {
    return this.get('show_repeat') as boolean;
  }
  set show_repeat(v: boolean) {
    this.set('show_repeat', v);
  }
  get interval(): number {
    return this.get('interval') as number;
  }
  set interval(v: number) {
    this.set('interval', v);
  }
}

export class IntProgress extends _ProgressBase {
  static override modelName = 'IntProgressModel';
  static override viewName = 'ProgressView';
}

export class IntText extends _NumericTextBase {
  static override modelName = 'IntTextModel';
  static override viewName = 'IntTextView';
}

export class BoundedIntText extends _NumericTextBase {
  static override modelName = 'BoundedIntTextModel';
  static override viewName = 'IntTextView';

  protected override _defaults() {
    return { ...super._defaults(), min: 0, max: 100 };
  }

  get min(): number {
    return this.get('min') as number;
  }
  set min(v: number) {
    this.set('min', v);
  }
  get max(): number {
    return this.get('max') as number;
  }
  set max(v: number) {
    this.set('max', v);
  }
}
