'use client';

import type { ComponentProps } from 'react';
import { Building2, Plus } from 'lucide-react';
import { PropertyCard, type PropertyDraft } from '@/components/citizen/property-card';
import type { PropertyGroup } from '@/lib/citizen-form-state';
import { scopeErrors } from '@/lib/utils';

type CardProps = ComponentProps<typeof PropertyCard>;

/**
 * The property cards, grouped by shared رقم العقار (GOD-22, phase 2c).
 *
 * A lone card for a single-property parcel, or a headed cluster of «الملكية N»
 * cards plus one shared add-button for a parcel carrying several. Moved out of
 * `CitizenForm` with its JSX unchanged: what it read from the form's scope is a
 * prop now, under the same name. The groups come from `groupProperties`.
 */
export function PropertyCards({
  tenant,
  token,
  citizenId,
  locale,
  properties,
  groups,
  allowedTypes,
  collapsed,
  reviewing,
  shown,
  canAnswerLandlord,
  ownerRecord,
  residence,
  lockedCensusTarget,
  toggleCollapsed,
  setProperty,
  addProperty,
  removeProperty,
  removeEndedRows,
  setRosterParcel,
}: {
  tenant: string;
  token?: string | null;
  citizenId?: string;
  locale: string;
  properties: readonly PropertyDraft[];
  groups: readonly PropertyGroup[];
  allowedTypes: CardProps['allowedTypes'];
  /** Which cards are folded shut (ignored while the unverified list is open). */
  collapsed: ReadonlySet<number>;
  reviewing: boolean;
  /** The errors on screen, keyed `properties.<index>.<field>`. */
  shown: Record<string, string>;
  canAnswerLandlord: boolean;
  ownerRecord: boolean;
  residence: CardProps['recordKind'];
  lockedCensusTarget: CardProps['lockedCensusTarget'] | undefined;
  toggleCollapsed: (index: number) => void;
  setProperty: (index: number, update: (current: PropertyDraft) => PropertyDraft) => void;
  addProperty: (sameParcelAs?: number) => void;
  removeProperty: (index: number, answer?: Parameters<NonNullable<CardProps['onRemove']>>[0]) => void;
  removeEndedRows: (index: number, rowIds: readonly string[]) => void;
  setRosterParcel: (parcel: string) => void;
}): React.JSX.Element {
  return (
    <>
      {groups.map((group) => {
        if (group.indices.length === 1) {
          const index = group.indices[0];
          const property = properties[index];
          return (
            <PropertyCard
              key={property.id ?? index}
              tenant={tenant}
              index={index}
              draft={property}
              citizenId={citizenId}
              allowedTypes={allowedTypes}
              collapsed={!reviewing && collapsed.has(index)}
              onToggleCollapse={() => toggleCollapsed(index)}
              onChange={(update) => setProperty(index, update)}
              onAddOnSameParcel={() => addProperty(index)}
              onViewParcel={token ? setRosterParcel : undefined}
              onRemove={(answer) => removeProperty(index, answer)}
              // Ended on the server, kept there as history — no longer this form's.
              // A partial end leaves the card here without the rows that ended.
              onEnded={(result, cardEnded) =>
                cardEnded ? removeProperty(index) : removeEndedRows(index, result.endedRowIds ?? [])
              }
              // Zero properties is a valid registration, so the last remaining
              // card is removable too — not just every card after the first.
              canRemove
              errors={scopeErrors(shown, `properties.${index}`)}
              locale={locale}
              token={token}
              censusPicker
              canAnswerLandlord={canAnswerLandlord}
              nonResident={ownerRecord}
              recordKind={residence}
              // Only the first card inherits a matrix launch: the officer opened
              // one flat, and pinning every card they go on to add to it would
              // link properties they never said were in that building.
              lockedCensusTarget={index === 0 ? (lockedCensusTarget ?? null) : null}
            />
          );
        }

        return (
          <div key={group.propertyNumber} className="review-body review-group space-y-3">
            <div className="flex items-center gap-2 border-b-2 border-primary/30 pb-2 text-primary">
              <Building2 className="size-4 shrink-0" aria-hidden />
              <span className="text-sm font-semibold">
                {locale === 'en'
                  ? `Parcel ${group.propertyNumber} — ${group.indices.length} properties`
                  : `العقار رقم ${group.propertyNumber} — ${group.indices.length} ملكيات`}
              </span>
            </div>

            {group.indices.map((index, unitPosition) => {
              const property = properties[index];
              return (
                <PropertyCard
                  key={property.id ?? index}
                  tenant={tenant}
                  index={index}
                  draft={property}
                  citizenId={citizenId}
                  allowedTypes={allowedTypes}
                  collapsed={!reviewing && collapsed.has(index)}
                  onToggleCollapse={() => toggleCollapsed(index)}
                  onChange={(update) => setProperty(index, update)}
                  onViewParcel={token ? setRosterParcel : undefined}
                  onRemove={(answer) => removeProperty(index, answer)}
                  onEnded={(result, cardEnded) =>
                    cardEnded ? removeProperty(index) : removeEndedRows(index, result.endedRowIds ?? [])
                  }
                  canRemove
                  errors={scopeErrors(shown, `properties.${index}`)}
                  locale={locale}
                  token={token}
                  censusPicker
                  canAnswerLandlord={canAnswerLandlord}
                  nonResident={ownerRecord}
                  recordKind={residence}
                  lockedCensusTarget={index === 0 ? (lockedCensusTarget ?? null) : null}
                  title={locale === 'en' ? `Unit ${unitPosition + 1}` : `الملكية ${unitPosition + 1}`}
                />
              );
            })}

            <button
              type="button"
              onClick={() => addProperty(group.indices[0])}
              className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-primary/50 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/5"
            >
              <Plus className="size-3.5 shrink-0" aria-hidden />
              {locale === 'en'
                ? 'Add another property on this parcel'
                : 'إضافة ملكية أخرى على هذا العقار'}
            </button>
          </div>
        );
      })}
    </>
  );
}
