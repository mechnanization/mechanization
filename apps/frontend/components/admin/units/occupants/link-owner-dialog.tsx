import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { type UnitOccupant } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * «ربط بالمالك» — which of the flat's owners a tenant already on it rents from.
 *
 * Among co-owners the one chosen is the one the tenant deals with; the rest
 * stay recorded as owners. Nothing is chosen for the officer when there is more
 * than one.
 *
 * An owner recorded on the flat after the tenant is offered too, but said so,
 * and the link waits for a tick: the owner list is the evidence a pick rests
 * on, and a name added to it later is a later claim about a tenancy already on
 * file — which the officer is the one able to check.
 */
export function LinkOwnerDialog({
  occupant,
  owners,
  unitCode,
  locale,
  onOpenChange,
  onConfirm,
}: {
  occupant: UnitOccupant | null;
  owners: UnitOccupant[];
  unitCode: string;
  locale: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (ownerId: string, confirmRecordedAfter: boolean) => Promise<void>;
}) {
  const en = locale === 'en';
  const [choice, setChoice] = useState<string | null>(null);
  const [confirmedAfter, setConfirmedAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (occupant) {
      setChoice(owners.length === 1 ? owners[0]!.citizenId : null);
      setConfirmedAfter(false);
      setBusy(false);
      setFailure(null);
    }
    // Reset per tenant opened, not per re-render of the owner list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occupant?.id]);

  if (!occupant) return null;

  const recordedAfter = (owner: UnitOccupant) =>
    (owner.recordedAt ?? owner.fromDate) > (occupant.recordedAt ?? occupant.fromDate);
  const chosenOwner = owners.find((owner) => owner.citizenId === choice);
  const needsConfirmation = Boolean(chosenOwner && recordedAfter(chosenOwner));

  const confirm = async () => {
    if (!choice || busy || (needsConfirmation && !confirmedAfter)) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm(choice, needsConfirmation);
      onOpenChange(false);
    } catch (caught) {
      setFailure(
        caught instanceof Error && caught.message
          ? caught.message
          : en
            ? 'Could not link the owner.'
            : 'تعذّر الربط بالمالك.',
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <DialogTitle>
            {en
              ? `Who does ${occupant.citizenName ?? 'the tenant'} rent ${unitCode} from?`
              : `ممّن يستأجر ${occupant.citizenName ?? 'المستأجر'} الوحدة ${unitCode}؟`}
          </DialogTitle>
          <DialogDescription>
            {owners.length > 1
              ? en
                ? 'Choose the owner they deal with. The other owners stay recorded as owners of the unit.'
                : 'اختر المالك الذي يتعامل معه. يبقى المالكون الآخرون مسجَّلين مالكين للوحدة.'
              : en
                ? 'The tenancy on their file will name this owner.'
                : 'ستُسجَّل بطاقة الإيجار في ملفه باسم هذا المالك.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2" role="radiogroup">
          {owners.map((owner) => (
            <button
              key={owner.citizenId}
              type="button"
              role="radio"
              aria-checked={choice === owner.citizenId}
              onClick={() => {
                setChoice(owner.citizenId);
                setConfirmedAfter(false);
              }}
              className={cn(
                'flex min-h-11 flex-wrap items-center gap-x-2 rounded-md border px-3 py-2 text-start text-sm transition-colors',
                choice === owner.citizenId
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'hover:bg-accent',
              )}
            >
              <span>{owner.citizenName ?? (en ? 'Unnamed' : 'بلا اسم')}</span>
              {owner.citizenPhone ? (
                <span dir="ltr" className="font-mono text-xs font-normal text-muted-foreground">
                  {owner.citizenPhone}
                </span>
              ) : null}
              {owner.shares ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {en ? `${owner.shares}/2400 shares` : `${owner.shares}/٢٤٠٠ سهم`}
                </span>
              ) : null}
              {recordedAfter(owner) ? (
                <span className="basis-full text-xs font-normal text-warning">
                  {en ? 'Recorded on the unit after the tenant' : 'سُجِّل على الوحدة بعد المستأجر'}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {needsConfirmation ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs leading-relaxed">
            <Checkbox
              className="mt-0.5"
              checked={confirmedAfter}
              onCheckedChange={(checked) => setConfirmedAfter(checked === true)}
            />
            <span>
              {en
                ? `${chosenOwner?.citizenName ?? 'This owner'} was recorded on the unit after ${occupant.citizenName ?? 'the tenant'}. I confirm this is who they rent from.`
                : `سُجِّل ${chosenOwner?.citizenName ?? 'هذا المالك'} على الوحدة بعد ${occupant.citizenName ?? 'المستأجر'}. أؤكّد أنه من يستأجر منه.`}
            </span>
          </label>
        ) : null}

        {failure ? (
          <Alert variant="destructive" live="alert">
            {failure}
          </Alert>
        ) : null}

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="w-full sm:w-auto">
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={busy || !choice || (needsConfirmation && !confirmedAfter)}
            className="w-full sm:w-auto"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {en ? 'Link' : 'ربط'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
