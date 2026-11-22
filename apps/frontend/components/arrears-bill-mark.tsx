"use client";

import { useLocale, useTranslations } from "next-intl";
import { getLabels, type BillArrearsView } from "@mechanization/shared-schemas";
import { arrearsFeeName, isArrearsPenalty } from "@/lib/arrears-bill";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/**
 * What marks a bill as an old debt wherever a bill is shown (old debts task 10,
 * docs/old-debts-plan.md §7): the «متأخرات سنوات سابقة» chip, a «غرامة» chip on
 * a penalty line, then the year and the fee in the page's language and, for
 * the bill's own number, the «ARR-» number. It renders nothing for a bill with
 * no line, so a list can mount it on every row.
 *
 * Staff pass `showOldReference` and read the old books' reference as well (the
 * API sends it to staff only, and the portal's reads null it); the printed
 * receipt and the portal never pass it. Used by the staff screens and the
 * portal alike, so it reads the locale itself rather than taking a prop.
 */
export function ArrearsBillMark({
  arrears,
  invoiceNumber,
  showOldReference = false,
  className,
}: {
  arrears: BillArrearsView | null | undefined;
  /** The bill's «ARR-…» number, shown as a code beside the year and fee. */
  invoiceNumber?: string | null;
  showOldReference?: boolean;
  className?: string;
}): React.JSX.Element | null {
  const t = useTranslations("arrearsBill");
  const locale = useLocale();
  if (!arrears) return null;

  const labels = getLabels(locale);
  const reference = showOldReference ? arrears.oldReference?.trim() : null;

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <Badge variant="soft-info">{t("tag")}</Badge>
      {isArrearsPenalty(arrears) ? <Badge variant="soft-destructive">{t("penalty")}</Badge> : null}
      <span className="text-xs text-muted-foreground">
        {t("summary", { year: String(arrears.year), fee: arrearsFeeName(arrears, labels) })}
      </span>
      {invoiceNumber ? (
        <bdi dir="ltr" className="font-mono text-xs text-muted-foreground">
          {invoiceNumber}
        </bdi>
      ) : null}
      {reference ? (
        <span className="text-xs text-muted-foreground">
          {t("oldReference", { reference })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * «عقار 1234 · وحدة B1-3»: where an old debt is held, from its line. A staff
 * detail line, beside the bill's own facts.
 */
export function useArrearsPropertyText(): (arrears: BillArrearsView) => string {
  const t = useTranslations("arrearsBill");
  return (arrears) =>
    t("property", {
      propertyNumber: arrears.propertyNumber,
      hasUnit: arrears.unitCode ? "yes" : "no",
      unitCode: arrears.unitCode ?? "",
    });
}
