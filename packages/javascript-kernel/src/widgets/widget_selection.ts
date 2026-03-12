// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget } from './widget';

class _SelectionBase extends DOMWidget {
  constructor(state?: Record<string, unknown> & { options?: string[] }) {
    const { options, ...rest } = state ?? {};
    if (options !== undefined) {
      (rest as Record<string, unknown>)._options_labels = options;
      if (rest.index === undefined) {
        (rest as Record<string, unknown>).index = options.length > 0 ? 0 : null;
      }
    }
    super(rest as Record<string, unknown>);
  }

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), _options_labels: [], index: null };
  }

  get options(): string[] {
    return this.get('_options_labels') as string[];
  }
  set options(v: string[]) {
    this.set({ _options_labels: v, index: v.length > 0 ? 0 : null });
  }
  get index(): number | null {
    return this.get('index') as number | null;
  }
  set index(v: number | null) {
    this.set('index', v);
  }
  get value(): string | null {
    return this.selectedLabel;
  }
  set value(v: string | null) {
    if (v === null) {
      this.index = null;
      return;
    }
    const idx = this.options.indexOf(v);
    this.index = idx === -1 ? null : idx;
  }
  get label(): string | null {
    return this.selectedLabel;
  }
  set label(v: string | null) {
    this.value = v;
  }

  /**
   * The label of the currently selected option, or null if none.
   */
  get selectedLabel(): string | null {
    const idx = this.index;
    if (idx === null || idx === undefined) {
      return null;
    }
    return this.options[idx] ?? null;
  }
}

class _MultipleSelectionBase extends DOMWidget {
  constructor(state?: Record<string, unknown> & { options?: string[] }) {
    const { options, ...rest } = state ?? {};
    if (options !== undefined) {
      (rest as Record<string, unknown>)._options_labels = options;
      if (rest.index === undefined) {
        (rest as Record<string, unknown>).index = [];
      }
    }
    super(rest as Record<string, unknown>);
  }

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), _options_labels: [], index: [] };
  }

  get options(): string[] {
    return this.get('_options_labels') as string[];
  }
  set options(v: string[]) {
    this.set({ _options_labels: v, index: [] });
  }
  get index(): number[] {
    return [...((this.get('index') as number[]) ?? [])];
  }
  set index(v: number[]) {
    this.set('index', [...v]);
  }
  get value(): string[] {
    return this.selectedLabels;
  }
  set value(v: string[]) {
    this.index = v
      .map(label => this.options.indexOf(label))
      .filter(idx => idx >= 0);
  }
  get label(): string[] {
    return this.selectedLabels;
  }
  set label(v: string[]) {
    this.value = v;
  }

  get selectedLabels(): string[] {
    return this.index.map(idx => this.options[idx]).filter(Boolean);
  }
}

export class Dropdown extends _SelectionBase {
  static override modelName = 'DropdownModel';
  static override viewName = 'DropdownView';
}

export class RadioButtons extends _SelectionBase {
  static override modelName = 'RadioButtonsModel';
  static override viewName = 'RadioButtonsView';
}

export class Select extends _SelectionBase {
  static override modelName = 'SelectModel';
  static override viewName = 'SelectView';

  protected override _defaults() {
    return { ...super._defaults(), rows: 5 };
  }

  get rows(): number {
    return this.get('rows') as number;
  }
  set rows(v: number) {
    this.set('rows', v);
  }
}

export class SelectMultiple extends _MultipleSelectionBase {
  static override modelName = 'SelectMultipleModel';
  static override viewName = 'SelectMultipleView';

  protected override _defaults() {
    return { ...super._defaults(), rows: 5 };
  }

  get rows(): number {
    return this.get('rows') as number;
  }
  set rows(v: number) {
    this.set('rows', v);
  }
}

export class ToggleButtons extends _SelectionBase {
  static override modelName = 'ToggleButtonsModel';
  static override viewName = 'ToggleButtonsView';

  protected override _defaults() {
    return { ...super._defaults(), tooltips: [], button_style: '', icons: [] };
  }

  get tooltips(): string[] {
    return this.get('tooltips') as string[];
  }
  set tooltips(v: string[]) {
    this.set('tooltips', v);
  }
  get button_style(): string {
    return this.get('button_style') as string;
  }
  set button_style(v: string) {
    this.set('button_style', v);
  }
  get icons(): string[] {
    return this.get('icons') as string[];
  }
  set icons(v: string[]) {
    this.set('icons', v);
  }
}

export class SelectionSlider extends _SelectionBase {
  static override modelName = 'SelectionSliderModel';
  static override viewName = 'SelectionSliderView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      orientation: 'horizontal',
      readout: true,
      continuous_update: true,
      behavior: 'drag-tap'
    };
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

export class SelectionRangeSlider extends _MultipleSelectionBase {
  static override modelName = 'SelectionRangeSliderModel';
  static override viewName = 'SelectionRangeSliderView';

  constructor(state?: Record<string, unknown> & { options?: string[] }) {
    const next = { ...(state ?? {}) };
    const options = next.options as string[] | undefined;
    if (options && next.index === undefined) {
      next.index = options.length > 0 ? [0, 0] : [];
    }
    super(next as Record<string, unknown> & { options?: string[] });
  }

  protected override _defaults(): Record<string, unknown> {
    return {
      ...super._defaults(),
      index: [0, 0],
      orientation: 'horizontal',
      readout: true,
      continuous_update: true,
      behavior: 'drag-tap'
    };
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
