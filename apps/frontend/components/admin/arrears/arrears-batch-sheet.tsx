"use client";

import { useTranslations } from "next-intl";
import { getLabels, type ArrearsBatchSheet } from "@mechanization/shared-schemas";
import { formatLbp } from "@/lib/currency";
import { formatDate } from "@/lib/dates";
import { Money } from "@/components/ui/money";
import { SummaryList, SummaryRow } from "@/components/ui/summary-list";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  LetterheadCrest,
  LetterheadLines,
  SignatureBlock,
  type MunicipalLetterhead,
} from "@/components/admin/finance/official-document";

/**
 * «ورقة دفعة متأخرات سنوات سابقة» (old debts task 11, docs/old-debts-plan.md §8):
 * the page the head of the municipality signs for an approved batch. Who
 * prepared it, who approved it and when; its totals; what it holds by year and
 * fee; and the lines it dropped, each with its reason.
 *
 * Every figure is the server's. It carries no citizen: a dropped line is named
 * by its رقم العقار, never by a person, so the paper may be filed, photocopied
 * and shown to an auditor as it is.
 */
export function ArrearsBatchSheetDocument({
  sheet,
  letterhead,
  locale,
}: {
  sheet: ArrearsBatchSheet;
  letterhead: MunicipalLetterhead;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations("arrears.sheet");
  const labels = getLabels(locale);
  const { batch, totals } = sheet;

  // One sentence, «12 سطراً · 1,000 ل.ل»: the count and the sum, never joined by hand.
  const figure = (count: number, amount: number) => <bdi>{t("figure", { count, amount: formatLbp(amount, locale) })}</bdi>;

  return (
    <article data-print-root className="space-y-6 rounded-lg border bg-card p-4 text-sm shadow-sm sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <LetterheadLines letterhead={letterhead} />
        <LetterheadCrest crest={letterhead.crest} />
        <div className="space-y-1 text-end">
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="text-xs">
            {t("code")}: <bdi dir="ltr" className="font-mono font-semibold">{sheet.code}</bdi>
          </p>
        </div>
      </header>

      <section aria-label={t("code")}>
        <SummaryList>
          <SummaryRow label={t("preparedBy")}>{batch.preparedBy.name}</SummaryRow>
          <SummaryRow label={t("prepared")}>{formatDate(batch.createdAt)}</SummaryRow>
          {sheet.submittedBy ? <SummaryRow label={t("submittedBy")}>{sheet.submittedBy.name}</SummaryRow> : null}
          {batch.submittedAt ? <SummaryRow label={t("submitted")}>{formatDate(batch.submittedAt)}</SummaryRow> : null}
          {batch.approvedBy ? <SummaryRow label={t("approvedBy")}>{batch.approvedBy.name}</SummaryRow> : null}
          {batch.approvedAt ? <SummaryRow label={t("approved")}>{formatDate(batch.approvedAt)}</SummaryRow> : null}
          {batch.sourceNote ? (
            <SummaryRow label={t("sourceNote")}>
              <span className="whitespace-normal break-words text-end">{batch.sourceNote}</span>
            </SummaryRow>
          ) : null}
        </SummaryList>
      </section>

      <section aria-labelledby="sheet-totals" className="space-y-2">
        <h3 id="sheet-totals" className="text-base font-semibold">
          {t("totalsTitle")}
        </h3>
        <SummaryList>
          <SummaryRow label={t("kept")}>{figure(totals.kept.count, totals.kept.amount)}</SummaryRow>
          <SummaryRow label={t("dropped")}>{figure(totals.dropped.count, totals.dropped.amount)}</SummaryRow>
          <SummaryRow label={t("prescribed")}>{figure(totals.prescribed.count, totals.prescribed.amount)}</SummaryRow>
          <SummaryRow label={t("unmatched")}>{figure(totals.unmatched.count, totals.unmatched.amount)}</SummaryRow>
          <SummaryRow label={t("fileTotal")}>
            <Money amount={totals.fileTotal} currency="LBP" locale={locale} exact />
          </SummaryRow>
          {totals.controlTotal !== null ? (
            <SummaryRow label={t("controlTotal")}>
              <Money amount={totals.controlTotal} currency="LBP" locale={locale} exact />
            </SummaryRow>
          ) : null}
        </SummaryList>
      </section>

      <section aria-labelledby="sheet-by-year" className="space-y-2">
        <h3 id="sheet-by-year" className="text-base font-semibold">
          {t("byYearTitle")}
        </h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colYear")}</TableHead>
              <TableHead>{t("colFee")}</TableHead>
              <TableHead>{t("colComponent")}</TableHead>
              <TableHead className="text-end">{t("colCount")}</TableHead>
              <TableHead className="text-end">{t("colAmount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sheet.byYearAndFee.map((row) => (
              <TableRow key={`${row.year}|${row.feeType}|${row.component}`}>
                <TableCell className="tabular-nums">{row.year}</TableCell>
                <TableCell className="whitespace-normal">{labels.arrearsFeeType[row.feeType] ?? row.feeType}</TableCell>
                <TableCell>{labels.arrearsComponent[row.component]}</TableCell>
                <TableCell className="text-end tabular-nums">{row.count}</TableCell>
                <TableCell className="text-end">
                  <Money amount={row.amount} currency="LBP" locale={locale} exact />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section aria-labelledby="sheet-dropped" className="space-y-2">
        <h3 id="sheet-dropped" className="text-base font-semibold">
          {t("droppedTitle")}
        </h3>
        {sheet.dropped.length === 0 ? (
          <p className="text-muted-foreground">{t("droppedNone")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colYear")}</TableHead>
                <TableHead>{t("colFee")}</TableHead>
                <TableHead>{t("colProperty")}</TableHead>
                <TableHead className="text-end">{t("colAmount")}</TableHead>
                <TableHead>{t("colReason")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sheet.dropped.map((line, index) => (
                <TableRow key={`${line.year}|${line.propertyNumber}|${line.feeType}|${line.component}|${index}`}>
                  <TableCell className="tabular-nums">{line.year}</TableCell>
                  <TableCell className="whitespace-normal">
                    {labels.arrearsFeeType[line.feeType] ?? line.feeType}
                    {line.component === "PENALTY" ? ` · ${labels.arrearsComponent.PENALTY}` : ""}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <bdi dir="ltr">
                      {t("property", {
                        propertyNumber: line.propertyNumber,
                        hasUnit: line.unitCode ? "yes" : "no",
                        unitCode: line.unitCode ?? "",
                      })}
                    </bdi>
                  </TableCell>
                  <TableCell className="text-end">
                    <Money amount={line.amount} currency="LBP" locale={locale} exact />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {line.prescribed ? <span className="font-medium">{t("prescribedTag")} · </span> : null}
                    {line.reason}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="grid gap-8 pt-4 sm:grid-cols-2">
        <SignatureBlock title={t("signatures.preparer")} />
        <SignatureBlock title={t("signatures.mayor")} />
      </section>

      <footer className="border-t pt-3 text-xs text-muted-foreground">{t("footer")}</footer>
    </article>
  );
}
