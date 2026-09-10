'use client';

import { useEffect, useMemo, useState } from 'react';
import { Building2, Check, Link2, Loader2, Lock, Unlink } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  getBuilding,
  getBuildings,
  logApiError,
  type BuildingDetail,
  type BuildingLedgerRow,
  type UnitWithOccupants,
} from '@/lib/api-client';
import type { PropertyDraft, UnitDraft } from '@/components/citizen/property-card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Ties one property card to the censused structure it is about (P3-T6).
 *
 * This is the link §3.7 exists for and P2-T8 turns on: where a card line names
 * a canonical `Unit`, that `Unit` is authoritative field by field, and the flat
 * the citizen filed and the flat the municipality surveyed are known to be the
 * same flat rather than two rows that happen to agree.
 *
 * Two things it deliberately does *not* do:
 *
 *  - **It never invents a building.** If the parcel has no censused structure
 *    the control says so and stays out of the way — a card filed before anyone
 *    surveyed the parcel is the normal case, not an error, and forcing a link
 *    would mean an officer creating a shell from the registration form with
 *    none of the information the census needs.
 *  - **It never picks units on the citizen's behalf.** A twelve-flat matrix
 *    says nothing about whether this person holds one of them or twelve; that
 *    is exactly the mistake P2-T8's first attempt made. The officer ticks the
 *    ones this citizen holds, and nothing is ticked by default.
 */

/** What the picker was launched with, when it came from a matrix. */
export interface LockedCensusTarget {
  buildingId: string;
  /** Set when the officer tapped a specific flat rather than the building. */
  unitId?: string;
}

export function BuildingUnitPicker({
  tenant,
  token,
  draft,
  onChange,
  onLinkedBuilding,
  locked,
  locale = 'ar',
}: {
  tenant: string;
  token: string;
  draft: PropertyDraft;
  onChange: (patch: Partial<PropertyDraft>) => void;
  /**
   * The structure this card now points at, or null when it points at none.
   *
   * Reported upward rather than kept here because «اسم المبنى» is rendered by
   * the card, and it needs to know whether the register already has a name for
   * the block — a linked, named building makes that field a statement rather
   * than a question. The alternative was the card fetching the same building a
   * second time, which is how two components start disagreeing about it.
   */
  onLinkedBuilding?: (building: { id: string; code: string; name: string | null } | null) => void;
  /**
   * Launched from the matrix: the building — and possibly the unit — is not a
   * choice. Shown as a statement with the reason, rather than a disabled
   * select, because a control that cannot be used is a question that should
   * not have been asked.
   */
  locked?: LockedCensusTarget | null;
  locale?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  const parcelNumber = draft.propertyNumber?.trim() ?? '';
  const isBuilding = draft.propertyType === 'BUILDING';

  const [candidates, setCandidates] = useState<BuildingLedgerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<BuildingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // ── Which structures stand on this parcel ─────────────────────────
  useEffect(() => {
    if (!parcelNumber) {
      setCandidates([]);
      return;
    }
    /*
      A card arriving from the matrix has its parcel already, because the editor
      seeds it from the building. This lookup is still what populates the *other*
      structures on that parcel, which is what the officer needs in order to
      notice they are on the wrong one.
    */
    let cancelled = false;
    setLoading(true);

    getBuildings(tenant, token, { parcelNumber, limit: 50 })
      .then((response) => {
        if (!cancelled) setCandidates(response.buildings);
      })
      .catch((caught) => {
        // A census the officer cannot reach must not block a registration: the
        // link is an enrichment, and the card is valid without it.
        logApiError(caught);
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tenant, token, parcelNumber]);

  // ── The chosen structure's matrix ─────────────────────────────────
  const buildingId = draft.buildingId ?? null;

  useEffect(() => {
    if (!buildingId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);

    getBuilding(tenant, token, buildingId)
      .then((response) => {
        if (!cancelled) setDetail(response);
      })
      .catch((caught) => {
        logApiError(caught);
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tenant, token, buildingId]);

  /*
    A locked target is applied once, and only onto a card that has not already
    been pointed somewhere else. Re-applying it on every render would fight an
    officer who deliberately unlinked, which is a legitimate correction.
  */
  useEffect(() => {
    if (!locked || draft.buildingId) return;
    onChange({ buildingId: locked.buildingId });
    // `onChange` is a fresh closure each render; depending on it would re-run
    // this on every keystroke elsewhere in the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, draft.buildingId]);

  /*
    Tell the card which structure it is on, and keep the two names in step.

    The parcel and the register are the two halves of an address, and they used
    to be able to disagree without either screen noticing: the card's
    «اسم المبنى» was free text, `Building.name` was the register's own, and
    nothing compared them. Linked to a *named* building, the register's answer
    is copied down and the input is locked — a change made once on the building
    then shows on every card in it.

    An *unnamed* building is left alone in both directions. The officer in its
    stairwell may be the person who learns the name, so their typing is kept and
    promoted onto the building server-side (`CensusSyncService`). Copying an
    empty name down would erase what they had already typed.
  */
  useEffect(() => {
    if (!onLinkedBuilding) return;
    onLinkedBuilding(detail ? { id: detail.id, code: detail.code, name: detail.name } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, detail?.code, detail?.name]);

  useEffect(() => {
    const name = detail?.name?.trim();
    if (!name || draft.buildingName === name) return;
    onChange({ buildingName: name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.name, draft.buildingName]);

  const linkedUnitIds = useMemo(
    () => new Set((draft.units ?? []).map((unit) => unit.unitId).filter(Boolean) as string[]),
    [draft.units],
  );

  /** Adds or removes the card line that names this canonical unit. */
  const toggleUnit = (unit: UnitWithOccupants) => {
    const units = draft.units ?? [];
    if (linkedUnitIds.has(unit.id)) {
      onChange({ units: units.filter((row) => row.unitId !== unit.id) });
      return;
    }

    /*
      The canonical values seed the row; the officer can still correct them.

      `floor` crosses a real boundary here — `Unit.floor` is a signed integer
      and `BuildingUnit.floor` is free text — so it is rendered the way a person
      says it rather than as "0". `parseFloorLabel` is the door back the other
      way; this is the door out.
    */
    const row: UnitDraft = {
      unitId: unit.id,
      unitType: unit.unitType,
      floor: floorText(unit.floor, en),
      side: unit.side ?? undefined,
      unitArea: unit.unitArea != null ? String(unit.unitArea) : undefined,
      unitStatus: unit.unitStatus ?? undefined,
    };
    onChange({ units: [...units, row] });
  };

  const unlink = () =>
    onChange({
      buildingId: undefined,
      units: (draft.units ?? []).map(({ unitId: _dropped, ...rest }) => rest),
    });

  /*
    Nothing to offer, and nothing to say.

    `locked` is the exception, and it used to be the bug: an officer arriving
    from «تسجيل أسرة في هذه الوحدة» hit this line with an empty card, the whole
    control vanished, and the only sign the flat had been chosen was a hidden
    `buildingId` the form never mentioned again. The card is seeded now, so a
    locked target normally has a parcel — but the seed can fail (the editor
    swallows a lost connection deliberately), and the one state where the
    officer most needs to be told what they are linked to must not be the state
    that renders nothing.
  */
  if (!parcelNumber && !locked) return null;

  // Prefer the loaded building over the parcel listing: with a locked target
  // the listing may still be empty while the detail is already in hand.
  const chosen =
    candidates.find((row) => row.id === buildingId) ??
    (detail && detail.id === buildingId ? detail : null);

  /*
    What the officer may pick between.

    Normally the parcel's own listing. Where that has not arrived — a locked
    target whose parcel lookup is still in flight, or failed — the building
    already in hand stands in for it, so the control shows the structure the
    card is on rather than claiming the parcel has none.
  */
  const options: Array<{
    id: string;
    code: string;
    name: string | null;
    structureType: BuildingLedgerRow['structureType'];
  }> = candidates.length > 0 ? candidates : chosen ? [chosen] : [];

  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <Building2 className="size-3.5 text-muted-foreground" aria-hidden />
          {en ? 'Censused structure' : 'المنشأة في سجل المباني'}
          {locked ? (
            <Badge variant="soft-muted" className="gap-1">
              <Lock className="size-3" aria-hidden />
              {en ? 'From the matrix' : 'من مصفوفة الوحدات'}
            </Badge>
          ) : null}
        </p>

        {buildingId && !locked ? (
          <button
            type="button"
            onClick={unlink}
            className="flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
          >
            <Unlink className="size-3" aria-hidden />
            {en ? 'Unlink' : 'إلغاء الربط'}
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          {en ? 'Checking the census…' : 'جاري مراجعة سجل المباني…'}
        </p>
      ) : options.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {en
            ? `No structure has been censused on parcel ${parcelNumber} yet. The card is valid without one — the link can be made later from the census ledger.`
            : `لا توجد منشأة مسجَّلة على العقار ${parcelNumber} بعد. البطاقة صالحة بدون ربط — يمكن ربطها لاحقاً من سجل المباني.`}
        </p>
      ) : (
        <>
          <ul className="flex flex-wrap gap-1.5">
            {options.map((row) => {
              const active = row.id === buildingId;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    disabled={Boolean(locked)}
                    onClick={() => onChange({ buildingId: active ? undefined : row.id })}
                    aria-pressed={active}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'hover:bg-accent disabled:opacity-50',
                    )}
                  >
                    {active ? <Check className="size-3" aria-hidden /> : null}
                    <span dir="ltr" className="font-mono font-semibold">
                      {row.code}
                    </span>
                    {row.name ? <span className="truncate">{row.name}</span> : null}
                    <span className="text-muted-foreground">
                      {labels.structureType[row.structureType]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {chosen ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {en
                ? `Linked to ${chosen.code}. Where a unit is linked below, the census record is authoritative for the fields it holds.`
                : `مرتبطة بـ ${chosen.code}. حيث تُربط وحدة أدناه، يكون سجل المباني هو المرجع في الحقول التي يحملها.`}
            </p>
          ) : null}
        </>
      )}

      {/* ── The flats this citizen actually holds ────────────────── */}
      {buildingId && isBuilding ? (
        <div className="space-y-1.5 border-t pt-2">
          <p className="text-[11px] font-medium">
            {en ? 'Which units does this citizen hold?' : 'أي وحدات يملك/يشغل هذا المواطن؟'}
          </p>

          {detailLoading ? (
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {en ? 'Loading the matrix…' : 'جاري تحميل المصفوفة…'}
            </p>
          ) : !detail || detail.units.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {en
                ? 'This structure has no unit matrix yet. Record the units on the card below as usual.'
                : 'لا توجد مصفوفة وحدات لهذه المنشأة بعد. سجّل الوحدات في البطاقة أدناه كالمعتاد.'}
            </p>
          ) : (
            <>
              <ul className="flex flex-wrap gap-1.5">
                {detail.units.map((unit) => {
                  const active = linkedUnitIds.has(unit.id);
                  const takenBySomeoneElse = unit.occupants.some(
                    (occupant) => occupant.toDate === null,
                  );
                  return (
                    <li key={unit.id}>
                      <button
                        type="button"
                        disabled={Boolean(locked?.unitId) && locked?.unitId !== unit.id}
                        onClick={() => toggleUnit(unit)}
                        aria-pressed={active}
                        title={
                          takenBySomeoneElse
                            ? en
                              ? 'Somebody is already recorded in this unit'
                              : 'يوجد شاغل مسجَّل في هذه الوحدة'
                            : undefined
                        }
                        className={cn(
                          'flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-xs transition-colors',
                          active
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'hover:bg-accent disabled:opacity-40',
                        )}
                      >
                        {active ? <Link2 className="size-3" aria-hidden /> : null}
                        <span dir="ltr">{unit.unitCode}</span>
                        {/*
                          A dot, not a refusal. Co-ownership and an owner abroad
                          with a tenant in the flat are both ordinary (D2), so a
                          unit that already has somebody in it is flagged for the
                          officer to notice — not blocked.
                        */}
                        {takenBySomeoneElse ? (
                          <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {en
                  ? 'Nothing is selected by default — a twelve-flat building says nothing about how many of them one person holds.'
                  : 'لا شيء محدَّد افتراضياً — وجود اثنتي عشرة شقة في مبنى لا يعني أن الشخص يملكها كلها.'}
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A signed floor rendered the way a person says it.
 *
 * `Unit.floor` is an integer and `BuildingUnit.floor` is free text, so seeding a
 * card row from a canonical unit crosses that boundary. `parseFloorLabel` is the
 * door back the other way; this is the door out, and it writes «الأرضي» rather
 * than «0» because that is what the register has always held.
 */
function floorText(floor: number, en: boolean): string {
  if (floor === 0) return en ? 'Ground' : 'الأرضي';
  if (floor < 0) return en ? `Basement ${Math.abs(floor)}` : `قبو ${Math.abs(floor)}`;
  return String(floor);
}
