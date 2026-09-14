'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  FileQuestion,
  Search,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { getLabels, isFlaggablePath } from '@mechanization/shared-schemas';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { cn } from '@/lib/utils';
import { askableFields, type AskableField, type CitizenFormValues } from './citizen-form';

interface FlaggableFieldItem {
  path: string;
  label: string;
  sectionId: 'personal' | 'contact' | 'properties';
  sectionTitle: string;
  propertyIndex?: number;
}

/**
 * The fields this dialog may offer, in the order the form asks them.
 *
 * Read straight off `askableFields` — the form's own list — rather than
 * rebuilt here. The two used to be separate copies of the same branch rules,
 * and a dialog that offered a field the form no longer asked about produced
 * the worst kind of bug: the officer ticked it, confirmed, and the form's
 * prune quietly dropped it, so the count they had just set was not the count
 * they got back. Whatever the form is asking is exactly what can be flagged.
 *
 * `isFlaggablePath` still filters, because the form asks about the name and
 * the schema will never accept a flag on it.
 */
function getFlaggableFields(values: CitizenFormValues, locale: string): FlaggableFieldItem[] {
  const labels = getLabels(locale);

  const sectionTitle = (entry: AskableField): string => {
    if (entry.section === 'personal') {
      return locale === 'en' ? 'Personal Information' : 'البيانات الشخصية';
    }
    if (entry.section === 'contact') {
      return locale === 'en' ? 'Contact & Household' : 'التواصل والأسرة';
    }
    const card = (entry.propertyIndex ?? 0) + 1;
    return locale === 'en' ? `Property ${card}` : `العقار ${card}`;
  };

  return askableFields(values)
    .filter((entry) => isFlaggablePath(entry.path))
    .map((entry) => ({
      path: entry.path,
      label: labels.citizenField[entry.field] ?? entry.field,
      sectionId: entry.section,
      sectionTitle: sectionTitle(entry),
      propertyIndex: entry.propertyIndex,
    }));
}

export function UnverifiedFieldsDialog({
  open,
  onOpenChange,
  values,
  onSaveFlags,
  locale = 'ar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  values: CitizenFormValues;
  onSaveFlags: (newFlags: Map<string, string>) => void;
  locale?: string;
}) {
  const [draftFlags, setDraftFlags] = useState<Map<string, string>>(new Map());
  const [searchTerm, setSearchTerm] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // Sync draft flags from parent values when dialog opens
  useEffect(() => {
    if (open) {
      setDraftFlags(new Map(values.flags));
      setSearchTerm('');
      setValidationError(null);
    }
  }, [open, values.flags]);

  const allFlaggableFields = useMemo(
    () => getFlaggableFields(values, locale),
    [values, locale],
  );

  const filteredFields = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return allFlaggableFields;
    return allFlaggableFields.filter(
      (f) =>
        f.label.toLowerCase().includes(term) ||
        f.sectionTitle.toLowerCase().includes(term),
    );
  }, [allFlaggableFields, searchTerm]);

  // Group by section title
  const groupedFields = useMemo(() => {
    const groups: { title: string; items: FlaggableFieldItem[] }[] = [];
    const map = new Map<string, FlaggableFieldItem[]>();

    filteredFields.forEach((field) => {
      const list = map.get(field.sectionTitle) ?? [];
      list.push(field);
      map.set(field.sectionTitle, list);
    });

    map.forEach((items, title) => {
      groups.push({ title, items });
    });

    return groups;
  }, [filteredFields]);

  const toggleField = (path: string) => {
    setDraftFlags((prev) => {
      const next = new Map(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.set(path, '');
      }
      return next;
    });
    setValidationError(null);
  };

  const setReason = (path: string, reason: string) => {
    setDraftFlags((prev) => {
      const next = new Map(prev);
      next.set(path, reason);
      return next;
    });
    setValidationError(null);
  };

  const applyAbsentParentsPreset = () => {
    const askablePathSet = new Set(allFlaggableFields.map((f) => f.path));
    const next = new Map(draftFlags);

    // Specific, contextual reasons per field — NEVER flag identityDocNumber, civilRecordNumber, or gender!
    const candidateFields: Array<{ path: string; empty: boolean; reason: string }> = [
      /*
        اسم الأم is exactly the fact children in the house may not be able to
        give, which is why the preset covers it: the alternative to a flag here
        is a clerk writing down a guess at the one field that exists to tell two
        namesakes apart.
      */
      {
        path: 'personal.motherName',
        empty: !values.personal.motherName,
        reason:
          locale === 'en'
            ? "Mother's name unconfirmed — parents absent during field survey"
            : 'اسم الأم غير مؤكد — الأهل غير متواجدين أثناء المسح',
      },
      {
        path: 'personal.residentStatus',
        empty: !values.personal.residentStatus,
        reason:
          locale === 'en'
            ? 'Residency status unconfirmed — parents absent'
            : 'صفة الإقامة غير مؤكدة — الأهل غير متواجدين',
      },
      {
        path: 'contact.maritalStatus',
        empty: !values.contact.maritalStatus,
        reason:
          locale === 'en'
            ? 'Marital status unconfirmed — parents absent'
            : 'الحالة الاجتماعية غير مؤكدة — الأهل غير متواجدين',
      },
    ];

    values.properties.forEach((prop, idx) => {
      candidateFields.push({
        path: `properties.${idx}.propertyNumber`,
        empty: !prop.propertyNumber,
        reason:
          locale === 'en'
            ? 'Deed/parcel number unavailable with children — parents absent'
            : 'سند الملكية أو رقم العقار غير متوفر لدى الأبناء — الأهل غير متواجدين',
      });

      if (prop.occupancyType === 'TENANT') {
        candidateFields.push(
          {
            path: `properties.${idx}.landlordName`,
            empty: !prop.landlordName,
            reason:
              locale === 'en'
                ? 'Landlord name unconfirmed by children'
                : 'اسم المالك غير مؤكد لدى الأبناء',
          },
          {
            path: `properties.${idx}.landlordPhone`,
            empty: !prop.landlordPhone,
            reason:
              locale === 'en'
                ? 'Landlord contact info held by absent parents'
                : 'رقم هاتف المالك مع الأهل الغائبين',
          },
        );
      }
    });

    for (const item of candidateFields) {
      // Must be currently askable in this form's branch and currently empty
      if (askablePathSet.has(item.path) && item.empty) {
        if (!next.has(item.path)) {
          next.set(item.path, item.reason);
        }
      }
    }

    setDraftFlags(next);
    setValidationError(null);
  };

  const handleConfirm = () => {
    // Validate that every checked field has a non-empty reason (at least 4 chars)
    for (const [path, reason] of draftFlags) {
      if (!reason || reason.trim().length < 4) {
        const field = allFlaggableFields.find((f) => f.path === path);
        setValidationError(
          locale === 'en'
            ? `Please provide a valid reason (min 4 characters) for: ${field?.label ?? path}`
            : `يرجى كتابة سبب صحيح (٤ أحرف على الأقل) للحقل: ${field?.label ?? path}`,
        );
        return;
      }
    }

    onSaveFlags(draftFlags);
    onOpenChange(false);
  };

  const activeCount = draftFlags.size;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-5 border-b border-border/80">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-lg bg-warning/15 text-warning ring-1 ring-warning/30">
                <FileQuestion className="size-5" />
              </div>
              <div>
                <DialogTitle className="text-base sm:text-lg font-bold">
                  {locale === 'en' ? 'Unverified Fields Manager' : 'خانات غير مؤكَّدة'}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  {locale === 'en'
                    ? 'Select fields that could not be verified and enter the reason for each.'
                    : 'حدّد الخانات التي يتعذّر استكمال بياناتها مع ذكر سبب عدم التوفّر لكل خانة.'}
                </DialogDescription>
              </div>
            </div>

            {activeCount > 0 ? (
              <span className="shrink-0 rounded-md bg-warning/15 px-2.5 py-1 text-xs font-semibold text-warning ring-1 ring-warning/30">
                {locale === 'en' ? `${activeCount} unverified` : `${activeCount} خانة غير مؤكَّدة`}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={locale === 'en' ? 'Search fields…' : 'ابحث في الحقول…'}
                className="ps-9 h-9 text-xs"
              />
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={applyAbsentParentsPreset}
              className="h-9 gap-1.5 text-xs font-medium border-warning/40 bg-warning/10 text-warning hover:bg-warning/20 hover:text-warning shrink-0"
              title={
                locale === 'en'
                  ? 'Auto-flag all empty fields with "Parents absent / kids interview" reason'
                  : 'تحديد جميع الخانات الفارغة تلقائياً بسبب غياب الأهل'
              }
            >
              <Sparkles className="size-3.5" />
              <span>{locale === 'en' ? 'Absent Parents Preset' : 'نموذج غياب الأهل'}</span>
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {validationError ? (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs font-medium text-destructive">
              <TriangleAlert className="size-4 shrink-0" />
              <span>{validationError}</span>
            </div>
          ) : null}

          {groupedFields.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              {locale === 'en' ? 'No fields match your search.' : 'لا توجد حقول مطابقة للبحث.'}
            </p>
          ) : (
            groupedFields.map((group) => (
              <div key={group.title} className="space-y-2.5">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {group.title}
                </h4>

                <div className="space-y-2 rounded-lg border border-border/80 bg-card p-3">
                  {group.items.map((field) => {
                    const isChecked = draftFlags.has(field.path);
                    const reasonValue = draftFlags.get(field.path) ?? '';

                    return (
                      <div
                        key={field.path}
                        className={cn(
                          'rounded-md border p-3 transition-colors',
                          isChecked
                            ? 'border-warning/50 bg-warning/5'
                            : 'border-transparent hover:bg-muted/40',
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <label
                            htmlFor={`chk-${field.path}`}
                            className="flex cursor-pointer items-center gap-2.5 text-xs font-medium text-foreground select-none"
                          >
                            <Checkbox
                              id={`chk-${field.path}`}
                              checked={isChecked}
                              onCheckedChange={() => toggleField(field.path)}
                            />
                            <span>{field.label}</span>
                          </label>

                          {isChecked ? (
                            <span className="text-[11px] font-semibold text-warning">
                              {locale === 'en' ? 'Unverified' : 'غير مؤكَّد'}
                            </span>
                          ) : null}
                        </div>

                        {isChecked ? (
                          <div className="mt-2.5 ps-6 space-y-1">
                            <Label
                              htmlFor={`reason-${field.path}`}
                              className="text-[11px] font-medium text-warning"
                            >
                              {locale === 'en'
                                ? 'Why is this information unavailable? (required)'
                                : 'سبب عدم توفّر هذه المعلومة (إلزامي)'}
                            </Label>
                            <Input
                              id={`reason-${field.path}`}
                              value={reasonValue}
                              onChange={(e) => setReason(field.path, e.target.value)}
                              placeholder={
                                locale === 'en'
                                  ? 'e.g. Title deed with relative in another town'
                                  : 'مثال: سند الملكية غير متوفر حالياً'
                              }
                              className="h-8 text-xs border-warning/40 focus-visible:ring-warning/40 bg-background"
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <DialogFooter className="p-4 border-t border-border/80 bg-muted/20 flex flex-row items-center justify-between sm:justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="text-xs"
          >
            {locale === 'en' ? 'Cancel' : 'إلغاء'}
          </Button>

          <div className="flex items-center gap-2">
            {activeCount > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraftFlags(new Map())}
                className="text-xs text-muted-foreground"
              >
                {locale === 'en' ? 'Clear All' : 'إلغاء تحديد الكل'}
              </Button>
            ) : null}

            <Button type="button" size="sm" onClick={handleConfirm} className="gap-1.5 text-xs">
              <Check className="size-3.5" />
              {locale === 'en' ? 'Confirm & Apply' : 'تأكيد وتطبيق'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}