import { describe, expect, it } from 'vitest';
import { sharpEdge } from '../../src/sharpen';

const photo = { width: 4032, height: 3024, thumbEdge: 640 };
// One photo per row on a 390px phone leaves a frame about this size.
const phoneLarge = { width: 336, height: 300 };

describe('sharp edge', () => {
  it('draws the preview for one photo per row on a 3x phone', () => {
    // 336 CSS px is 1008 device px, rounded up to 1024.
    expect(sharpEdge(photo, phoneLarge, 3)).toBe(1024);
  });

  it('keeps the thumbnail when it is close enough', () => {
    // 672 device px is within 15% of the 640px thumbnail.
    expect(sharpEdge(photo, phoneLarge, 2)).toBe(0);
    expect(sharpEdge(photo, { width: 160, height: 140 }, 2)).toBe(0);
  });

  it('uses the tighter side of the frame for portrait photos', () => {
    // The 300px height limits a portrait photo: 900 device px, rounded to 960.
    expect(sharpEdge({ width: 3024, height: 4032, thumbEdge: 640 }, phoneLarge, 3)).toBe(960);
  });

  it('never asks for more than the preview has', () => {
    expect(sharpEdge({ width: 800, height: 600, thumbEdge: 640 }, phoneLarge, 3)).toBe(800);
    expect(sharpEdge(photo, { width: 2000, height: 2000 }, 2)).toBe(2048);
  });

  it('skips photos whose preview is barely bigger than the thumbnail', () => {
    expect(sharpEdge({ width: 700, height: 500, thumbEdge: 640 }, phoneLarge, 3)).toBe(0);
    expect(sharpEdge({ width: 160, height: 120, thumbEdge: 640 }, phoneLarge, 3)).toBe(0);
  });

  it('treats images without thumbEdge as having 320px thumbnails', () => {
    expect(sharpEdge({ width: 4032, height: 3024 }, { width: 200, height: 200 }, 2)).toBe(448);
  });
});
