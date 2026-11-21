import {
  NEWS_PUBLISHER_KIND,
  type NewsCategoryView,
  type NewsLocalizedName,
  type NewsPublisherKind,
  type NewsPublisherView,
} from '@mechanization/shared-schemas';

/**
 * Day3ati's answers, read into the views our screens take.
 *
 * Only the fields a screen uses are picked, so a field Day3ati adds later (a
 * publisher's `avatarUrl`, a signed link) never reaches a browser by accident.
 * An answer that is not what the contract says is `null`, and the caller turns
 * that into «News is unavailable»: a half-read list shown as the whole one is
 * worse than an error.
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function localizedName(value: unknown): NewsLocalizedName | null {
  if (!isObject(value) || typeof value.ar !== 'string') return null;
  return {
    ar: value.ar,
    en: typeof value.en === 'string' ? value.en : null,
    fr: typeof value.fr === 'string' ? value.fr : null,
  };
}

/** Day3ati's int32 arrives as a number, or as a digit string (its schema allows both). */
function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

export function toCategoryView(raw: unknown): NewsCategoryView | null {
  if (!isObject(raw)) return null;
  const name = localizedName(raw.name);
  const sortOrder = wholeNumber(raw.sortOrder);
  if (
    typeof raw.id !== 'string' ||
    typeof raw.key !== 'string' ||
    !name ||
    sortOrder === null ||
    typeof raw.isActive !== 'boolean'
  ) {
    return null;
  }
  return {
    id: raw.id,
    key: raw.key,
    name,
    icon: typeof raw.icon === 'string' ? raw.icon : null,
    sortOrder,
    isActive: raw.isActive,
  };
}

export function toPublisherView(raw: unknown): NewsPublisherView | null {
  if (!isObject(raw)) return null;
  const name = localizedName(raw.name);
  if (
    typeof raw.id !== 'string' ||
    !name ||
    typeof raw.isActive !== 'boolean' ||
    !(NEWS_PUBLISHER_KIND as readonly unknown[]).includes(raw.kind)
  ) {
    return null;
  }
  return { id: raw.id, name, kind: raw.kind as NewsPublisherKind, isActive: raw.isActive };
}

/** Every item read, or `null` when the answer is not a list or any item is not what the contract says. */
export function readAll<T>(raw: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const items: T[] = [];
  for (const entry of raw) {
    const item = read(entry);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}
