import { useEffect, useState } from 'react';
import { CalendarDays, Loader2 } from 'lucide-react';
import { type UnitWithOccupants } from '@/lib/api-client';
import { monthNames } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { DatePicker } from '@/components/ui/date-picker';
import { today } from '../../building-unit-forms';

// ─────────────────────────────  «مسكن موسمي»  ─────────────────────────────

/**
 * The facts a council needs to decide how a seasonal home is billed — recorded,
 * not decided.
 *
 * Shown for a unit whose state is «مسكن موسمي». The owner still bears the
 * occupancy fee by default: a building is presumed occupied until a تصريح
 * بالشغور is filed (هيئة التشريع والاستشارات 725/2003), and the fee is owed for
 * months actually occupied (Law 60/1988, Art. 11). So this asks which months
 * the owners are usually here, when they last were, and whether a declaration
 * has been filed — the three things that decision turns on.
 */
export function SeasonalHomePanel({
  unit,
  locale,
  busy,
  canWrite,
  onSave,
}: {
  unit: UnitWithOccupants;
  locale: string;
  busy: boolean;
  canWrite: boolean;
  onSave: (values: {
    presenceMonths: number[];
    ownerLastStayAt: string | null;
    vacancyDeclaredAt: string | null;
  }) => void;
}) {
  const en = locale === 'en';
  const [months, setMonths] = useState<number[]>(unit.presenceMonths ?? []);
  const [lastStay, setLastStay] = useState(unit.ownerLastStayAt?.slice(0, 10) ?? '');
  const [declared, setDeclared] = useState(unit.vacancyDeclaredAt?.slice(0, 10) ?? '');

  useEffect(() => {
    setMonths(unit.presenceMonths ?? []);
    setLastStay(unit.ownerLastStayAt?.slice(0, 10) ?? '');
    setDeclared(unit.vacancyDeclaredAt?.slice(0, 10) ?? '');
  }, [unit.id, unit.presenceMonths, unit.ownerLastStayAt, unit.vacancyDeclaredAt]);

  const toggle = (month: number) =>
    setMonths((current) =>
      current.includes(month)
        ? current.filter((m) => m !== month)
        : [...current, month].sort((a, b) => a - b),
    );

  return (
    <div className="space-y-3 rounded-md border border-info/30 bg-info/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <CalendarDays className="size-3.5 text-info" aria-hidden />
        {en ? 'Seasonal home — owners live elsewhere' : 'مسكن موسمي — أصحابه مقيمون خارج البلدة'}
      </p>

      <fieldset className="space-y-1.5" disabled={!canWrite}>
        <legend className="text-xs text-muted-foreground">
          {en ? 'Months the owners are usually here' : 'الأشهر التي يحضر فيها أصحابه عادةً'}
        </legend>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          {monthNames(locale).map((label, index) => {
            const month = index + 1;
            const on = months.includes(month);
            return (
              <button
                key={month}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(month)}
                className={cn(
                  'min-h-9 rounded-md border px-1.5 text-xs transition-colors',
                  on ? 'border-info/60 bg-info/15 font-medium' : 'hover:bg-accent',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-3">
        <Field label={en ? 'Last stayed' : 'آخر إقامة لأصحابه'} htmlFor="seasonal-last-stay">
          <DatePicker
            id="seasonal-last-stay"
            value={lastStay}
            onChange={setLastStay}
            max={today()}
            disabled={!canWrite}
            locale={en ? 'en' : 'ar'}
            clearable
          />
        </Field>
        <Field
          label={en ? 'Vacancy declaration filed on' : 'تاريخ تقديم تصريح بالشغور'}
          htmlFor="seasonal-declared"
        >
          <DatePicker
            id="seasonal-declared"
            value={declared}
            onChange={setDeclared}
            max={today()}
            disabled={!canWrite}
            locale={en ? 'en' : 'ar'}
            clearable
          />
        </Field>
      </div>

      {canWrite ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            onSave({
              presenceMonths: months,
              ownerLastStayAt: lastStay || null,
              vacancyDeclaredAt: declared || null,
            })
          }
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {en ? 'Save seasonal details' : 'حفظ بيانات السكن الموسمي'}
        </Button>
      ) : null}
    </div>
  );
}
