import { describe, expect, it } from 'vitest';
import { sortImages } from '../../src/sorting';

describe('gallery sorting', () => {
  const images = [
    { id: 'c', name: 'photo10.png', added: '2026-09-02T00:00:00.000Z' },
    { id: 'a', name: 'Alpha.png', added: '2026-09-03T00:00:00.000Z' },
    { id: 'b', name: 'photo2.png', added: '2026-09-01T00:00:00.000Z' },
  ];
  it('uses natural filename order in both directions', () => {
    expect(sortImages(images, 'name-asc').map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(sortImages(images, 'name-desc').map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });
  it('orders dates independently of upload array order and filenames', () => {
    expect(sortImages(images, 'date-asc').map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(sortImages(images, 'date-desc').map((i) => i.id)).toEqual(['a', 'c', 'b']);
    expect(images.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
  it('breaks equal names and dates consistently without changing the catalog', () => {
    const duplicates = [
      { ...images[0], id: 'b' },
      { ...images[0], id: 'a', name: 'PHOTO10.png' },
    ];
    expect(sortImages(duplicates, 'name-asc').map((i) => i.id)).toEqual(['a', 'b']);
    expect(sortImages(duplicates, 'date-desc').map((i) => i.id)).toEqual(['a', 'b']);
  });
});
