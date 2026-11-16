import { describe, expect, it } from 'vitest';
import type { Catalog, ImageEntry } from '../../shared/protocol';
import { categoryName, deleteImages, moveImages, resolveChoice } from '../../src/categories';

const image = (id: string, category: string) =>
  ({
    id,
    name: `${id}.png`,
    category,
    original: { id: `${id}-o` },
    thumbnail: { id: `${id}-t` },
    preview: { id: `${id}-p` },
  }) as ImageEntry;
const catalog: Catalog = {
  v: 1,
  categories: ['Walks', 'Trips'],
  images: [image('a', ''), image('b', 'Walks'), image('c', 'Walks'), image('d', 'Trips')],
};
const categories = (result: Catalog) => result.images.map((i) => [i.id, i.category]);

describe('category names', () => {
  it('trims a new name', () => {
    expect(categoryName('  Garden  ', catalog.categories)).toBe('Garden');
  });
  it('rejects blank, overlong, reserved, and existing names', () => {
    for (const name of ['   ', 'x'.repeat(81), 'All', ' uncategorized ', 'Walks'])
      expect(() => categoryName(name, catalog.categories)).toThrow();
  });
  it('resolves an existing choice without validating the unused new name', () => {
    expect(
      resolveChoice({ category: 'Trips', creating: false, newName: 'all' }, catalog.categories),
    ).toEqual({ category: 'Trips', added: undefined });
    expect(
      resolveChoice({ category: 'Trips', creating: true, newName: ' Garden ' }, catalog.categories),
    ).toEqual({ category: 'Garden', added: 'Garden' });
  });
});

describe('moving images', () => {
  it('moves only the chosen images and leaves the catalog untouched', () => {
    const moved = moveImages(catalog, new Set(['a', 'c']), 'Trips');
    expect(categories(moved)).toEqual([
      ['a', 'Trips'],
      ['b', 'Walks'],
      ['c', 'Trips'],
      ['d', 'Trips'],
    ]);
    expect(moved.categories).toBe(catalog.categories);
    expect(categories(catalog)[0]).toEqual(['a', '']);
  });
  it('adds a new category once and moves images into it', () => {
    const moved = moveImages(catalog, new Set(['b', 'd']), 'Garden', 'Garden');
    expect(moved.categories).toEqual(['Walks', 'Trips', 'Garden']);
    expect(categories(moved).filter(([, c]) => c === 'Garden')).toEqual([
      ['b', 'Garden'],
      ['d', 'Garden'],
    ]);
  });
  it('moves images to Uncategorized and ignores unknown ids', () => {
    const moved = moveImages(catalog, new Set(['b', 'gone']), '');
    expect(categories(moved)).toEqual([
      ['a', ''],
      ['b', ''],
      ['c', 'Walks'],
      ['d', 'Trips'],
    ]);
    expect(moved.images).toHaveLength(4);
  });
});

describe('deleting images', () => {
  it('drops the chosen images and lists their three files each', () => {
    const { catalog: left, objects } = deleteImages(catalog, new Set(['b', 'd', 'gone']));
    expect(left.images.map((i) => i.id)).toEqual(['a', 'c']);
    expect(left.categories).toBe(catalog.categories);
    expect(objects).toEqual(['b-o', 'b-t', 'b-p', 'd-o', 'd-t', 'd-p']);
    expect(catalog.images).toHaveLength(4);
  });
  it('changes nothing for an empty selection', () => {
    const { catalog: left, objects } = deleteImages(catalog, new Set());
    expect(left.images).toEqual(catalog.images);
    expect(objects).toEqual([]);
  });
});
