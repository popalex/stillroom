import { useEffect, useState, type RefObject } from 'react';
import type { ImageEntry } from '../shared/protocol';
import { fetchObject } from './api';
import { decryptObject, type VaultKey } from './crypto/vault';
import { PREVIEW_EDGE } from './images';

// Grid cards show the 640-pixel thumbnail. Some frames need more pixels than
// that: one photo per row on a phone, or wide Large columns on a high-density
// screen. Those draw the 2048-pixel preview instead, scaled down to the frame.
// Smaller frames never load it, so dense grids hold only thumbnails.

// The thumbnail is used until the frame needs at least this much more.
const MARGIN = 1.15;
// Frame sizes round up to this step, so small resizes don't redraw.
const STEP = 64;

// The longest edge, in device pixels, to draw the preview at in a frame of
// `frame` CSS pixels, or 0 when the thumbnail is sharp enough.
export function sharpEdge(
  image: Pick<ImageEntry, 'width' | 'height' | 'thumbEdge'>,
  frame: { width: number; height: number },
  density: number,
) {
  const long = Math.max(image.width, image.height);
  // Images stored before thumbEdge existed have 320-pixel thumbnails.
  const thumbnail = Math.min(long, image.thumbEdge ?? 320);
  const preview = Math.min(long, PREVIEW_EDGE);
  // The frame letterboxes the photo, so its tighter side sets the scale.
  const scale = Math.min(frame.width / image.width, frame.height / image.height);
  const needed = Math.ceil((long * scale * density) / STEP) * STEP;
  const edge = Math.min(needed, preview);
  return edge > thumbnail * MARGIN ? edge : 0;
}

// Decoding briefly holds the whole preview, about 12 MB at 2048 by 1536, so
// only two decode at once.
const LANES = 2;
let running = 0;
const waiting: (() => void)[] = [];
async function inLane<T>(signal: AbortSignal, work: () => Promise<T>) {
  if (running >= LANES) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    signal.throwIfAborted();
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// Draws the preview into `canvas` when the card's `frame` needs it. `edge` says
// whether the card should render the canvas, and `drawn` whether it has
// something to show yet; until then the thumbnail stays.
export function useSharpImage(
  image: ImageEntry,
  vault: VaultKey,
  enabled: boolean,
  frame: RefObject<HTMLElement | null>,
  canvas: RefObject<HTMLCanvasElement | null>,
) {
  const [edge, setEdge] = useState(0),
    [preview, setPreview] = useState<Blob | null>(null),
    [drawn, setDrawn] = useState(false);
  const { width, height, thumbEdge } = image;
  useEffect(() => {
    const element = frame.current;
    if (!enabled || !element) {
      setEdge(0);
      return;
    }
    const observer = new ResizeObserver(([entry]) =>
      setEdge(sharpEdge({ width, height, thumbEdge }, entry.contentRect, devicePixelRatio)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, frame, width, height, thumbEdge]);

  const wanted = edge > 0;
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    const target = canvas.current;
    void (async () => {
      try {
        const data = await fetchObject(image.preview.id, controller.signal, 'low');
        const plain = await decryptObject(vault, image.preview, data);
        controller.signal.throwIfAborted();
        setPreview(new Blob([plain], { type: 'image/webp' }));
        plain.fill(0);
      } catch {
        // The thumbnail stays on screen.
      }
    })();
    return () => {
      controller.abort();
      setPreview(null);
      setDrawn(false);
      // Safari keeps a canvas's pixels after it leaves the page unless it is
      // shrunk first.
      if (target) target.width = target.height = 0;
    };
  }, [wanted, image.preview, vault, canvas]);

  useEffect(() => {
    const target = canvas.current;
    if (!preview || !edge || !target) return;
    const controller = new AbortController();
    inLane(controller.signal, async () => {
      const bitmap = await createImageBitmap(preview);
      try {
        controller.signal.throwIfAborted();
        const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        target.width = Math.max(1, Math.round(bitmap.width * scale));
        target.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = target.getContext('2d');
        if (!context) return;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, target.width, target.height);
        setDrawn(true);
      } finally {
        bitmap.close();
      }
    }).catch(() => {
      // The thumbnail stays on screen.
    });
    return () => controller.abort();
  }, [preview, edge, canvas]);

  return { edge, drawn };
}
