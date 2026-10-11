// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Edits of the code of a cell, with the map from the positions of the edited
// code to the positions of the code typed by the user, to show the locations
// of the errors in the cells.

/**
 * An edit of the source: the text replacing the range [start, end).
 */
interface IEdit {
  start: number;
  end: number;
  text: string;
  order: number;
}

/**
 * A run of the generated code: copied from the source, or written by an
 * edit, which maps to the start of the edited range.
 */
interface ISegment {
  genStart: number;
  genEnd: number;
  origStart: number;
  copied: boolean;
}

/**
 * Maps the offsets of the edited code to the offsets of the source.
 */
export class PositionMap {
  /**
   * Instantiate a map from its segments, sorted by generated offset.
   *
   * @internal
   */
  constructor(segments: ISegment[], sourceLength: number) {
    this._segments = segments;
    this._sourceLength = sourceLength;
  }

  /**
   * The map of a code which is not edited.
   */
  static identity(length: number): PositionMap {
    return new PositionMap(
      [{ genStart: 0, genEnd: length, origStart: 0, copied: true }],
      length
    );
  }

  /**
   * The offset in the source of an offset of the edited code. The positions
   * in the text written by an edit map to the start of the edited range.
   */
  toOriginal(genOffset: number): number {
    const segments = this._segments;
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (genOffset < segment.genStart) {
        high = middle - 1;
      } else if (genOffset >= segment.genEnd) {
        low = middle + 1;
      } else {
        return segment.copied
          ? segment.origStart + genOffset - segment.genStart
          : segment.origStart;
      }
    }
    return genOffset < 0 ? 0 : this._sourceLength;
  }

  private _segments: ISegment[];
  private _sourceLength: number;
}

/**
 * Edits of a source code, applied together. The positions are offsets in
 * the source, so the edits do not depend on each other.
 */
export class SourceEdits {
  /**
   * Instantiate the edits of a source code.
   */
  constructor(readonly source: string) {}

  /**
   * Insert a text at a position of the source. The texts inserted at the
   * same position keep their order.
   */
  insert(pos: number, text: string): void {
    this.replace(pos, pos, text);
  }

  /**
   * Replace the range [start, end) of the source with a text. The replaced
   * ranges must not overlap.
   */
  replace(start: number, end: number, text: string): void {
    this._edits.push({ start, end, text, order: this._edits.length });
  }

  /**
   * Apply the edits, and return the edited code with its position map.
   */
  apply(): { code: string; map: PositionMap } {
    const edits = [...this._edits].sort(
      (a, b) => a.start - b.start || a.order - b.order
    );
    const parts: string[] = [];
    const segments: ISegment[] = [];
    let length = 0;
    let cursor = 0;
    const push = (text: string, origStart: number, copied: boolean) => {
      if (text.length === 0) {
        return;
      }
      parts.push(text);
      segments.push({
        genStart: length,
        genEnd: length + text.length,
        origStart,
        copied
      });
      length += text.length;
    };
    for (const edit of edits) {
      if (edit.start < cursor) {
        throw new Error(
          `Overlapping edits at ${edit.start} of a code of ${this.source.length} characters`
        );
      }
      push(this.source.slice(cursor, edit.start), cursor, true);
      push(edit.text, edit.start, false);
      cursor = edit.end;
    }
    push(this.source.slice(cursor), cursor, true);
    return {
      code: parts.join(''),
      map: new PositionMap(segments, this.source.length)
    };
  }

  private _edits: IEdit[] = [];
}

/**
 * The offsets of the starts of the lines of a text. Like the JavaScript
 * engines, the lines end with \n, \r\n, \r, U+2028 or U+2029.
 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  const re = /\r\n?|[\n\u2028\u2029]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

/**
 * The line (1-based) and the column (0-based) of an offset of a text, from
 * the starts of its lines.
 */
export function offsetToLineColumn(
  starts: number[],
  offset: number
): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { line: low + 1, column: offset - starts[low] };
}
