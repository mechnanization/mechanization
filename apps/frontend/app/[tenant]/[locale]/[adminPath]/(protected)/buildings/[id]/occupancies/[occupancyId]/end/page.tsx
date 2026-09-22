'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2, UserMinus, UserPlus, UserRound } from 'lucide-react';
import { getLabels, mayTransferOwnership } from '@mechanization/shared-schemas';
import type { OccupancyEndReason } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  endOccupancy,
  getBuilding,
  logApiError,
  type AfterTenancyAnswer,
  type BuildingDetail,
  type UnitOccupant,
  type UnitWithOccupants,
} from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { formatDate } from '@/lib/dates';
import {
  asksUnitStatus,
  endActionLabel,
  reasonsFor,
  todayIso,
} from '@/components/admin/building-unit-forms';
import {
  AfterTenancyQuestion,
  afterTenancyComplete,
  afterTenancyPayload,
  endTenancyMessage,
} from '@/components/admin/after-tenancy-question';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
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
import { FactGrid, FactGridCell } from '@/components/ui/facts';
import { ChoiceCard, Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';

/**
 * «إنهاء الملكية» / «إنهاء الإيجار» — one spell, on a page of its own.
 *
 * ## Why this is not a dialog any more
 *
 * It asks four things — who, why, when, and what the flat is now — and the
 * last of them is itself a four-way question with a follow-up. Stacked into a
 * modal on a phone, the radio cards and the date sat below the fold of a box
 * that was already scrolling inside a scrolling page, and the officer could
 * not see the person's name while answering what their flat had become. A
 * route also means the answer survives a rotation, can be reached again from
 * history, and is somewhere an officer can be sent.
 *
 * ## What did not change
 *
 * Every rule is the one the dialog asked by, and still lives where it did:
 * `reasonsFor` for which reasons fit a capacity, `asksUnitStatus` for whether
 * the flat has to be spoken for, `afterTenancyComplete` for when the answer is
 * finished, and the same `endOccupancy` call with the same payload — the date
 * sent only when it is not today, the after-status only when it was asked.
 * The server is the authority on all of it and refuses what this lets through.
 */
export default function EndOccupancyPage({
  params,
}: {
  params: Promise<{
    tenant: string;
    locale: string;
    adminPath: string;
    id: string;
    occupancyId: string;
  }>;
}) {
  const { tenant, locale, adminPath, id, occupancyId } = use(params);
  const router = useRouter();
  const toast = useToast();
  const en = locale === 'en';
  const labels = getLabels(locale);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const matrix = `${base}/buildings/${id}/matrix`;

  const [token, setToken] = useState<string | null>(null);
  /** The signed-in officer's role — what «بيع أو نقل ملكية» is offered on. */
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [building, setBuilding] = useState<BuildingDetail | null>(null);

  const [reason, setReason] = useState<OccupancyEndReason | null>(null);
  const [toDate, setToDate] = useState(todayIso());
  const [after, setAfter] = useState<AfterTenancyAnswer>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** «هل تسجّل المالك الجديد؟», after a sale has been written. */
  const [successor, setSuccessor] = useState(false);

  const load = useCallback(async () => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setRole(session.user.role ?? null);
    setLoading(true);
    setLoadError(null);
    try {
      setBuilding(await getBuilding(tenant, session.accessToken, id));
    } catch (caught) {
      logApiError(caught);
      setLoadError(
        caught instanceof ApiRequestError
          ? caught.message
          : en
            ? 'Could not load the unit.'
            : 'تعذّر تحميل الوحدة.',
      );
    } finally {
      setLoading(false);
    }
  }, [base, en, id, router, tenant]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
    The unit is found through the spell rather than named in the route: one
    occupancy belongs to exactly one flat, and a URL that carried both could be
    edited into a pair that does not go together.
  */
  const found = useMemo((): { unit: UnitWithOccupants; occupant: UnitOccupant } | null => {
    for (const unit of building?.units ?? []) {
      const occupant = unit.occupants.find((row) => row.id === occupancyId);
      if (occupant) return { unit, occupant };
    }
    return null;
  }, [building, occupancyId]);

  if (loading) {
    return <LoadingState fullHeight label={en ? 'Loading…' : 'جارٍ التحميل…'} />;
  }
  if (loadError || !building) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <BackLink fallbackHref={matrix} label={en ? 'Back' : 'رجوع'} className="text-sm" />
        <ErrorState description={loadError ?? undefined} onRetry={() => void load()} />
      </div>
    );
  }

  /*
    Gone rather than broken: a spell ended in another tab, or a link followed
    twice. The server refuses the second end anyway («هذا الإشغال منتهٍ
    مسبقاً») — this says so before the officer fills the form again.
  */
  if (!found || found.occupant.toDate !== null) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <BackLink fallbackHref={matrix} label={en ? 'Back' : 'رجوع'} className="text-sm" />
        <ErrorState
          title={en ? 'This spell is no longer open' : 'هذا الإشغال لم يعد قائماً'}
          description={
            en
              ? 'It has already been ended, or it is not recorded on this building.'
              : 'إمّا أنه أُنهي سابقاً، أو أنه غير مسجَّل على هذا المبنى.'
          }
        />
      </div>
    );
  }

  const { unit, occupant } = found;
  const unitCode = `${building.code}-${unit.unitCode}`;
  const name = occupant.citizenName ?? (en ? 'this person' : 'هذا الشخص');
  const action = endActionLabel(occupant.role, en);
  const tenancy = occupant.role !== 'OWNER';
  const ownership = !tenancy;

  /*
    An ownership is asked only after a sale — «سُجِّل بالخطأ» says it never
    stood, and the server clears what it asserted without being told. A tenancy
    asks on either reason. See `asksUnitStatus` for the other half of the rule:
    whether anybody is left to speak for the flat at all.
  */
  const leavesUnspoken = asksUnitStatus(unit, occupant);
  const asking = leavesUnspoken && (tenancy || reason === 'OWNERSHIP_TRANSFERRED');
  const ready = Boolean(reason) && (!asking || afterTenancyComplete(after));
  /** A sale, written: the flat has an owner the register has not met yet. */
  const offersSuccessor = ownership && reason === 'OWNERSHIP_TRANSFERRED';
  /*
    Recording a sale is an office decision — see `mayTransferOwnership`, which
    the server enforces and this reads so the answer arrives before the press
    rather than as a 403 over a filled-in form.

    Shown greyed with its reason rather than removed. An inspector who sees no
    such option concludes the register cannot record a sale, and the nearest
    thing on the screen is «سُجِّلت بالخطأ» — which would erase a real ownership
    as though it had never existed. That is the harm this restriction is for,
    so the option stays visible and says who to ask.
  */
  const mayTransfer = mayTransferOwnership(role);
  const barred = (option: OccupancyEndReason) =>
    option === 'OWNERSHIP_TRANSFERRED' && !mayTransfer;

  const submit = async () => {
    if (!token || !reason || !ready || submitting || barred(reason)) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await endOccupancy(tenant, token, occupant.id, {
        reason,
        // Today is the server's default; only a back-dated end is sent.
        ...(toDate && toDate !== todayIso() ? { toDate } : {}),
        ...(asking ? afterTenancyPayload(after) : {}),
      });
      toast.success(endTenancyMessage(result, locale));
      if (offersSuccessor) {
        setSuccessor(true);
        return;
      }
      router.push(`${matrix}?unit=${encodeURIComponent(unit.id)}`);
    } catch (caught) {
      logApiError(caught);
      setSubmitError(
        caught instanceof ApiRequestError
          ? caught.message
          : en
            ? 'Could not end the occupancy.'
            : 'تعذّر إنهاء الإشغال.',
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={matrix} label={en ? 'Back' : 'رجوع'} className="text-sm" />

      <PageHeader
        icon={ownership ? KeyRound : UserMinus}
        title={en ? `${action} — unit ${unitCode}` : `${action} للوحدة ${unitCode}`}
        subtitle={
          en
            ? `${name} · ${labels.occupancyRole[occupant.role]} · since ${formatDate(occupant.fromDate)}`
            : `${name} · ${labels.occupancyRole[occupant.role]} · منذ ${formatDate(occupant.fromDate)}`
        }
        actions={
          <Badge variant="soft-muted" className="px-3 py-1 text-sm">
            {labels.occupancyRole[occupant.role]}
          </Badge>
        }
      />

      {submitError ? <Alert tone="error">{submitError}</Alert> : null}

      {/*
        One column, both cards the width of the page.

        The card below was a sidebar, and a sidebar is where a phone puts
        things last: on the screens this is actually used on it had already
        collapsed underneath, so the desktop split was buying a narrow column
        nobody read in exchange for a layout that changed shape between the two.
        Stacked, the order is the order of the work — decide, then check who and
        press — and the same on every width. What varies is how each card
        distributes its own contents.
      */}
      <div className="space-y-6">
        {/* ── What is being answered ─ */}
        <div className="space-y-5 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
          {/*
            No default, because a pre-selected answer is exactly what muscle
            memory confirms — the reason is what tells a sale from a departure
            from a spell that never existed.
          */}
          <Field label={en ? 'Why?' : 'السبب'} htmlFor="end-reason" required>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" id="end-reason">
              {reasonsFor(occupant.role).map((option) => (
                <ChoiceCard
                  key={option}
                  name="end-reason"
                  value={option}
                  checked={reason === option}
                  disabled={barred(option)}
                  onChange={(next) => setReason(next as OccupancyEndReason)}
                  title={labels.occupancyEndReason[option]}
                  description={
                    barred(option)
                      ? en
                        ? 'Needs an administrative role — ask a supervisor to record the sale.'
                        : 'يحتاج صلاحية إدارية — اطلب من المشرف تسجيل البيع.'
                      : undefined
                  }
                />
              ))}
            </div>
          </Field>

          {reason ? (
            <Field
              label={en ? 'When did it end?' : 'تاريخ الانتهاء'}
              htmlFor="end-occupancy-date"
            >
              <Input
                id="end-occupancy-date"
                type="date"
                min={occupant.fromDate.slice(0, 10)}
                max={todayIso()}
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
                dir="ltr"
                className="text-start sm:max-w-xs"
              />
            </Field>
          ) : null}

          {asking && reason ? (
            <div className="rounded-lg border border-primary/30 bg-primary/[0.03] p-3 sm:p-4">
              <AfterTenancyQuestion
                value={after}
                onChange={setAfter}
                scope={tenancy ? 'TENANCY' : 'OWNERSHIP'}
                locale={locale}
              />
            </div>
          ) : null}

          {/*
            The flat, when it is not being asked about — because both silences
            have a reason and neither is obvious from a missing question.
          */}
          {reason && !asking ? (
            <Alert tone="muted" size="sm" icon={false}>
              {leavesUnspoken
                ? en
                  ? 'The ownership never stood, so what it said about the unit’s use is cleared.'
                  : 'الملكية لم تكن قائمة، فيُمسح ما كانت تقوله عن استعمال الوحدة.'
                : tenancy
                  ? en
                    ? 'Someone else is still recorded living in this unit, so its status stays as it is.'
                    : 'ما زال شخص آخر مسجَّلاً ساكناً في هذه الوحدة، فتبقى حالتها كما هي.'
                  : en
                    ? 'Someone else is still recorded on this unit, so its status stays as it is.'
                    : 'ما زال أحد مسجَّلاً على هذه الوحدة، فتبقى حالتها كما هي.'}
            </Alert>
          ) : null}
        </div>

        {/* ── Who and what, and the way out ─ */}
        <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex items-center gap-2 border-b pb-3">
            <Icon as={UserRound} className="text-muted-foreground" />
            <p className="min-w-0 truncate text-sm font-semibold">{name}</p>
          </div>

          {/*
            Four across on a desktop, two on a tablet, one on a phone — and the
            cells that may be absent are last, so a flat with no أسهم and no
            number does not leave a hole in the middle of the row.
          */}
          <FactGrid>
            <FactGridCell
              label={en ? 'Unit' : 'الوحدة'}
              className="font-mono"
              value={unitCode}
            />
            <FactGridCell
              label={en ? 'Capacity' : 'الصفة'}
              value={labels.occupancyRole[occupant.role]}
            />
            <FactGridCell label={en ? 'Since' : 'منذ'} value={formatDate(occupant.fromDate)} />
            {occupant.shares ? (
              <FactGridCell
                label={en ? 'Shares' : 'الأسهم'}
                value={en ? `${occupant.shares}/2400` : `${occupant.shares}/٢٤٠٠`}
              />
            ) : null}
            {occupant.citizenPhone ? (
              <FactGridCell
                label={en ? 'Phone' : 'الهاتف'}
                className="font-mono"
                value={
                  /*
                    A link, not text: the officer reading this card is the
                    person who has to ring whoever is recorded on the flat.
                  */
                  <a href={`tel:${occupant.citizenPhone}`} dir="ltr" className="text-primary">
                    {occupant.citizenPhone}
                  </a>
                }
              />
            ) : null}
          </FactGrid>

          <Alert tone="muted" size="sm" icon={false}>
            {tenancy
              ? en
                ? 'They move to «Former» on this unit and stop being charged for it. Their card stays on their file as an ended tenancy, documents included, and the owner stays the owner.'
                : 'ينتقل إلى «سابق» على هذه الوحدة وتتوقف رسومها عليه. تبقى بطاقته في ملفه كإيجار منتهٍ مع مستنداتها، ويبقى المالك مالكاً.'
              : en
                ? 'They move to «Former» on this unit, the unit is released from their file, and fees for it stop being charged to them.'
                : 'ينتقل إلى «سابق» على هذه الوحدة، وتُفصل الوحدة عن ملفه، وتتوقف الرسوم عليه عنها.'}
          </Alert>

          {/*
            The action, at the end of what it acts on.

            48px tall wherever it is, because it is pressed with a thumb in a
            stairwell. Full width on a phone, where it is the only thing the
            thumb should be able to reach; from `sm` it takes the end of its
            own row with «إلغاء» beside it, rather than stretching across a
            desktop as a metre of red. `flex-col-reverse` keeps the destructive
            one nearest the thumb on a phone while reading last in the source.
          */}
          <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-end">
            <Button variant="ghost" className="w-full sm:w-auto" asChild>
              <Link href={matrix}>{en ? 'Cancel' : 'إلغاء'}</Link>
            </Button>
            <Button
              size="lg"
              variant="destructive"
              className="h-12 w-full text-base font-bold sm:w-auto sm:min-w-64"
              disabled={!ready || submitting}
              onClick={() => void submit()}
            >
              {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {action}
            </Button>
          </div>
        </div>
      </div>

      {/*
        «هل تسجّل المالك الجديد؟» — raised here rather than on the matrix so it
        follows the write that earns it, and only that write: a sale says the
        flat has an owner the register has not met, while a correction says
        nobody should have been recorded at all. Answering it is what carries
        the officer back, either way.
      */}
      <Dialog
        open={successor}
        onOpenChange={(open) => {
          if (!open) router.push(`${matrix}?unit=${encodeURIComponent(unit.id)}`);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{en ? 'Ownership ended' : 'انتهت الملكية'}</DialogTitle>
            <DialogDescription>
              {en
                ? `The ownership of unit ${unitCode} has ended. Record the new owner now?`
                : `أُنهيت الملكية على الوحدة ${unitCode}. هل تريد تسجيل المالك الجديد الآن؟`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => router.push(`${matrix}?unit=${encodeURIComponent(unit.id)}`)}
            >
              {en ? 'Not now' : 'لاحقاً'}
            </Button>
            <Button
              className="w-full sm:w-auto"
              onClick={() =>
                router.push(`${matrix}?unit=${encodeURIComponent(unit.id)}&addOwner=1`)
              }
            >
              <UserPlus className="size-4" aria-hidden />
              {en ? 'Yes, add the new owner' : 'نعم، أضف المالك الجديد'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
