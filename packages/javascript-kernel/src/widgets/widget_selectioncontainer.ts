// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { Widget } from './widget';
import { Box } from './widget_box';

class _SelectionContainer extends Box {
  constructor(
    state?: Record<string, unknown> & {
      children?: Widget[];
      titles?: string[];
    }
  ) {
    const next = { ...(state ?? {}) };
    const childCount = (next.children as Widget[] | undefined)?.length ?? 0;
    const titles = (next.titles as string[] | undefined) ?? [];
    const padded = [...titles];
    while (padded.length < childCount) {
      padded.push('');
    }
    next.titles = padded;
    super(next as Record<string, unknown> & { children?: Widget[] });
  }

  protected override _defaults() {
    return { ...super._defaults(), titles: [], selected_index: null };
  }

  get titles(): string[] {
    return this.get('titles') as string[];
  }
  set titles(v: string[]) {
    this.set('titles', v);
  }

  get selected_index(): number | null {
    return this.get('selected_index') as number | null;
  }
  set selected_index(v: number | null) {
    this.set('selected_index', v);
  }

  /**
   * Set the title of a container page.
   */
  setTitle(index: number, title: string): void {
    const next = [...this.titles];
    while (next.length <= index) {
      next.push('');
    }
    next[index] = title;
    this.titles = next;
  }

  /**
   * Get the title of a container page.
   */
  getTitle(index: number): string {
    return this.titles[index] ?? '';
  }
}

export class Accordion extends _SelectionContainer {
  static override modelName = 'AccordionModel';
  static override viewName = 'AccordionView';
}

export class Tab extends _SelectionContainer {
  static override modelName = 'TabModel';
  static override viewName = 'TabView';

  constructor(
    state?: Record<string, unknown> & {
      children?: Widget[];
      titles?: string[];
    }
  ) {
    const next = { ...(state ?? {}) };
    const children = (next.children as Widget[] | undefined) ?? [];
    if (children.length > 0 && next.selected_index === undefined) {
      next.selected_index = 0;
    }
    super(
      next as Record<string, unknown> & {
        children?: Widget[];
        titles?: string[];
      }
    );
  }
}

export class Stack extends _SelectionContainer {
  static override modelName = 'StackModel';
  static override viewName = 'StackView';
}
