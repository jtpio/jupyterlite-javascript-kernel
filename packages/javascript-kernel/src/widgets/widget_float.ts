// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  _NumericTextBase,
  _ProgressBase,
  _RangeSliderBase,
  _SliderBase
} from './widget_number';

export class FloatSlider extends _SliderBase {
  static override modelName = 'FloatSliderModel';
  static override viewName = 'FloatSliderView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      max: 10.0,
      step: 0.1,
      readout_format: '.2f'
    };
  }

  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

export class FloatLogSlider extends _SliderBase {
  static override modelName = 'FloatLogSliderModel';
  static override viewName = 'FloatLogSliderView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      min: 0.0,
      max: 4.0,
      base: 10.0,
      value: 1.0,
      step: 0.1,
      readout_format: '.3g'
    };
  }

  get base(): number {
    return this.get('base') as number;
  }
  set base(v: number) {
    this.set('base', v);
  }
  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

export class FloatRangeSlider extends _RangeSliderBase {
  static override modelName = 'FloatRangeSliderModel';
  static override viewName = 'FloatRangeSliderView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: [0.0, 1.0],
      step: 0.1,
      readout_format: '.2f'
    };
  }

  get readout_format(): string {
    return this.get('readout_format') as string;
  }
  set readout_format(v: string) {
    this.set('readout_format', v);
  }
}

export class FloatProgress extends _ProgressBase {
  static override modelName = 'FloatProgressModel';
  static override viewName = 'ProgressView';

  protected override _defaults() {
    return { ...super._defaults(), max: 10.0 };
  }
}

export class FloatText extends _NumericTextBase {
  static override modelName = 'FloatTextModel';
  static override viewName = 'FloatTextView';

  protected override _defaults() {
    return { ...super._defaults(), value: 0.0, step: 0.1 };
  }
}

export class BoundedFloatText extends _NumericTextBase {
  static override modelName = 'BoundedFloatTextModel';
  static override viewName = 'FloatTextView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      value: 0.0,
      step: 0.1,
      min: 0.0,
      max: 100.0
    };
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
