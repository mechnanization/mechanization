import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { allowedPropertyTypesFor } from '@mechanization/shared-schemas';
import type { PublicTenantConfig } from '@/lib/api-client';
import { askablePaths } from '@/lib/citizen-form-askable';
import {
  collapsedAfterAdd,
  collapsedAfterRemoval,
  groupProperties,
  holdsDisallowedType,
  holdsUnaskableFlag,
  withAddedProperty,
  withDisallowedTypesCleared,
  withEndedRowsRemoved,
  withFlag,
  withoutFlag,
  withProperty,
  withRemovedProperty,
  withUnaskableFlagsDropped,
} from '@/lib/citizen-form-state';
import type { CardRemovalAnswer, CitizenFormValues, PropertyDraft } from '@/lib/citizen-form-values';
import { carryHeldPhone } from '@/lib/citizen-contact';

/**
 * What the citizen form holds, and every way it changes (GOD-22, phase 2c).
 *
 * The record itself, which cards are folded, and the four effects that keep them
 * honest: re-seeding when the record finishes loading, telling the parent what
 * the form now holds (the draft), clearing a property type the صفة الإقامة no
 * longer permits, and withdrawing a flag on a field that is no longer asked.
 * Moved out of `CitizenForm` with its text unchanged, hooks and effects in the
 * order they had there: the effects run in that order, and the first renders
 * the form's tests fingerprint do not change it. The transitions themselves are
 * `lib/citizen-form-state.ts`.
 */
export function useCitizenFormRecord({
  initial,
  onValuesChange,
  config,
  locale,
}: {
  initial: CitizenFormValues;
  onValuesChange?: (values: CitizenFormValues) => void;
  config: PublicTenantConfig;
  locale: string;
}) {
  const [values, setValues] = useState<CitizenFormValues>(initial);
  /** Which property cards are folded shut. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());

  // Re-seeds when the record finishes loading. Keyed on the object identity,
  // so a parent that fetches once does not clobber what has been typed since.
  useEffect(() => {
    setValues(initial);
    /*
      Saved properties open folded; a card not yet saved opens expanded.

      On the wizard's own «العقارات» page, each property is a heading the
      officer opens — and opened, it leads with its building's matrix, their
      flats lit. The earlier worry about folding («a field an officer cannot
      see is a field they do not check») is met elsewhere now: a folded card
      opens on its own on «خانات غير مؤكَّدة» when a field inside it is still
      open, and an error lands the officer on the page that holds it.

      A card with no id is the blank one a new filing starts with, or one just
      added — folding that would hide the very thing the page is for.
    */
    setCollapsed(
      new Set(
        initial.properties.flatMap((property, index) => (property.id ? [index] : [])),
      ),
    );
  }, [initial]);

  /*
    Tell the parent what the form now holds, so it can keep a draft.

    Depends on `values` alone. Including `onValuesChange` would re-fire this on
    every render of a parent that passes an inline arrow — which is every
    parent — and the handler writes to localStorage, so that is a synchronous
    disk write per render rather than per edit. The callback is invoked through
    a ref so the one that runs is always the latest, without being a dependency.
  */
  const notifyChange = useRef(onValuesChange);
  notifyChange.current = onValuesChange;
  useEffect(() => {
    notifyChange.current?.(values);
  }, [values]);

  const update = useCallback((patch: Partial<CitizenFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
  }, []);

  /**
   * The contact section, with one correction made on the officer's behalf:
   * «لا يملك رقم هاتف» carries the number already on the file into «رقم
   * للتواصل» instead of throwing it away (`carryHeldPhone`, which says when).
   *
   * Called here rather than in `ContactStep` because it is a correction rule
   * rather than a rendering one — the same place the «غير مؤكَّد» flags and
   * the نوع الملف switch are decided — and because it needs the file as it
   * stood, which the step does not own.
   */
  const updateContact = useCallback((next: CitizenFormValues['contact']) => {
    setValues((current) => ({ ...current, contact: carryHeldPhone(current.contact, next) }));
  }, []);

  /** Raise or amend a «غير مؤكَّد» flag and empty the field it covers (`withFlag`). */
  const setFlag = useCallback((path: string, reason: string) => {
    setValues((current) => withFlag(current, path, reason));
  }, []);

  /** Withdraws a flag. The field comes back empty, which is where it was. */
  const clearFlag = useCallback((path: string) => {
    setValues((current) => withoutFlag(current, path));
  }, []);

  const flagging = useMemo(
    () => ({
      flags: values.flags,
      unverified: values.unverified,
      set: setFlag,
      clear: clearFlag,
      locale,
    }),
    [values.flags, values.unverified, setFlag, clearFlag, locale],
  );

  /** One card, updated from whatever it currently is (`withProperty`: an updater, so two writes compose). */
  const setProperty = useCallback(
    (index: number, update: (current: PropertyDraft) => PropertyDraft) => {
      setValues((current) => withProperty(current, index, update));
    },
    [],
  );

  /** A new card; `sameParcelAs` carries the parcel's number and الحي across (`withAddedProperty`). */
  const addProperty = useCallback((sameParcelAs?: number) => {
    setValues((current) => {
      const next = withAddedProperty(current, sameParcelAs);
      setCollapsed(collapsedAfterAdd(next.properties));
      return next;
    });
  }, []);

  /** Property cards grouped by shared رقم العقار (`groupProperties`). */
  const propertyGroups = useMemo(() => groupProperties(values.properties), [values.properties]);

  const removeProperty = useCallback((index: number, answer?: CardRemovalAnswer) => {
    setValues((current) => withRemovedProperty(current, index, answer));
    setCollapsed((current) => collapsedAfterRemoval(current, index));
  }, []);

  /** Rows of card `index` that «إنهاء الإيجار» just ended while the card goes on (`withEndedRowsRemoved`). */
  const removeEndedRows = useCallback((index: number, rowIds: readonly string[]) => {
    if (rowIds.length === 0) return;
    setValues((current) => withEndedRowsRemoved(current, index, rowIds));
  }, []);

  const toggleCollapsed = useCallback((index: number) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  /**
   * Which نوع العقار is offered: the municipality's enabled types, minus خيمة
   * for anyone who is not a لاجئ. Re-checked on the server, where صفة الإقامة
   * and the property list are both in hand.
   */
  const allowedTypes = useMemo(() => {
    const enabled = new Set(config.enabledPropertyTypes);
    return allowedPropertyTypesFor(values.personal.residentStatus as string | undefined).filter(
      (type) => enabled.has(type),
    );
  }, [config.enabledPropertyTypes, values.personal.residentStatus]);

  /** A card holding a type the current صفة الإقامة no longer permits has it cleared (`withDisallowedTypesCleared`). */
  useEffect(() => {
    const permitted = new Set<string>(allowedTypes);
    if (!holdsDisallowedType(values.properties, permitted)) return;

    setValues((current) => withDisallowedTypesCleared(current, permitted));
  }, [allowedTypes, values.properties]);

  /** A flag whose field the form has stopped asking about is withdrawn (`withUnaskableFlagsDropped`). */
  useEffect(() => {
    const askable = askablePaths(values);
    if (!holdsUnaskableFlag(values.flags, askable)) return;

    setValues((current) => withUnaskableFlagsDropped(current, askable));
  }, [values]);

  return {
    values,
    setValues,
    collapsed,
    setCollapsed,
    update,
    updateContact,
    flagging,
    setProperty,
    addProperty,
    propertyGroups,
    removeProperty,
    removeEndedRows,
    toggleCollapsed,
    allowedTypes,
  };
}
