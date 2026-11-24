import { isNonPersonRecord, type CitizenResidence } from '@mechanization/shared-schemas';
import { reindexFlags, reindexRowFlags } from '@/lib/citizen-form-askable';
import type { CardRemovalAnswer, CitizenFormValues, PropertyDraft } from '@/lib/citizen-form-values';

/*
  The citizen form's state transitions, as plain functions (GOD-22, phase 2c,
  2026-11-24).

  Each is the body of a `setValues((current) => …)` updater that used to sit
  inside `CitizenForm`, moved here with its text unchanged and given a name, so
  it can be tested without rendering a form. The component still decides *when*
  one runs; none of them reads or writes anything but its arguments.

  A function that has nothing to change returns the very object it was given,
  where the updater did (`withEndedRowsRemoved`): React bails out of a state
  update that returns the same reference, and a copy would re-render the form
  and re-fire its draft write for nothing.
*/

/**
 * Raise or amend a «غير مؤكَّد» flag — and empty the field it covers.
 *
 * Clearing the value is the substantive half. A flag says the value was
 * never established; leaving a half-typed number underneath it would make
 * the record contradict itself, and — because the server strips flagged
 * fields before it validates anything — would be discarded on arrival
 * anyway. Doing it here means what the officer sees is what gets stored.
 *
 * Amending an existing flag (typing in its reason box) does not re-clear,
 * because there is nothing left to clear; the same code path handles both
 * since clearing an already-empty field is a no-op.
 */
export function withFlag(current: CitizenFormValues, path: string, reason: string): CitizenFormValues {
  const flags = new Map(current.flags);
  flags.set(path, reason);

  const [section, ...rest] = path.split('.');

  if (section === 'personal' || section === 'contact') {
    const field = rest[0];
    const next = { ...current[section] };
    delete next[field];
    return { ...current, [section]: next, flags };
  }

  // properties.<index>.<field>
  const index = Number(rest[0]);
  const field = rest[1];
  return {
    ...current,
    properties: current.properties.map((property, i) => {
      if (i !== index) return property;
      const next = { ...property } as Record<string, unknown>;
      delete next[field];
      return next as PropertyDraft;
    }),
    flags,
  };
}

/** Withdraws a flag. The field comes back empty, which is where it was. */
export function withoutFlag(current: CitizenFormValues, path: string): CitizenFormValues {
  const flags = new Map(current.flags);
  flags.delete(path);
  return { ...current, flags };
}

/**
 * The flags the «خانات غير مؤكَّدة» dialog saved, and the fields they cover
 * emptied: a field newly flagged has its value cleared, as `withFlag` does for
 * one.
 */
export function withFlagsApplied(current: CitizenFormValues, newFlags: Map<string, string>): CitizenFormValues {
  let updated = { ...current, flags: newFlags };
  // If a field is newly flagged, clear its value in current state
  for (const path of newFlags.keys()) {
    const [section, ...rest] = path.split('.');
    if (section === 'personal' || section === 'contact') {
      const field = rest[0];
      const nextSec = { ...updated[section] };
      delete nextSec[field];
      updated = { ...updated, [section]: nextSec };
    } else if (section === 'properties') {
      const idx = Number(rest[0]);
      const field = rest[1];
      updated = {
        ...updated,
        properties: updated.properties.map((p, i) => {
          if (i !== idx) return p;
          const nextP = { ...p } as Record<string, unknown>;
          delete nextP[field];
          return nextP as PropertyDraft;
        }),
      };
    }
  }
  return updated;
}

/**
 * One card, updated from whatever it currently is.
 *
 * Takes an updater rather than a finished `PropertyDraft`, and that is a
 * correctness fix rather than a style preference: two writes landing before
 * React re-rendered used to spread the same stale copy, and the second silently
 * reverted the first (a building linked on a card, then its name copied down).
 * `p` is whatever the card holds at the moment the update runs, so writes compose.
 */
export function withProperty(
  current: CitizenFormValues,
  index: number,
  update: (current: PropertyDraft) => PropertyDraft,
): CitizenFormValues {
  return {
    ...current,
    properties: current.properties.map((p, i) => (i === index ? update(p) : p)),
  };
}

/**
 * A new card.
 *
 * `sameParcelAs` carries the parcel's own identity across — رقم العقار and
 * الحي — for one deed carrying a building, the house behind it and a shop on
 * the street: three structures, one piece of land. The owner is not copied
 * because the owner was never on the card.
 */
export function withAddedProperty(current: CitizenFormValues, sameParcelAs?: number): CitizenFormValues {
  const source = sameParcelAs === undefined ? undefined : current.properties[sameParcelAs];

  const properties = [
    ...current.properties,
    {
      // A clerk entering several properties for one household fills the same
      // shape repeatedly, so a new card inherits the last one's occupancy.
      occupancyType:
        current.residence === 'ESTATE' ? 'OWNER' : (source ?? current.properties.at(-1))?.occupancyType,
      ...(source
        ? { propertyNumber: source.propertyNumber, neighborhood: source.neighborhood }
        : {}),
    },
  ];
  return { ...current, properties };
}

/** Which cards are folded once a card is added: every one but the new last. */
export function collapsedAfterAdd(properties: readonly unknown[]): Set<number> {
  return new Set(properties.slice(0, -1).map((_, i) => i));
}

/**
 * Card `index` taken out, with what has to follow it.
 *
 * The officer's answer to «why is it going» travels with the save, keyed by the
 * card's id — the only thing that still names it once it has left the list.
 * Flags are addressed by card index, so deleting a card renumbers them: left
 * alone, a flag on \`properties.2.propertyNumber\` would silently become a flag on
 * whatever card slid into position 2. The server's «بانتظار التحقق» notes are
 * addressed the same way and renumbered with them.
 */
export function withRemovedProperty(
  current: CitizenFormValues,
  index: number,
  answer?: CardRemovalAnswer,
): CitizenFormValues {
  return {
    ...current,
    properties: current.properties.filter((_, i) => i !== index),
    ...(answer && current.properties[index]?.id
      ? {
          removals: [
            ...(current.removals ?? []).filter(
              (removal) => removal.propertyId !== current.properties[index]!.id,
            ),
            { propertyId: current.properties[index]!.id!, ...answer },
          ],
        }
      : {}),
    flags: reindexFlags(current.flags, index),
    unverified: reindexFlags(current.unverified, index),
  };
}

/**
 * Indices above the removed card shift down by one; rebuilding the set rather
 * than deleting from it keeps the wrong card from folding shut.
 */
export function collapsedAfterRemoval(current: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set<number>();
  for (const i of current) {
    if (i < index) next.add(i);
    else if (i > index) next.add(i - 1);
  }
  return next;
}

/**
 * Rows of card \`index\` that «إنهاء الإيجار» just ended while the card goes on.
 *
 * Taken out of the form by id rather than left for the officer to notice: a
 * save carrying them would name rows that have ended, which the server refuses.
 * Flags on those rows go with them; later rows' flags move up. Returns
 * \`current\` itself when there is nothing to take out.
 */
export function withEndedRowsRemoved(
  current: CitizenFormValues,
  index: number,
  rowIds: readonly string[],
): CitizenFormValues {
  const card = current.properties[index];
  const units = card?.units ?? [];
  const positions = units
    .map((unit, position) => (unit.id && rowIds.includes(unit.id) ? position : -1))
    .filter((position) => position >= 0)
    .sort((a, b) => b - a);
  if (!card || positions.length === 0) return current;

  let flags: Map<string, string> = new Map(current.flags);
  let unverified: Map<string, string> = new Map(current.unverified);
  for (const position of positions) {
    flags = reindexRowFlags(flags, index, position);
    unverified = reindexRowFlags(unverified, index, position);
  }
  return {
    ...current,
    properties: current.properties.map((property, i) =>
      i === index
        ? { ...property, units: units.filter((unit) => !(unit.id && rowIds.includes(unit.id))) }
        : property,
    ),
    flags,
    unverified,
  };
}

/** One parcel: its رقم العقار (null for a card with none) and the cards on it, by index. */
export interface PropertyGroup {
  propertyNumber: string | null;
  indices: number[];
}

/**
 * Property cards grouped by shared رقم العقار.
 *
 * A parcel with a building, the house behind it and a shop on the street is
 * one عقار holding three cards — array position doesn't say that, matching
 * رقم العقار values do. A group of one (the ordinary case) still renders as a
 * single plain card.
 */
export function groupProperties(
  properties: readonly PropertyDraft[],
): PropertyGroup[] {
  const groups: PropertyGroup[] = [];
  const groupByNumber = new Map<string, number>();
  properties.forEach((property, index) => {
    const propertyNumber = property.propertyNumber?.trim() || null;
    const groupIndex = propertyNumber ? groupByNumber.get(propertyNumber) : undefined;
    if (groupIndex !== undefined) {
      groups[groupIndex].indices.push(index);
      return;
    }
    if (propertyNumber) groupByNumber.set(propertyNumber, groups.length);
    groups.push({ propertyNumber, indices: [index] });
  });
  return groups;
}

/** Whether any card holds a type the current صفة الإقامة no longer permits. */
export function holdsDisallowedType(properties: readonly PropertyDraft[], permitted: ReadonlySet<string>): boolean {
  return !properties.every((p) => !p.propertyType || permitted.has(p.propertyType));
}

/**
 * A property left holding a type the current صفة الإقامة no longer permits
 * has it cleared, rather than failing validation on save against a control
 * the form has stopped offering.
 */
export function withDisallowedTypesCleared(
  current: CitizenFormValues,
  permitted: ReadonlySet<string>,
): CitizenFormValues {
  return {
    ...current,
    properties: current.properties.map((p) =>
      p.propertyType && !permitted.has(p.propertyType)
        ? { ...p, propertyType: undefined, tentLocation: undefined }
        : p,
    ),
  };
}

/** Whether any flag covers a field the form has stopped asking about. */
export function holdsUnaskableFlag(flags: ReadonlyMap<string, string>, askable: ReadonlySet<string>): boolean {
  return ![...flags.keys()].every((path) => askable.has(path));
}

/**
 * A flag whose field the form has stopped asking about is withdrawn.
 *
 * Switching a card from خيمة to أرض, or a citizen from أجنبي to لبناني,
 * retires whole groups of inputs. A flag left behind on one of them would
 * hold the record at «يتطلب مراجعة» over a question nothing on screen is
 * asking.
 */
export function withUnaskableFlagsDropped(current: CitizenFormValues, askable: ReadonlySet<string>): CitizenFormValues {
  const kept = new Map<string, string>();
  for (const [path, reason] of current.flags) {
    if (askable.has(path)) kept.set(path, reason);
  }
  return { ...current, flags: kept };
}

/** What the note under the phone box says, and the number it names. */
export type PhoneNote = { kind: 'noPhone'; oldNumber: string | null } | { kind: 'changed'; oldNumber: string };

/**
 * «تغيير رقم الهاتف» on a saved file changes how the citizen signs in: the
 * portal asks for their رقم مرجعي *and* this number. Said while the old number
 * is still on screen to compare. «لا يملك رقم هاتف» is not a new number, so it
 * has a note of its own. An estate or an institution has an optional phone and
 * no «لا يملك رقم هاتف» (the server stores it false). Null when nothing changed.
 */
export function phoneNoteOf(
  initialPhone: unknown,
  contact: CitizenFormValues['contact'],
  residence: CitizenResidence | undefined,
  mode: 'create' | 'edit',
): PhoneNote | null {
  const loadedPhone = String(initialPhone ?? '').replace(/\s+/g, '');
  const phoneNow = String(contact.phone ?? '').replace(/\s+/g, '');
  const noPhoneNow = contact.hasNoPhone === true && !isNonPersonRecord(residence);
  if (noPhoneNow) return { kind: 'noPhone', oldNumber: mode === 'edit' && loadedPhone ? loadedPhone : null };
  if (mode === 'edit' && loadedPhone && phoneNow !== loadedPhone) return { kind: 'changed', oldNumber: loadedPhone };
  return null;
}
