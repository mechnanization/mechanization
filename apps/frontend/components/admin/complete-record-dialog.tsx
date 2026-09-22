'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ClipboardCheck, Loader2, ShieldQuestion, TriangleAlert } from 'lucide-react';
import {
  ApiRequestError,
  getCitizenForm,
  logApiError,
  staleEditOf,
  updateCitizen,
} from '@/lib/api-client';
import { controlFor, type FieldControl } from '@/lib/citizen-field-controls';
import { flagFieldLabel } from '@/lib/field-flags';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { askableFields, toSubmission, type CitizenFormValues } from './citizen-form';
import { toFormValues } from './citizen-editor';

/**
 * «استكمال البيانات الناقصة» — the record's open questions, and nothing else.
 *
 * ## The problem
 *
 * A record at «يتطلب مراجعة» is a complete registration with named gaps: the
 * deed was with a relative, the parents were out, the parcel number is not in
 * the cadastre. Each gap carries the officer's own sentence saying why. When
 * the missing thing turns up — someone phones back, a document arrives, a
 * colleague knows the mother's name — the only way to record it was «تعديل»,
 * which opens a four-step form over the whole household and asks the clerk to
 * find the one box among sixty.
 *
 * That is the wrong shape of work for the task, and it has a cost beyond
 * annoyance. A clerk who opens the full form to type one value is a clerk
 * with every other field on the record in edit state, which is how an unrelated
 * value gets nudged; and a form that takes two minutes to fill for a one-word
 * answer is a form people put off, which is how «يتطلب مراجعة» becomes a queue
 * nobody works.
 *
 * ## The shape this takes instead
 *
 * The pattern municipal registers settle on for exactly this — the Dutch BAG's
 * *in onderzoek* attributes, a deficiency checklist in a permitting system — is
 * a **work item per open question**, resolved in place, with the record's own
 * history recording that it was resolved. Not per-field inline editing on the
 * detail card: that answers «change this value» when the question is «here is
 * what this record is still waiting for», and it cannot express the second kind
 * of gap at all (below).
 *
 * So: one row per open flag, in the order the form asks them, each showing the
 * reason it was left open and the right control for the answer. Fill what you
 * can, save once.
 *
 * ## What it deliberately does **not** do
 *
 * **It has no write path of its own.** It loads the record with
 * `getCitizenForm`, maps it with `toFormValues` — the same function the editor
 * uses — merges the answers into those values, and submits `toSubmission`
 * through `updateCitizen`, exactly as «تعديل» does. The whole record is sent,
 * because that is what this API takes and because a patch endpoint here would
 * be a second, narrower door onto the same table with its own idea of what is
 * valid. Every rule in `adminUpdateCitizenSubmissionSchema` applies to this
 * save unchanged, including `expectedVersion`, so two clerks racing on one
 * record get the same conflict they would get anywhere else.
 *
 * **It does not pretend an `UNVERIFIED` flag can be dismissed.** The two flag
 * kinds are different work and the dialog says so. An `UNESTABLISHED` flag is
 * the officer's statement that nothing was learned — typing the value clears
 * it, full stop. An `UNVERIFIED` flag is the *server's* statement that a value
 * it holds is not confirmed against the municipality's own cadastre; the server
 * re-derives those on every write (`shapeSubmission` discards any the client
 * sends), so a «تأكيد» button here would clear the row on screen and find the
 * flag back a second later. It offers the two things that actually work —
 * correct the number, or leave it and let the parcel import clear it — and says
 * which is which.
 */

/** One open question on the record. */
interface OpenItem {
  path: string;
  label: string;
  /** The sentence attached to the flag — the officer's, or the server's. */
  reason: string;
  kind: 'UNESTABLISHED' | 'UNVERIFIED';
  control: FieldControl;
  /** The value on the record now. Always empty for `UNESTABLISHED`. */
  current: string;
  /**
   * Whether this flag names an input at all.
   *
   * `personal.possibleDuplicate` does not — it is a verdict about the record as
   * a whole («سجل مشابه موجود») and is cleared by answering the duplicate
   * review on the edit form, not by typing anything. Shown here rather than
   * hidden, because a queue that lists three open questions and offers two
   * reads as broken; listed with no box and a sentence saying where it is
   * answered, it reads as what it is.
   */
  answerable: boolean;
  /** Where it sorts — see `rankOf`. */
  rank: number;
}

// ────────────────────────────  dot-paths  ────────────────────────────
//
// The flags name `personal.motherName`, `properties.0.propertyNumber` and
// `properties.0.units.2.unitArea`. These two walk that vocabulary over
// `CitizenFormValues`. Narrow on purpose — they descend `properties` and
// `units` and nothing else, because those are the only indexed collections a
// flag path can name (`FLAG_PATH` in `field-flag.schema.ts` says so), and a
// generic deep-set would happily write into `sharedRights`, an array of plain
// strings whose indices mean nothing.

function readAt(values: CitizenFormValues, path: string): string {
  const [section, ...rest] = path.split('.');

  if (section === 'personal' || section === 'contact') {
    const value = (values[section] as Record<string, unknown>)[rest[0] ?? ''];
    return value === null || value === undefined ? '' : String(value);
  }

  if (section !== 'properties') return '';
  const card = values.properties[Number(rest[0])];
  if (!card) return '';

  if (rest[1] === 'units') {
    const unit = (card.units ?? [])[Number(rest[2])] as Record<string, unknown> | undefined;
    const value = unit?.[rest[3] ?? ''];
    return value === null || value === undefined ? '' : String(value);
  }

  const value = (card as unknown as Record<string, unknown>)[rest[1] ?? ''];
  if (Array.isArray(value)) return value.join('، ');
  return value === null || value === undefined ? '' : String(value);
}

function writeAt(values: CitizenFormValues, path: string, raw: string): CitizenFormValues {
  const [section, ...rest] = path.split('.');
  /*
    A blank answer writes `undefined`, not `''`.

    The strict schemas read presence, not truthiness — an empty string is a
    value that fails «مطلوب» with a message about a field the clerk did leave
    alone. `undefined` leaves the field exactly as the record has it, which for
    an unanswered `UNESTABLISHED` gap is empty and flagged, and that is the
    correct outcome of «I still do not know».
  */
  const value = raw.trim() === '' ? undefined : raw;

  if (section === 'personal' || section === 'contact') {
    return { ...values, [section]: { ...values[section], [rest[0] ?? '']: value } };
  }

  if (section !== 'properties') return values;
  const index = Number(rest[0]);

  return {
    ...values,
    properties: values.properties.map((card, cardIndex) => {
      if (cardIndex !== index) return card;

      if (rest[1] === 'units') {
        const unitIndex = Number(rest[2]);
        return {
          ...card,
          units: (card.units ?? []).map((unit, position) =>
            position === unitIndex ? { ...unit, [rest[3] ?? '']: value } : unit,
          ),
        };
      }

      /* «حقوق مشتركة» is the one list-valued field a flag can name. It is typed
         here as one line and split back — the form's chip editor is a section,
         not a control, and re-creating it for a single row would be the kind of
         copy this file's header argues against. */
      if (rest[1] === 'sharedRights') {
        return {
          ...card,
          sharedRights:
            value === undefined
              ? []
              : value
                  .split(/[،,]/)
                  .map((part) => part.trim())
                  .filter(Boolean),
        };
      }

      return { ...card, [rest[1] ?? '']: value };
    }),
  };
}

// ──────────────────────────────  dialog  ──────────────────────────────

export function CompleteRecordDialog({
  open,
  onOpenChange,
  tenant,
  base,
  token,
  citizenId,
  citizenName,
  locale = 'ar',
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  /** The admin path prefix, for the link out to the full form. */
  base: string;
  token: string | null;
  citizenId: string;
  citizenName: string;
  locale?: string;
  /** Raised after a successful save, so the page behind can refetch. */
  onSaved?: () => void;
}) {
  const en = locale === 'en';
  const toast = useToast();

  const [values, setValues] = useState<CitizenFormValues | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * The server's per-field complaints from the last refused save, by dot-path.
   *
   * Kept separate from `saveError` because they are answered differently. A
   * complaint on a path this dialog is showing belongs on that row, where the
   * clerk can retype the value. A complaint on any other path cannot be
   * answered here at all — see `blockedElsewhere`.
   */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  /** The answers typed in this sitting, keyed by path. */
  const [answers, setAnswers] = useState<Map<string, string>>(new Map());
  /** Reasons amended in this sitting, for gaps still unanswered. */
  const [reasons, setReasons] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!open) return;

    /*
      No session. Said, rather than spun on.

      The load and the save both need a token, and both used to return early
      without it — so a dialog opened from a page whose session had lapsed
      showed a spinner that never resolved, above a «حفظ» button that did
      nothing when pressed and said nothing about why. A signed-out clerk is a
      thing that happens; a screen that cannot tell them so is not.
    */
    if (!token) {
      setLoadError(
        en
          ? 'Your session has expired. Reload the page and sign in again.'
          : 'انتهت صلاحية الجلسة. حدّث الصفحة وسجّل الدخول من جديد.',
      );
      return;
    }

    let cancelled = false;

    setValues(null);
    setLoadError(null);
    setSaveError(null);
    setAnswers(new Map());
    setReasons(new Map());
    setFieldErrors({});

    void (async () => {
      try {
        const form = await getCitizenForm(tenant, token, citizenId);
        if (cancelled) return;
        setValues(toFormValues(form));
        setVersion(form.version ?? null);
      } catch (caught) {
        if (cancelled) return;
        logApiError(caught);
        setLoadError(en ? 'Could not load the record.' : 'تعذّر تحميل السجل.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, token, tenant, citizenId, en]);

  /**
   * The open questions, in the order the form asks them.
   *
   * ## Ordering
   *
   * By `askableFields`, not by the stored flag array — that is in the order the
   * flags were raised, which is the order an officer noticed things and not an
   * order anybody reads a file in.
   *
   * ## Pruning
   *
   * A flag can outlive the question it excused: «رقم السجل» on a record since
   * corrected to non-Lebanese names an input the form no longer has. Offering a
   * box for it would invite an answer that `shapeSubmission` then drops. So a
   * flag is shown only where the record still has a place for it.
   *
   * ## The three shapes a flag path comes in
   *
   * `askableFields` answers only the first, and treating it as the whole
   * vocabulary was a real bug in an earlier draft of this dialog — a record
   * whose only gaps were unit areas opened to «لا توجد معلومات ناقصة» and the
   * clerk was told there was nothing to do.
   *
   *  1. **A section or card field** — `personal.motherName`,
   *     `properties.0.propertyNumber`. Exactly `askableFields`.
   *  2. **One flat inside a مبنى card** — `properties.0.units.3.unitArea`.
   *     `FLAG_PATH` in `field-flag.schema.ts` speaks these and the form raises
   *     them, but `askableFields` stops at the `units` array. Admitted here
   *     when the card and that unit both still exist, sorted directly under
   *     their card.
   *  3. **A flag that names no input at all** — the whole `units` array
   *     («لم نتمكن من جرد وحدات المبنى») and `personal.possibleDuplicate`.
   *     Listed, because a queue that reports three open questions and offers
   *     two reads as broken, but with no box: one is answered by going through
   *     the building and the other by the duplicate review. Both say where.
   */
  const items = useMemo<OpenItem[]>(() => {
    if (!values) return [];

    const order = new Map(askableFields(values).map((entry, index) => [entry.path, index]));

    /**
     * Where this path sorts, or `null` when the record has no place for it.
     *
     * Unit paths are keyed off their card's own position, times a stride wide
     * enough that a card's flats sort between it and the next card — 60 units
     * is `buildingUnitsSchema`'s ceiling, so the stride cannot be overrun by a
     * record the schema would accept.
     */
    const rankOf = (path: string): number | null => {
      const direct = order.get(path);
      if (direct !== undefined) return direct * 100;

      const parts = path.split('.');
      if (parts[0] !== 'properties' || parts[2] !== 'units' || parts.length !== 5) return null;

      const card = values.properties[Number(parts[1])];
      const unit = card?.units?.[Number(parts[3])];
      if (!card || !unit) return null;

      const cardRank = order.get(`properties.${parts[1]}.units`);
      if (cardRank === undefined) return null;
      return cardRank * 100 + Number(parts[3]) + 1;
    };

    const add = (
      open: OpenItem[],
      path: string,
      reason: string,
      kind: OpenItem['kind'],
    ): void => {
      /*
        `possibleDuplicate` names no field and is not in `askableFields`, so it
        is admitted by name and sorted first — it is a statement about the whole
        record, and reading it after three field questions inverts what it is.
      */
      if (path === 'personal.possibleDuplicate') {
        open.push({
          path,
          label: flagFieldLabel(path, locale),
          reason,
          kind,
          control: controlFor(path),
          current: '',
          answerable: false,
          rank: -1,
        });
        return;
      }

      const rank = rankOf(path);
      if (rank === null) return;

      /* A flag on the whole `units` array is «we never got into the building».
         There is no single value to type, so it is listed without a box. */
      const answerable = path.split('.').at(-1) !== 'units';

      open.push({
        path,
        label: flagFieldLabel(path, locale),
        reason,
        kind,
        control: controlFor(path),
        current: answerable && kind === 'UNVERIFIED' ? readAt(values, path) : '',
        answerable,
        rank,
      });
    };

    const open: OpenItem[] = [];
    for (const [path, reason] of values.flags) add(open, path, reason, 'UNESTABLISHED');
    for (const [path, reason] of values.unverified ?? new Map<string, string>()) {
      add(open, path, reason, 'UNVERIFIED');
    }

    return open.sort((a, b) => a.rank - b.rank);
  }, [values, locale]);

  /**
   * How many gaps this save would close.
   *
   * `UNESTABLISHED` only. An `UNVERIFIED` flag is re-derived by the server on
   * every write, so a corrected رقم العقار clears *if* the cadastre recognises
   * it — which this browser cannot know and must not claim. Counting one here
   * would promise a clerk that the record is about to leave the queue, and then
   * hand it straight back.
   */
  const willClear = items.filter(
    (item) =>
      item.kind === 'UNESTABLISHED' &&
      item.answerable &&
      (answers.get(item.path) ?? '').trim() !== '',
  ).length;

  const remaining = items.filter((item) => item.kind === 'UNESTABLISHED').length - willClear;

  /**
   * Complaints from the last refused save that name no row on this screen.
   *
   * These are the ones the clerk cannot act on here at any price, so the dialog
   * stops pretending and hands them the full form with the fields named. It is
   * the honest answer to a real situation: a record can be unsaveable for a
   * reason that has nothing to do with why it is in the review queue.
   */
  const shown = new Set(items.map((item) => item.path));
  const blockedElsewhere = Object.entries(fieldErrors).filter(([path]) => !shown.has(path));

  /**
   * Flags the record carries that this dialog pruned away.
   *
   * Not a hypothetical. A flag outlives the question it excused whenever the
   * branch above it changes — «رقم السجل» on a record since corrected to
   * non-Lebanese, a card field on a card whose نوع العقار was changed — and the
   * server keeps such a flag until a save prunes it, so the record goes on
   * reading «يتطلب مراجعة».
   *
   * Without this the dialog would open on that record and say «لا توجد معلومات
   * ناقصة» with the button greyed out, two inches under a banner saying three
   * fields are unverified. That is the worst answer available: it contradicts
   * the page it was opened from and offers nothing to do about it.
   */
  const prunedCount =
    values && items.length === 0
      ? values.flags.size + (values.unverified?.size ?? 0)
      : 0;

  const setAnswer = (path: string, value: string) => {
    setAnswers((current) => new Map(current).set(path, value));
    setSaveError(null);
    /* Only this row's complaint is dropped. The others still stand — the save
       that raised them has not been retried, and clearing them all on one
       keystroke would make the list of what is wrong flicker away as the clerk
       works down it. */
    setFieldErrors((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  };

  const save = useCallback(async () => {
    if (!values || !token) return;

    /*
      Merge, then re-flag.

      A flag clears exactly when this sitting typed a value for it — not when
      the field "looks filled". The distinction matters for the two paths that
      render no box: a flag on the whole `properties.0.units` array would read
      as satisfied the moment the card had any units at all, which it always
      does, so a record saying «لم نتمكن من جرد وحدات المبنى» would quietly
      drop that statement on the first unrelated save from this dialog.

      Rebuilding rather than deleting the answered ones is what lets a clerk
      type a value, think better of it and clear the box again: they end where
      they started, with the officer's original reason intact.
    */
    let merged = values;
    for (const [path, answer] of answers) merged = writeAt(merged, path, answer);

    const flags = new Map<string, string>();
    for (const [path, reason] of values.flags) {
      if ((answers.get(path) ?? '').trim() !== '') continue;
      flags.set(path, (reasons.get(path) ?? reason).trim() || reason);
    }
    merged = { ...merged, flags };

    setSaving(true);
    setSaveError(null);
    try {
      await updateCitizen(tenant, token, citizenId, {
        ...toSubmission(merged),
        ...(version ? { expectedVersion: version } : {}),
      });
      toast.success(
        flags.size === 0
          ? en
            ? 'Record completed — it is no longer awaiting review.'
            : 'اكتمل السجل — لم يعد بانتظار المراجعة.'
          : en
            ? `Saved. ${flags.size} question(s) still open.`
            : `حُفظ. ما زال ${flags.size} سؤالاً مفتوحاً.`,
      );
      onOpenChange(false);
      onSaved?.();
    } catch (caught) {
      logApiError(caught);
      /*
        A stale file is its own message, not a generic failure. Somebody else
        saved this record while the dialog was open, and the useful instruction
        is «reopen», because the answers typed here were merged onto values that
        no longer describe the file.
      */
      const stale = staleEditOf(caught);

      /*
        The server's per-field complaints, routed to where they can be answered.

        This is the failure mode a dialog showing part of a record has and the
        full form does not, and it is worth naming. The whole record is sent, so
        the *whole* record is validated — including fields this dialog never
        shows. A file stored before a rule tightened, or imported with a value
        that no longer passes, is refused on a field the clerk cannot see, and
        the first version of this screen answered that with «لم يُحفظ السجل» and
        nothing else. There is no amount of retrying that fixes it, and no way
        from here to find out what «it» is.

        So the complaints are split. Ones naming a row on screen land on that
        row. Ones naming anything else are collected into `blockedElsewhere`,
        which says which fields and sends the clerk to the full form — the only
        place those *can* be corrected.
      */
      setFieldErrors(caught instanceof ApiRequestError ? caught.fieldErrors : {});

      setSaveError(
        stale
          ? en
            ? `This record was changed by ${stale.lastEditedBy ?? 'someone else'} while this was open. Close and reopen to see the current version.`
            : `عُدِّل هذا السجل من قبل ${stale.lastEditedBy ?? 'موظف آخر'} أثناء فتح هذه النافذة. أغلقها وأعد فتحها لرؤية النسخة الحالية.`
          : caught instanceof ApiRequestError
            ? caught.message
            : en
              ? 'The record was not saved.'
              : 'لم يُحفظ السجل.',
      );
    } finally {
      setSaving(false);
    }
  }, [values, token, answers, reasons, tenant, citizenId, version, toast, en, onOpenChange, onSaved]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border/80 p-5">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-warning/15 text-warning ring-1 ring-warning/30">
              <ClipboardCheck className="size-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base font-bold sm:text-lg">
                {en ? 'Complete the record' : 'استكمال البيانات الناقصة'}
              </DialogTitle>
              <DialogDescription className="truncate text-xs text-muted-foreground">
                {citizenName}
                {items.length > 0
                  ? ` · ${en ? `${items.length} open question(s)` : `${items.length} معلومة ناقصة`}`
                  : ''}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {loadError ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs font-medium text-destructive">
              {loadError}
            </p>
          ) : !values ? (
            <LoadingState />
          ) : items.length === 0 ? (
            prunedCount > 0 ? (
              <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
                <p className="font-semibold">
                  {en
                    ? `This record is marked as needing review, but its ${prunedCount} open flag(s) name fields the form no longer asks about.`
                    : `هذا السجل مُعلَّم «يتطلب مراجعة»، لكن ملاحظاته الـ${prunedCount} تخصّ خانات لم يعد النموذج يسألها.`}
                </p>
                <p className="opacity-90">
                  {en
                    ? 'That happens when the record changes kind after the flag was raised — a Lebanese record filed as non-Lebanese, or a property card whose type was corrected. Saving it once from the full form clears them.'
                    : 'يحدث هذا عندما يتغيّر نوع السجل بعد تسجيل الملاحظة — كأن يُصحَّح نوع العقار أو الجنسية. حفظه مرة واحدة من نموذج التعديل الكامل يزيلها.'}
                </p>
                <a
                  href={`${base}/citizens/${citizenId}/edit`}
                  className="inline-block font-medium underline underline-offset-4"
                >
                  {en ? 'Open the full form →' : 'افتح نموذج التعديل الكامل ←'}
                </a>
              </div>
            ) : (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {en
                  ? 'Nothing on this record is still open.'
                  : 'لا توجد معلومات ناقصة على هذا السجل.'}
              </p>
            )
          ) : (
            items.map((item) => (
              <OpenQuestion
                key={item.path}
                item={item}
                locale={locale}
                /*
                  `has`, not `?? ''`. An UNVERIFIED row opens showing the value
                  the record holds, and a clerk who selects it and deletes it
                  must see an empty box — with a falsy check the box refilled
                  itself from `item.current` on the keystroke that emptied it,
                  which reads as an input refusing to be edited. Once the row is
                  touched the map owns it, empty string included.
                */
                answer={answers.has(item.path) ? (answers.get(item.path) ?? '') : item.current}
                touched={answers.has(item.path)}
                reason={reasons.get(item.path) ?? item.reason}
                error={fieldErrors[item.path]}
                onAnswer={(value) => setAnswer(item.path, value)}
                onReason={(value) =>
                  setReasons((current) => new Map(current).set(item.path, value))
                }
                editHref={`${base}/citizens/${citizenId}/edit`}
              />
            ))
          )}

          {/*
            A refusal this dialog cannot answer, named rather than repeated.

            `blockedElsewhere` holds complaints about fields that are not on
            this screen — the record is unsaveable for a reason unrelated to why
            it is in the review queue. Retrying cannot help, so the block says
            which fields and links to the one place they can be corrected, with
            the clerk's typed answers explicitly declared lost. Saying so is the
            point: a clerk who follows this link after filling four boxes must
            not find out by discovering an empty form.
          */}
          {blockedElsewhere.length > 0 ? (
            <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              <p className="flex items-start gap-2 font-semibold">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  {en
                    ? 'This record cannot be saved from here — other fields on it need correcting first:'
                    : 'لا يمكن حفظ هذا السجل من هنا — هناك خانات أخرى فيه تحتاج تصحيحاً أولاً:'}
                </span>
              </p>
              <ul className="space-y-0.5 ps-6">
                {blockedElsewhere.map(([path, message]) => (
                  <li key={path}>
                    <span className="font-medium">{flagFieldLabel(path, locale)}</span>
                    <span className="opacity-90"> — {message}</span>
                  </li>
                ))}
              </ul>
              <a
                href={`${base}/citizens/${citizenId}/edit`}
                className="inline-block font-medium underline underline-offset-4"
              >
                {en
                  ? 'Open the full form to correct them (answers typed here are not kept) →'
                  : 'افتح نموذج التعديل الكامل لتصحيحها (لن تُحفظ الإجابات المكتوبة هنا) ←'}
              </a>
            </div>
          ) : saveError ? (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs font-medium text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{saveError}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter className="flex flex-row items-center justify-between gap-2 border-t border-border/80 bg-muted/20 p-4 sm:justify-between">
          {/*
            What the save will and will not change, stated before it happens.
            «حُفظ» on a record that stays at «يتطلب مراجعة» reads as a failure
            unless the clerk was told which questions they had answered.
          */}
          <p className="min-w-0 text-[11px] leading-snug text-muted-foreground">
            {willClear > 0
              ? en
                ? `${willClear} will be filled in${remaining > 0 ? `, ${remaining} left open` : ' — the record leaves the review queue'}.`
                : `سيُستكمل ${willClear}${remaining > 0 ? `، ويبقى ${remaining} مفتوحاً` : ' — ويخرج السجل من قائمة المراجعة'}.`
              : en
                ? 'Fill in what is known; the rest keeps its reason.'
                : 'املأ ما هو معروف، ويبقى الباقي بسببه المسجَّل.'}
          </p>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => onOpenChange(false)}
            >
              {en ? 'Cancel' : 'إلغاء'}
            </Button>
            <Button
              type="button"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={saving || !token || !values || items.length === 0}
              onClick={() => void save()}
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Check className="size-3.5" aria-hidden />
              )}
              {en ? 'Save' : 'حفظ'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One open question: what was missing, why, and the box to answer it in. */
function OpenQuestion({
  item,
  locale,
  answer,
  touched,
  reason,
  error,
  onAnswer,
  onReason,
  editHref,
}: {
  item: OpenItem;
  locale: string;
  answer: string;
  /** Whether this sitting has typed in this row at all. */
  touched: boolean;
  reason: string;
  /** What the server said about this field on the last refused save. */
  error?: string;
  onAnswer: (value: string) => void;
  onReason: (value: string) => void;
  editHref: string;
}) {
  const en = locale === 'en';
  const unverified = item.kind === 'UNVERIFIED';
  const inputId = `complete-${item.path.replace(/\./g, '-')}`;

  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border p-3',
        error
          ? 'border-destructive/50 bg-destructive/5'
          : unverified
            ? 'border-warning/40 bg-warning/5'
            : 'border-border/80 bg-card',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={inputId} className="text-xs font-semibold">
          {item.label}
        </Label>
        {unverified ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning ring-1 ring-warning/30">
            <ShieldQuestion className="size-3 shrink-0" aria-hidden />
            {en ? 'Needs verification' : 'بانتظار التحقق'}
          </span>
        ) : null}
      </div>

      {/* The sentence the gap was recorded with — the officer's for an
          unestablished field, the server's for an unverified one. It is the
          whole reason this record is in the queue, so it is not collapsed
          behind a tooltip. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{item.reason}</p>

      {!item.answerable ? (
        /*
          Two gaps with nothing to type, and they are answered in different
          places — so the link says which, rather than «open the edit form» and
          leaving the clerk to work out what to do once they are there.

            • «سجل مشابه موجود» clears when somebody states that the match is a
              different person. That is the duplicate review, which the edit
              form carries.
            • A flag on the whole units array is «we never got into the
              building»; it is answered by going through it, unit by unit, on
              the card's own editor.
        */
        <a
          href={editHref}
          className="inline-block text-[11px] font-medium text-primary underline-offset-4 hover:underline"
        >
          {item.path === 'personal.possibleDuplicate'
            ? en
              ? 'Answered in the duplicate review on the edit form →'
              : 'يُحسم عبر مراجعة السجلات المشابهة في نموذج التعديل ←'
            : en
              ? 'The whole building has to be listed — open the full form →'
              : 'يلزم جرد وحدات المبنى كاملاً — افتح نموذج التعديل ←'}
        </a>
      ) : (
        <>
          <AnswerControl
            id={inputId}
            control={item.control}
            locale={locale}
            value={answer}
            onChange={onAnswer}
            invalid={Boolean(error)}
          />

          {/* Directly under the control it is about, which is the whole reason
              for routing these per-path rather than printing one message at the
              foot of the dialog: «المساحة غير صالحة» ten rows from the area box
              is a message the clerk has to go looking for. */}
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1 text-[11px] text-destructive"
            >
              {error}
            </p>
          ) : null}

          {unverified ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {en
                ? 'Correcting the value here re-checks it against the register on save. It also clears on its own once the parcel is imported — this is not something to confirm by hand.'
                : 'تصحيح القيمة هنا يعيد مطابقتها مع سجل البلدية عند الحفظ. وتُرفع الملاحظة تلقائياً متى أُدرج العقار في السجل — ولا تُرفع يدوياً.'}
            </p>
          ) : (
            /*
              The reason stays editable while the gap is open.

              A record can sit at «يتطلب مراجعة» for weeks, and «الأهل غير
              متواجدين» written in March is not what is true in May. Amending it
              is the only honest thing a clerk who learned something short of the
              answer can record — and it is why this box appears rather than a
              «still missing» checkbox: leaving the field empty already says
              that.
            */
            <div className="space-y-1">
              <Label
                htmlFor={`${inputId}-reason`}
                className="text-[10px] font-medium text-muted-foreground"
              >
                {en ? 'Or update why it is still missing' : 'أو حدّث سبب بقائها ناقصة'}
              </Label>
              <Input
                id={`${inputId}-reason`}
                value={reason}
                onChange={(event) => onReason(event.target.value)}
                /* Greyed once an answer is typed, because the two are
                   alternatives: a value clears the flag, and a reason only
                   matters while the gap stays a gap. */
                disabled={touched && answer.trim() !== ''}
                className="h-8 text-xs disabled:opacity-50"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The right box for one field, per `CITIZEN_FIELD_CONTROLS`. */
function AnswerControl({
  id,
  control,
  locale,
  value,
  onChange,
  invalid,
}: {
  id: string;
  control: FieldControl;
  locale: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  const en = locale === 'en';

  if (control.kind === 'select') {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          id={id}
          aria-invalid={invalid || undefined}
          className={cn('h-9 text-xs', invalid && 'border-destructive')}
        >
          <SelectValue placeholder={en ? 'Select…' : 'اختر…'} />
        </SelectTrigger>
        <SelectContent>
          {control.options(locale).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Input
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      /* `inputMode` rather than `type="number"`: a number input drops the
         leading zero a رقم عقار can carry and offers spinners nobody wants on
         a measurement. Coercion is the schema's job on save, as it is for the
         form's own fields. */
      inputMode={
        control.kind === 'phone' ? 'tel' : control.kind === 'number' ? 'decimal' : undefined
      }
      dir={control.kind === 'phone' ? 'ltr' : undefined}
      placeholder={
        control.kind === 'tags'
          ? en
            ? 'Separate with commas'
            : 'افصل بينها بفاصلة'
          : undefined
      }
      aria-invalid={invalid || undefined}
      className={cn('h-9 text-xs', invalid && 'border-destructive')}
    />
  );
}
