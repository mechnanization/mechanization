'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/field';
import type { ZoneDetail } from '@/lib/api-client';

/**
 * A fixed palette rather than a free colour picker.
 *
 * Zones are read as a set on one map, so what matters is that any two are
 * told apart at a glance — a choice a native colour input actively works
 * against, since it makes two barely-distinguishable blues as easy to pick as
 * two opposite hues. These eight are spaced around the wheel and hold up
 * against both satellite imagery and the light basemap.
 */
export interface ZoneFormValues {
  name: string;
  code: string;
  color: string;
  description: string;
}

export function ZoneModal({
  open,
  zone,
  parcelCount,
  saving,
  error,
  fieldErrors,
  onSave,
  onOpenChange,
  locale = 'ar',
}: {
  open: boolean;
  /** The sector being edited, or null when creating a new one. */
  zone: ZoneDetail | null;
  /** Parcels currently selected on the map — the membership about to be saved. */
  parcelCount: number;
  saving: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
  onSave: (values: ZoneFormValues) => void;
  onOpenChange: (open: boolean) => void;
  locale?: string;
}) {
  const palette = useMemo(
    () => [
      { hex: '#3B82F6', label: locale === 'en' ? 'Blue' : 'أزرق' },
      { hex: '#10B981', label: locale === 'en' ? 'Green' : 'أخضر' },
      { hex: '#F59E0B', label: locale === 'en' ? 'Orange' : 'برتقالي' },
      { hex: '#EF4444', label: locale === 'en' ? 'Red' : 'أحمر' },
      { hex: '#8B5CF6', label: locale === 'en' ? 'Purple' : 'بنفسجي' },
      { hex: '#EC4899', label: locale === 'en' ? 'Pink' : 'وردي' },
      { hex: '#14B8A6', label: locale === 'en' ? 'Teal' : 'فيروزي' },
      { hex: '#84CC16', label: locale === 'en' ? 'Lime' : 'ليموني' },
    ],
    [locale],
  );

  const [values, setValues] = useState<ZoneFormValues>({
    name: '',
    code: '',
    color: palette[0].hex,
    description: '',
  });

  useEffect(() => {
    if (!open) return;
    setValues({
      name: zone?.name ?? '',
      code: zone?.code ?? '',
      color: zone?.color ?? palette[0].hex,
      description: zone?.description ?? '',
    });
  }, [open, zone, palette]);

  const set = <K extends keyof ZoneFormValues>(key: K, value: ZoneFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={locale === 'en' ? 'Close' : 'إغلاق'} className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {zone
              ? (locale === 'en' ? 'Edit Sector' : 'تعديل القطاع')
              : (locale === 'en' ? 'New Sector' : 'قطاع جديد')}
          </DialogTitle>
          <DialogDescription>
            {parcelCount > 0
              ? (locale === 'en' ? `${parcelCount} parcel(s) selected on map` : `${parcelCount} عقار محدّد على الخريطة`)
              : (locale === 'en' ? 'No parcels selected yet — can be assigned later' : 'لم يتم تحديد أي عقار بعد — يمكن حفظ القطاع وإضافة العقارات لاحقاً')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field
            label={locale === 'en' ? 'Sector Name' : 'اسم القطاع'}
            htmlFor="zone-name"
            required
            error={fieldErrors.name}
          >
            <Input
              id="zone-name"
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={locale === 'en' ? 'East Region - Sector A' : 'المنطقة الشرقية - قطاع أ'}
            />
          </Field>

          <Field
            label={locale === 'en' ? 'Sector Code' : 'رمز القطاع'}
            htmlFor="zone-code"
            required
            error={fieldErrors.code}
          >
            <Input
              id="zone-code"
              value={values.code}
              onChange={(e) => set('code', e.target.value)}
              placeholder="SEC-A1"
              dir="ltr"
              className="text-start"
            />
          </Field>

          <Field
            label={locale === 'en' ? 'Sector Color' : 'لون القطاع'}
            htmlFor="zone-color"
            required
            error={fieldErrors.color}
          >
            <div id="zone-color" className="flex flex-wrap gap-2">
              {palette.map((swatch) => {
                const active = values.color.toUpperCase() === swatch.hex;
                return (
                  <button
                    key={swatch.hex}
                    type="button"
                    onClick={() => set('color', swatch.hex)}
                    aria-label={swatch.label}
                    aria-pressed={active}
                    className={`size-9 rounded-full border-2 transition-transform ${
                      active
                        ? 'scale-110 border-foreground ring-2 ring-ring ring-offset-2 ring-offset-background'
                        : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: swatch.hex }}
                  />
                );
              })}
            </div>
          </Field>

          <Field
            label={locale === 'en' ? 'Notes / Description' : 'ملاحظات'}
            htmlFor="zone-description"
            error={fieldErrors.description}
          >
            <Textarea
              id="zone-description"
              value={values.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
              placeholder={locale === 'en' ? 'Brief description of the sector' : 'وصف مختصر للقطاع'}
            />
          </Field>

          {error ? (
            <Alert tone="error" size="sm">
              {error}
            </Alert>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {locale === 'en' ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            onClick={() => onSave(values)}
            disabled={saving || !values.name.trim() || !values.code.trim()}
          >
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {zone
              ? (locale === 'en' ? 'Save Changes' : 'حفظ التعديلات')
              : (locale === 'en' ? 'Create Sector' : 'إنشاء القطاع')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
