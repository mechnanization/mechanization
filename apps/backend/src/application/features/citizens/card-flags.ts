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
