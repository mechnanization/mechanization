/**
 * «غير مؤكَّد» flags name a card by its position — `properties.2.neighborhood` —
 * among the registration's *current* cards, ordered by creation: the order the
 * edit form lists them in and submits them in.
 *
 * So a card leaving that list — deleted because a link created it, or ended
 * because the tenancy did — has to take its own flags with it and move every
 * later card's flags down one place. Skipped, the «غير مؤكَّد» on card 3 would
 * silently land on card 2.
 */
export function withoutCardFlags(
  flags: unknown,
  index: number,
): { flags: Array<Record<string, unknown>>; removed: Array<Record<string, unknown>>; changed: boolean } {
  const list = Array.isArray(flags) ? (flags as Array<Record<string, unknown>>) : [];
  if (index < 0) return { flags: list, removed: [], changed: false };

  const kept: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  let changed = false;

  for (const flag of list) {
    const match = typeof flag.path === 'string' ? /^properties\.(\d+)\.(.+)$/.exec(flag.path) : null;
    if (!match) {
      kept.push(flag);
      continue;
    }
    const position = Number(match[1]);
    if (position === index) {
      removed.push(flag);
      changed = true;
    } else if (position > index) {
      kept.push({ ...flag, path: `properties.${position - 1}.${match[2]}` });
      changed = true;
    } else {
      kept.push(flag);
    }
  }

  return { flags: kept, removed, changed };
}

/**
 * The same bookkeeping one level down: a row leaving card `cardIndex`'s list of
 * current rows, which a flag names by position — `properties.2.units.3.unitArea`
 * — in creation order, the order the edit form lists them in.
 *
 * Its own flags move to `toCardIndex` as that card's only row when the row is
 * moved onto a card of its own, and leave with it (reported in `removed`) when
 * the row simply ends. Every later row on the card moves down one place.
 */
export function withoutRowFlags(
  flags: unknown,
  input: { cardIndex: number; rowIndex: number; toCardIndex?: number | null },
): { flags: Array<Record<string, unknown>>; removed: Array<Record<string, unknown>>; changed: boolean } {
  const list = Array.isArray(flags) ? (flags as Array<Record<string, unknown>>) : [];
  if (input.cardIndex < 0 || input.rowIndex < 0) return { flags: list, removed: [], changed: false };

  const kept: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  let changed = false;

  for (const flag of list) {
    const match =
      typeof flag.path === 'string' ? /^properties\.(\d+)\.units\.(\d+)\.(.+)$/.exec(flag.path) : null;
    if (!match || Number(match[1]) !== input.cardIndex) {
      kept.push(flag);
      continue;
    }
    const row = Number(match[2]);
    if (row === input.rowIndex) {
      changed = true;
      if (input.toCardIndex != null) {
        kept.push({ ...flag, path: `properties.${input.toCardIndex}.units.0.${match[3]}` });
      } else {
        removed.push(flag);
      }
    } else if (row > input.rowIndex) {
      kept.push({ ...flag, path: `properties.${input.cardIndex}.units.${row - 1}.${match[3]}` });
      changed = true;
    } else {
      kept.push(flag);
    }
  }

  return { flags: kept, removed, changed };
}
