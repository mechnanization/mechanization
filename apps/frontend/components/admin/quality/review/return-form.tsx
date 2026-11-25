import { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { qualityLabels, REVIEW_FIELD, type ReviewField } from '@mechanization/shared-schemas';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/** «إعادة إلى الموظف» — what is wrong, and the sentence they will read. */
export function ReturnForm({
  locale,
  busy,
  onCancel,
  onSubmit,
}: {
  locale: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { reason: string; fields: ReviewField[] }) => void;
}) {
  const en = locale === 'en';
  const quality = qualityLabels(locale);
  const [fields, setFields] = useState<ReviewField[]>([]);
  const [reason, setReason] = useState('');
  const ready = fields.length > 0 && reason.trim().length >= 4;

  return (
    <div className="space-y-3 border-t bg-warning/5 px-4 py-3">
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium">{en ? 'What needs correcting?' : 'ما الذي يحتاج تصحيحاً؟'}</legend>
        <div className="flex flex-wrap gap-1.5">
          {REVIEW_FIELD.map((field) => {
            const on = fields.includes(field);
            return (
              <button
                key={field}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setFields((current) => (on ? current.filter((value) => value !== field) : [...current, field]))
                }
                className={cn(
                  'min-h-8 rounded-md border px-2.5 text-xs transition-colors',
                  on ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                )}
              >
                {quality.reviewField[field]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-1">
        <Label htmlFor="return-reason" className="text-xs">
          {en ? 'What should the officer do?' : 'ماذا على الموظف أن يفعل؟'}
        </Label>
        <Textarea
          id="return-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          className="min-h-[72px] text-sm"
          placeholder={
            en
              ? 'e.g. the phone is the landlord’s — visit and record the occupant’s own number'
              : 'مثال: الرقم المسجَّل هو رقم صاحب الملك — زُر الوحدة وسجِّل رقم الشاغل'
          }
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {en ? 'Cancel' : 'إلغاء'}
        </Button>
        <Button size="sm" className="gap-1.5" disabled={!ready || busy} onClick={() => onSubmit({ reason: reason.trim(), fields })}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}
          {en ? 'Send back' : 'إعادة السجل'}
        </Button>
      </div>
    </div>
  );
}
