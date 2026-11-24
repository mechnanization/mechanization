'use client';

import type { ReactNode } from 'react';
import { Building2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormSection } from './form-section';

/*
  Page 3 of the citizen form, «العقارات» (GOD-22, phase 2b): the heading with its
  count, the line for a file with no property, the cards (`children`, which the
  form draws because they depend on its state) and «إضافة عقار». Moved out of
  `citizen-form.tsx` as it was.
*/
export function PropertiesSection({
  count,
  invalid,
  locale,
  onAdd,
  children,
}: {
  /** How many cards the file holds. */
  count: number;
  invalid: boolean;
  locale: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <FormSection
      id="properties"
      step="3"
      icon={Building2}
      title={
        locale === 'en'
          ? `Properties (${count})`
          : `العقارات (${count})`
      }

      invalid={invalid}
    >
      <div className="review-body space-y-4">
        {count === 0 ? (
          <p className="text-sm text-muted-foreground">
            {locale === 'en'
              ? 'No property to add? Leave this empty for a citizen who owns nothing and only rents.'
              : 'لا يملك المواطن أي عقار؟ يمكن ترك هذا القسم فارغاً إذا كان يستأجر فقط.'}
          </p>
        ) : null}

        {children}



        <Button
          variant="outline"
          size="sm"
          onClick={onAdd}
          className="w-full border-dashed border-primary/60 text-primary hover:bg-primary/5 h-9 text-xs sm:text-sm font-medium"
        >
          <Plus className="size-4" aria-hidden />
          {locale === 'en'
            ? count === 0
              ? 'Add Property'
              : 'Add Another Property'
            : count === 0
              ? 'إضافة عقار'
              : 'إضافة عقار آخر'}
        </Button>
      </div>
    </FormSection>
  );
}
