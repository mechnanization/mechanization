'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Link2, Loader2, Search, Unlink, UserRound, X } from 'lucide-react';
import type { CaseUnitOccupant, CitizenListItem } from '@/lib/api-client';
import { listCitizens, logApiError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
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
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const SEARCH_DEBOUNCE_MS = 350;

export type CaseLinkRole = 'OWNER' | 'TENANT' | 'FREE_OCCUPANT';

/** One person the dialog will link, and — on a case pinned to a unit — in what capacity. */
export interface CaseLinkPerson {
  citizenId: string;
  name: string;
  role: CaseLinkRole;
  /** Already recorded on the unit in this role: linked to the case, not recorded again. */
  onUnit: boolean;
  /** Tenants and free occupants: which of the unit's owners they hold it from. */
  landlordCitizenId?: string;
}

/** What «ربط» asks the page to do. */
export interface CaseLinkSubmission {
  people: CaseLinkPerson[];
  /** The one the case is resolved by — the case holds a single citizen. */
  primaryId: string;
  /**
   * «من يشغل الوحدة؟», asked only when owners are being recorded and nobody
   * who lives there is: `OWNER_OCCUPIED` or `RENTED`, or null when unknown.
   */
  ownerUnitStatus: 'OWNER_OCCUPIED' | 'RENTED' | null;
}

/**
 * «ربط بمواطن» — the bridge from a حالة to the people it was about.
 *
 * ## Who, and as what
 *
 * A case pinned to a census unit is answered by people *on that unit*, and
 * each of them is there as something: the owner, a tenant, a شاغل بتسامح. So
 * the dialog collects people rather than linking the first one pressed, and
 * asks each one's capacity. Whoever is not yet recorded on the unit is
 * recorded in that capacity when the link is made — the same occupancy the
 * unit matrix records — so the case and the census say the same thing.
 *
 * ## Several owners
 *
 * One flat can have several owners — heirs, co-owners on one deed — so any
 * number can be added as «مالك». A tenant is asked which owner they hold the
 * flat from when there is more than one; with exactly one, it is that one.
 * The case itself holds a single citizen, so one person is marked as the one
 * it is resolved by: the resident when there is one, else the first owner.
 *
 * A case not pinned to a unit has no census row to record a capacity on, so
 * there the dialog only links, as before.
 *
 * People already recorded on the unit are offered first: they are almost
 * always who the case is about.
 */
export function LinkCaseCitizenDialog({
  open,
  onOpenChange,
  tenant,
  token,
  currentCitizenName,
  submitting,
  error,
  onSubmit,
  onUnlink,
  suggested = [],
  unitLabel = null,
  locale = 'ar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  token: string;
  /** Set when this case already has a linked citizen — offers Unlink instead of a fresh search. */
  currentCitizenName?: string | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (submission: CaseLinkSubmission) => void;
  onUnlink: () => void;
  /** The people the census records on the case's unit. */
  suggested?: CaseUnitOccupant[];
  /** The case's unit, e.g. «Z-5-786-A · 0301» — null when it is not pinned to one, and no capacity is recorded. */
  unitLabel?: string | null;
  locale?: string;
}) {
  const en = locale === 'en';
  const onUnit = Boolean(unitLabel);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CitizenListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [people, setPeople] = useState<CaseLinkPerson[]>([]);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [ownerUnitStatus, setOwnerUnitStatus] = useState<'OWNER_OCCUPIED' | 'RENTED' | ''>('');

  useEffect(() => {
    if (!open) {
      setTerm('');
      setResults([]);
      setPeople([]);
      setPrimaryId(null);
      setOwnerUnitStatus('');
    }
  }, [open]);

  useEffect(() => {
    if (!open || !term.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      listCitizens(tenant, token, { search: term.trim(), limit: 8 })
        .then((result) => {
          // A file «دمج ملفين» folded into another is not who the door resolves to.
          if (!cancelled) setResults(result.items.filter((row) => !row.mergedIntoId));
        })
        .catch((caught) => {
          logApiError(caught);
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, term, tenant, token]);

  const roleLabel: Record<CaseLinkRole, string> = en
    ? { OWNER: 'Owner', TENANT: 'Tenant', FREE_OCCUPANT: 'Free occupant' }
    : { OWNER: 'مالك', TENANT: 'مستأجر', FREE_OCCUPANT: 'شاغل بتسامح' };
  const roleOptions = (['OWNER', 'TENANT', 'FREE_OCCUPANT'] as const).map((value) => ({
    value,
    label: roleLabel[value],
  }));

  const chosen = (citizenId: string) => people.some((person) => person.citizenId === citizenId);
  const toggle = (person: CaseLinkPerson) =>
    setPeople((current) =>
      current.some((row) => row.citizenId === person.citizenId)
        ? current.filter((row) => row.citizenId !== person.citizenId)
        : [...current, person],
    );
  const update = (citizenId: string, patch: Partial<CaseLinkPerson>) =>
    setPeople((current) => current.map((row) => (row.citizenId === citizenId ? { ...row, ...patch } : row)));

  /** Every owner a tenant here could hold the flat from: those on the unit, and those being added. */
  const owners = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of suggested) if (row.role === 'OWNER') byId.set(row.citizenId, row.name);
    for (const row of people) if (row.role === 'OWNER') byId.set(row.citizenId, row.name);
    return [...byId].map(([citizenId, name]) => ({ citizenId, name }));
  }, [suggested, people]);

  const residentOnUnit = suggested.some((row) => row.role !== 'OWNER');
  const residentAdded = people.some((row) => row.role !== 'OWNER');
  const newOwners = people.filter((row) => row.role === 'OWNER' && !row.onUnit);
  // «من يشغل الوحدة؟» only when owners are recorded and nothing else on the flat answers it.
  const askOccupation = onUnit && newOwners.length > 0 && !residentOnUnit && !residentAdded;

  /*
    The case's own citizen. Chosen by the officer when they say so; until
    then the resident if there is one, else the first person added.
  */
  const effectivePrimary =
    (primaryId && people.some((row) => row.citizenId === primaryId) ? primaryId : null) ??
    people.find((row) => row.role !== 'OWNER')?.citizenId ??
    people[0]?.citizenId ??
    null;

  const submit = () => {
    if (!effectivePrimary || people.length === 0) return;
    onSubmit({
      people: people.map((row) => ({
        ...row,
        // With exactly one owner on the flat, a tenant holds it from that one.
        landlordCitizenId:
          row.role !== 'OWNER' ? (row.landlordCitizenId ?? (owners.length === 1 ? owners[0]!.citizenId : undefined)) : undefined,
      })),
      primaryId: effectivePrimary,
      ownerUnitStatus: askOccupation && ownerUnitStatus ? ownerUnitStatus : null,
    });
  };

  const pickTile = (person: { citizenId: string; name: string; detail: React.ReactNode }, add: () => void) => {
    const picked = chosen(person.citizenId);
    return (
      <button
        key={person.citizenId}
        type="button"
        disabled={submitting}
        aria-pressed={picked}
        onClick={add}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg border p-2.5 text-start transition-colors duration-150 ease-out disabled:opacity-50',
          picked ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'border-border/70 bg-card hover:bg-accent',
        )}
      >
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full',
            picked ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary',
          )}
        >
          {picked ? <Check className="size-4" aria-hidden /> : <UserRound className="size-4" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{person.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{person.detail}</span>
        </span>
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={en ? 'Close' : 'إغلاق'} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{en ? 'Link to a citizen' : 'ربط بمواطن'}</DialogTitle>
          <DialogDescription>
            {onUnit
              ? en
                ? `Choose who this case was about and what each of them is on unit ${unitLabel} — owner, tenant or free occupant. Anyone not yet on the unit is recorded on it in that capacity.`
                : `اختر من كانت الحالة عنهم، وصفة كلٍّ منهم في الوحدة ${unitLabel} — مالك أو مستأجر أو شاغل بتسامح. من ليس مسجَّلاً على الوحدة بعد يُسجَّل عليها بهذه الصفة.`
              : en
                ? 'Mark this case resolved by the registration it turned into — search by name, phone or reference number.'
                : 'اربط هذه الحالة بالتسجيل الذي نتجت عنه — ابحث بالاسم أو الهاتف أو الرقم المرجعي.'}
          </DialogDescription>
        </DialogHeader>

        {currentCitizenName ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-success/30 bg-success/5 p-3">
            <span className="flex items-center gap-2 text-sm font-medium text-success">
              <Link2 className="size-4 shrink-0" aria-hidden />
              {en ? 'Linked to' : 'مرتبطة بـ'} {currentCitizenName}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              disabled={submitting}
              onClick={onUnlink}
            >
              <Unlink className="size-3.5" aria-hidden />
              {en ? 'Unlink' : 'إلغاء الربط'}
            </Button>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {currentCitizenName ? null : (
          <>
            {suggested.length > 0 ? (
              <section className="space-y-1.5" aria-label={en ? 'On this unit' : 'على هذه الوحدة'}>
                <p className="text-xs font-medium text-muted-foreground">
                  {en ? 'Registered on this unit' : 'مسجَّلون على هذه الوحدة'}
                </p>
                {suggested.map((row) =>
                  pickTile({ citizenId: row.citizenId, name: row.name, detail: roleLabel[row.role] }, () =>
                    toggle({ citizenId: row.citizenId, name: row.name, role: row.role, onUnit: true }),
                  ),
                )}
              </section>
            ) : null}

            <div className="relative">
              <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                autoFocus
                className="ps-9"
                placeholder={en ? 'Search citizens…' : 'ابحث عن مواطن…'}
                aria-label={en ? 'Search citizens' : 'ابحث عن مواطن'}
                value={term}
                onChange={(event) => setTerm(event.target.value)}
              />
            </div>

            {term.trim() ? (
              <div className="max-h-56 space-y-1.5 overflow-y-auto">
                {searching ? (
                  <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {en ? 'Searching…' : 'جارٍ البحث…'}
                  </p>
                ) : results.length === 0 ? (
                  <p className="p-2 text-sm text-muted-foreground">{en ? 'No matching citizens.' : 'لا يوجد مواطنون مطابقون.'}</p>
                ) : (
                  results.map((citizen) => {
                    const existing = suggested.find((row) => row.citizenId === citizen.id);
                    return pickTile(
                      {
                        citizenId: citizen.id,
                        name: citizen.fullName,
                        detail: (
                          <bdi dir="ltr">{[citizen.phone, citizen.referenceNumber].filter(Boolean).join(' — ')}</bdi>
                        ),
                      },
                      () =>
                        toggle(
                          existing
                            ? { citizenId: existing.citizenId, name: existing.name, role: existing.role, onUnit: true }
                            : {
                                citizenId: citizen.id,
                                name: citizen.fullName,
                                // A first guess the officer changes: an owner is the commonest answer a case waits for.
                                role: 'OWNER',
                                onUnit: false,
                              },
                        ),
                    );
                  })
                )}
              </div>
            ) : null}

            {/* ── Who will be linked, and as what ───────────────────── */}
            {people.length > 0 ? (
              <section className="space-y-2" aria-label={en ? 'To be linked' : 'سيُربط'}>
                <p className="text-xs font-medium text-muted-foreground">
                  {en ? `To be linked (${people.length})` : `سيُربط (${people.length})`}
                </p>
                <ul className="space-y-2">
                  {people.map((person) => (
                    <li key={person.citizenId} className="space-y-2.5 rounded-lg border bg-muted/20 p-3">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{person.name}</span>
                        {people.length > 1 ? (
                          <button
                            type="button"
                            aria-pressed={effectivePrimary === person.citizenId}
                            onClick={() => setPrimaryId(person.citizenId)}
                            className={cn(
                              'shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              effectivePrimary === person.citizenId
                                ? 'bg-primary/15 text-primary'
                                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                            )}
                          >
                            {effectivePrimary === person.citizenId
                              ? en
                                ? 'The case is theirs'
                                : 'الحالة باسمه'
                              : en
                                ? 'Make the case theirs'
                                : 'اجعل الحالة باسمه'}
                          </button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={en ? `Remove ${person.name}` : `إزالة ${person.name}`}
                          onClick={() => toggle(person)}
                        >
                          <X className="size-4" aria-hidden />
                        </Button>
                      </div>

                      {onUnit ? (
                        person.onUnit ? (
                          <Badge variant="soft-muted">
                            {en
                              ? `Already on the unit as ${roleLabel[person.role].toLowerCase()}`
                              : `مسجَّل على الوحدة: ${roleLabel[person.role]}`}
                          </Badge>
                        ) : (
                          <SegmentedControl
                            size="sm"
                            aria-label={en ? `What ${person.name} is on the unit` : `صفة ${person.name} في الوحدة`}
                            value={person.role}
                            onChange={(value) =>
                              update(person.citizenId, { role: value as CaseLinkRole, landlordCitizenId: undefined })
                            }
                            options={roleOptions}
                          />
                        )
                      ) : null}

                      {/* Among several owners, the one this tenant holds the flat from. */}
                      {onUnit && !person.onUnit && person.role !== 'OWNER' && owners.length > 1 ? (
                        <Select
                          value={person.landlordCitizenId ?? ''}
                          onValueChange={(value) => update(person.citizenId, { landlordCitizenId: value })}
                        >
                          <SelectTrigger className="h-9 text-xs" aria-label={en ? 'Holds it from' : 'يشغلها من'}>
                            <SelectValue placeholder={en ? 'Holds it from which owner? (optional)' : 'من أيّ مالك؟ (اختياري)'} />
                          </SelectTrigger>
                          <SelectContent>
                            {owners
                              .filter((owner) => owner.citizenId !== person.citizenId)
                              .map((owner) => (
                                <SelectItem key={owner.citizenId} value={owner.citizenId}>
                                  {owner.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                    </li>
                  ))}
                </ul>

                {onUnit && newOwners.length > 1 ? (
                  <p className="text-xs text-muted-foreground">
                    {en
                      ? `${newOwners.length} owners will be recorded on the unit — co-owners. Shares can be set from the unit matrix.`
                      : `سيُسجَّل ${newOwners.length} مالكين على الوحدة — ملكية مشتركة. تُحدَّد الأسهم من مصفوفة الوحدات.`}
                  </p>
                ) : null}

                {askOccupation ? (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium">{en ? 'Who lives in the unit?' : 'من يشغل الوحدة؟'}</p>
                    <SegmentedControl
                      size="sm"
                      aria-label={en ? 'Who lives in the unit' : 'من يشغل الوحدة'}
                      value={ownerUnitStatus}
                      onChange={(value) => setOwnerUnitStatus(value as typeof ownerUnitStatus)}
                      options={[
                        { value: 'OWNER_OCCUPIED', label: en ? 'The owner' : 'المالك يسكنها' },
                        { value: 'RENTED', label: en ? 'Rented out' : 'مؤجرة' },
                        { value: '', label: en ? 'Not known yet' : 'لم يُعرف بعد' },
                      ]}
                    />
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {en ? 'Close' : 'إغلاق'}
          </Button>
          {currentCitizenName ? null : (
            <Button onClick={submit} disabled={submitting || people.length === 0}>
              {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
              {people.length > 1
                ? en
                  ? `Link ${people.length} people`
                  : `ربط ${people.length} أشخاص`
                : en
                  ? 'Link'
                  : 'ربط'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
