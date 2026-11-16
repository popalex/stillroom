import { useLayoutEffect, useState, type RefObject } from 'react';

export type GridWindow = { start: number; end: number; before: number; after: number };

// Which cards of a grid with `count` cards in rows of `columns`, each row
// `stride` pixels apart, fall within `overscan` rows of the viewport. `offset`
// is how far the viewport's top sits below the grid's first row, negative while
// the grid starts lower on the screen. `before` and `after` are the heights the
// rows outside the window would take, kept as padding so the page height and
// scroll position stay as if every card were there.
export function gridWindow({
  count,
  columns,
  stride,
  offset,
  viewport,
  overscan,
}: {
  count: number;
  columns: number;
  stride: number;
  offset: number;
  viewport: number;
  overscan: number;
}): GridWindow {
  const rows = Math.ceil(count / columns);
  const clamp = (row: number) => Math.min(rows, Math.max(0, row));
  const first = clamp(Math.floor(offset / stride) - overscan),
    last = clamp(Math.ceil((offset + viewport) / stride) + overscan);
  return {
    start: Math.min(count, first * columns),
    end: Math.min(count, last * columns),
    before: first * stride,
    after: Math.max(0, rows - last) * stride,
  };
}

// Enough cards to fill a tall screen before the first measurement.
const FIRST_RENDER = 48;
// Rows kept beyond each edge of the screen, so a fast scroll or a thumbnail
// that starts loading 250px early still finds its card in place.
const OVERSCAN = 3;

// Renders only the rows of `grid` near the screen. The page scrolls, not the
// grid, so this follows window scrolling and resizing, and any change in the
// grid's own size. Every row must be the same height: the first card's height
// plus the grid's row gap gives the stride.
export function useGridWindow(grid: RefObject<HTMLElement | null>, count: number, key: unknown) {
  const [window_, setWindow] = useState<GridWindow>(() => ({
    start: 0,
    end: Math.min(count, FIRST_RENDER),
    before: 0,
    after: 0,
  }));
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const style = getComputedStyle(element);
      const card = element.firstElementChild;
      const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
      const stride = card ? card.getBoundingClientRect().height + parseFloat(style.rowGap) : 0;
      const next = stride
        ? gridWindow({
            count,
            columns,
            stride,
            offset: -element.getBoundingClientRect().top,
            viewport: innerHeight,
            overscan: OVERSCAN,
          })
        : { start: 0, end: Math.min(count, FIRST_RENDER), before: 0, after: 0 };
      setWindow((current) =>
        current.start === next.start &&
        current.end === next.end &&
        current.before === next.before &&
        current.after === next.after
          ? current
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    const resized = new ResizeObserver(schedule);
    resized.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
      resized.disconnect();
    };
  }, [grid, count, key]);
  return window_;
}
