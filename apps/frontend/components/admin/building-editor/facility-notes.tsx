'use client';

import {
  AlertTriangle,
} from 'lucide-react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  type GridUnitDraft,
} from '../unit-grid-picker';

/**
 * The units left above the floor count, and the field notes.
 *
 * Moved out of `BuildingEditor` (GOD-21, phase 2) with its JSX unchanged: what it
 * read from the editor's scope is a prop under the same name.
 */
export function FacilityNotes({
  en,
  fieldErrors,
  name,
  setName,
  orphanedUnits,
  shellShortcut,
  warDamaged,
  notes,
  setNotes,
}: {
  en: boolean;
  fieldErrors: Record<string, string>;
  name: string;
  setName: React.Dispatch<React.SetStateAction<string>>;
  orphanedUnits: GridUnitDraft[];
  shellShortcut: boolean;
  warDamaged: boolean;
  notes: string;
  setNotes: React.Dispatch<React.SetStateAction<string>>;
}): React.JSX.Element {
  return (
    <>
      {/*
        «الرقم المكتوب على المبنى» is no longer asked for here.

        The value itself is not abandoned: `postedNumber` stays on the
        building, stays on the wire, and is still printed beside the
        allocated code wherever the two disagree — a collector in the
        street trusts the door. What is gone is the *input*, so this
        step stops asking an officer at a desk for a number that can
        only be read off the wall.

        Deliberately still sent on save, carrying whatever was loaded.
        Dropping it from the payload would have every edit of a
        building quietly blank a plaque number somebody had recorded.
      */}
      <Field
        label={en ? 'Building Name (Optional)' : 'اسم المبنى (اختياري)'}
        htmlFor="building-name"
        error={fieldErrors.name}
      >
        <Input
          id="building-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={en ? 'Al-Nour Building' : 'بناية النور'}
          className="h-10"
        />
      </Field>

      {orphanedUnits.length > 0 ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          {en
            ? `${orphanedUnits.length} unit(s) sit outside the current height of the matrix. Open the unit matrix to raise it or remove them.`
            : `${orphanedUnits.length} وحدة خارج ارتفاع المصفوفة الحالي. افتح مصفوفة الوحدات لرفع الارتفاع أو حذفها.`}
        </p>
      ) : null}

      {/*
        «عدد الطوابق» and «عدد الطوابق تحت الأرض» are not asked here.

        They were two number inputs on this step *and* two steppers on
        the matrix, and the duplication was the defect rather than the
        clutter: an officer typed «٦» here and then painted five floors
        there, and the two disagreed with nothing on either screen to
        say which one the save would believe. (It believed neither
        outright — `create` reconciles the count upward from the units,
        so the typed number only ever mattered when it was *larger*,
        which is the case nobody could see.)

        A floor count is a fact about the matrix. It is now asked where
        the matrix is, by the control that moves the grid — so what the
        officer is looking at is what gets saved, and there is no second
        number to contradict it.
      */}

      <Field
        label={en ? 'Field Notes (Optional)' : 'ملاحظات ميدانية (اختياري)'}
        htmlFor="building-notes"
        error={fieldErrors.notes}

      >
        <Textarea
          id="building-notes"
          rows={shellShortcut || warDamaged ? 3 : 2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder={
            shellShortcut
              ? en
                ? 'e.g. Structure cleared after shelling; plot empty at the time of the visit…'
                : 'مثال: أُزيلت المنشأة بعد القصف؛ العقار خالٍ وقت الزيارة…'
              : warDamaged
                ? en
                  ? 'e.g. Severe structural damage from shelling, uninhabitable, residents displaced; storeys counted from the street…'
                  : 'مثال: أضرار إنشائية بالغة من القصف، غير صالحة للسكن، السكان نازحون؛ عُدّت الطوابق من الخارج…'
                : en
                  ? 'e.g. Side entrance via garden stairs…'
                  : 'مثال: المدخل من الدرج الجانبي عبر الحديقة…'
          }
          className="resize-none"
        />
      </Field>
    </>
  );
}
