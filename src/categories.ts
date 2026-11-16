import type { Catalog } from '../shared/protocol';

// Checks a typed category name against the reserved filter names and the
// existing categories, and returns it trimmed.
export function categoryName(value: string, categories: string[]) {
  const name = value.trim();
  if (!name || name.length > 80 || ['all', 'uncategorized'].includes(name.toLowerCase()))
    throw new Error('Choose a different category name.');
  if (categories.includes(name)) throw new Error('That category already exists.');
  return name;
}

// What a CategoryPicker holds: an existing category ('' is Uncategorized), or the
// name typed for a new one.
export type CategoryChoice = { category: string; creating: boolean; newName: string };

// The category to assign, plus the validated name to add first when the choice
// is a new category. Throws if that name is unusable.
export function resolveChoice(choice: CategoryChoice, categories: string[]) {
  if (!choice.creating) return { category: choice.category, added: undefined };
  const added = categoryName(choice.newName, categories);
  return { category: added, added };
}

// Puts every image in `ids` into `category`, adding `added` to the category list
// first. Ids that are not in the catalog are ignored.
export function moveImages(
  catalog: Catalog,
  ids: ReadonlySet<string>,
  category: string,
  added?: string,
): Catalog {
  return {
    ...catalog,
    categories: added ? [...catalog.categories, added] : catalog.categories,
    images: catalog.images.map((image) => (ids.has(image.id) ? { ...image, category } : image)),
  };
}
