// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget } from './widget';

export class _SliderBase extends DOMWidget {
  protected override _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      min: 0,
      max: 100,
      step: 1,
      orientation: 'horizontal',
      readout: true,
      continuous_update: true,
      behavior: 'drag-tap'
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
  get orientation(): string {
    return this.get('orientation') as string;
  }
  set orientation(v: string) {
    this.set('orientation', v);
  }
  get readout(): boolean {
    return this.get('readout') as boolean;
  }
  set readout(v: boolean) {
    this.set('readout', v);
  }
  get continuous_update(): boolean {
    return this.get('continuous_update') as boolean;
  }
  set continuous_update(v: boolean) {
    this.set('continuous_update', v);
  }
  get behavior(): string {
    return this.get('behavior') as string;
  }
  set behavior(v: string) {
    this.set('behavior', v);
  }
}

export class _RangeSliderBase extends DOMWidget {
  protected override _defaults() {
    return {
      ...super._defaults(),
      value: [0, 1],
      min: 0,
      max: 100,
      step: 1,
      orientation: 'horizontal',
      readout: true,
      continuous_update: true,
      behavior: 'drag-tap'
    };
  }

  get value(): [number, number] {
    return this.get('value') as [number, number];
  }
  set value(v: [number, number]) {
    this.set('value', v);
  }
  get lower(): number {
    return this.value[0];
  }
  set lower(v: number) {
    this.value = [v, this.value[1]];
  }
  get upper(): number {
    return this.value[1];
  }
  set upper(v: number) {
    this.value = [this.value[0], v];
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
  get orientation(): string {
    return this.get('orientation') as string;
  }
  set orientation(v: string) {
    this.set('orientation', v);
  }
  get readout(): boolean {
    return this.get('readout') as boolean;
  }
  set readout(v: boolean) {
    this.set('readout', v);
  }
  get continuous_update(): boolean {
    return this.get('continuous_update') as boolean;
  }
  set continuous_update(v: boolean) {
    this.set('continuous_update', v);
  }
  get behavior(): string {
    return this.get('behavior') as string;
  }
  set behavior(v: string) {
    this.set('behavior', v);
  }
}

export class _ProgressBase extends DOMWidget {
  protected override _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      min: 0,
      max: 100,
      bar_style: '',
      orientation: 'horizontal'
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
  get bar_style(): string {
    return this.get('bar_style') as string;
  }
  set bar_style(v: string) {
    this.set('bar_style', v);
  }
  get orientation(): string {
    return this.get('orientation') as string;
  }
  set orientation(v: string) {
    this.set('orientation', v);
  }
}

export class _NumericTextBase extends DOMWidget {
  protected override _defaults() {
    return {
      ...super._defaults(),
      value: 0,
      step: 1,
      continuous_update: false
    };
  }

  get value(): number {
    return this.get('value') as number;
  }
  set value(v: number) {
    this.set('value', v);
  }
  get step(): number {
    return this.get('step') as number;
  }
  set step(v: number) {
    this.set('step', v);
  }
  get continuous_update(): boolean {
    return this.get('continuous_update') as boolean;
  }
  set continuous_update(v: boolean) {
    this.set('continuous_update', v);
  }
}
