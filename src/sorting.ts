import type { ImageEntry, SortOrder } from '../shared/protocol';

const filenames = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function sortImages<T extends Pick<ImageEntry, 'id' | 'name' | 'added'>>(
  images: T[],
  order: SortOrder,
): T[] {
  const direction = order.endsWith('asc') ? 1 : -1;
  return images.toSorted((a, b) => {
    const compared = order.startsWith('name')
      ? filenames.compare(a.name, b.name)
      : Date.parse(a.added) - Date.parse(b.added);
    return direction * compared || a.id.localeCompare(b.id);
  });
}
