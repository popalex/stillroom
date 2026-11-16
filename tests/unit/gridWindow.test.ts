import { describe, expect, it } from 'vitest';
import { gridWindow } from '../../src/gridWindow';

// 100 cards in rows of 4 is 25 rows; 300px apart makes the grid 7500px tall.
const base = { count: 100, columns: 4, stride: 300, viewport: 900, overscan: 2 };

describe('grid window', () => {
  it('covers the top rows and pads for the rest while the grid starts below the screen top', () => {
    expect(gridWindow({ ...base, offset: -400 })).toEqual({
      start: 0,
      end: 16,
      before: 0,
      after: 21 * 300,
    });
  });
  it('keeps overscan rows on both sides in the middle of the grid', () => {
    // Rows 10 to 12 are on screen, so rows 8 to 14 render.
    const window = gridWindow({ ...base, offset: 3000 });
    expect(window).toEqual({ start: 32, end: 60, before: 8 * 300, after: 10 * 300 });
    expect(window.before + ((window.end - window.start) / 4) * 300 + window.after).toBe(7500);
  });
  it('stops at the last card of a partial last row', () => {
    expect(gridWindow({ ...base, count: 98, offset: 7000 })).toEqual({
      start: 84,
      end: 98,
      before: 21 * 300,
      after: 0,
    });
  });
  it('renders nothing past the end of a short grid', () => {
    expect(gridWindow({ ...base, count: 3, offset: 5000 })).toEqual({
      start: 3,
      end: 3,
      before: 300,
      after: 0,
    });
  });
});
