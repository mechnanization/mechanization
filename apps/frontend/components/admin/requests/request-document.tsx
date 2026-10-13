'use client';

import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { getLabels, type CitizenRequestView } from '@mechanization/shared-schemas';
import { formatDate, formatDateTime } from '@/lib/dates';
import { Money } from '@/components/ui/money';
import { SummaryList } from '@/components/ui/summary-list';
import {
  DocumentRow,
  LetterheadCrest,
  LetterheadLines,
  SignatureBlock,
  type MunicipalLetterhead,
} from '@/components/admin/finance/official-document';

/**
 * The paper a municipal request is answered with — «إفادة سكن», «براءة ذمة»,
 * … — on an A4 sheet, under the municipality's letterhead (open decisions §20
 * D3): the request number with a QR code holding that number alone (D7), the
 * citizen's name and identity number, the property, the date, and the
 * statement the clerk wrote when they approved it. No validity period is
 * printed unless the clerk wrote one.
 *
 * A براءة ذمة also says what the property owed when it was checked — nothing,
 * or it could not have been approved — and when: «حتى تاريخ …», from the check
 * kept on the request.
 *
 * Never the رقم مرجعي: it is a login credential (docs/security.md). Everything
 * here is the request as the server holds it (STA-6).
 *
 * A document page (PRIM-28): this is the page's one `data-print-root`, black on
 * white whatever the theme. The wording and layout are the municipality's to
 * confirm (docs/municipal-requests-plan.md); nothing here claims a legal form.
 */
export function RequestDocument({
  request,
  letterhead,
  locale,
}: {
  request: CitizenRequestView;
  letterhead: MunicipalLetterhead;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('requests.document');
  const labels = getLabels(locale);
  const { property, clearance, bill } = request;
  const issuedAt = request.readyAt ?? request.createdAt;

  return (
    <article
      data-print-root
      dir={locale === 'en' ? 'ltr' : 'rtl'}
      className="mx-auto w-full max-w-3xl space-y-6 rounded-lg border bg-card p-4 text-sm text-card-foreground shadow-sm sm:p-8"
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-current pb-4">
        <LetterheadLines letterhead={letterhead} />
        <LetterheadCrest crest={letterhead.crest} />
        <div className="flex items-start gap-3">
          <div className="space-y-1 text-end">
            <h2 className="text-lg font-bold">{labels.requestType[request.requestType]}</h2>
            <p className="text-xs">
              {t('number')}{' '}
              {/* A document number is a code: Latin, left to right (BAN-9, RTL-2). */}
              <span dir="ltr" className="font-mono text-sm font-semibold">
                {request.requestNumber}
              </span>
            </p>
            <p className="text-xs">{t('issued', { date: formatDate(issuedAt) })}</p>
          </div>
          {/* The request number and nothing else (D7): a reprint and a check at the counter look it up by it. */}
          <QRCodeSVG
            value={request.requestNumber}
            size={80}
            level="M"
            marginSize={0}
            title={t('qr', { number: request.requestNumber })}
          />
        </div>
      </header>

      <section className="grid gap-x-6 sm:grid-cols-2">
        <SummaryList>
          <DocumentRow label={t('name')}>{request.citizen.name}</DocumentRow>
          <DocumentRow label={t('identity')}>
            {request.citizen.identityDocNumber ? (
              <span dir="ltr" className="font-mono">
                {request.citizen.identityDocNumber}
              </span>
            ) : (
              '—'
            )}
          </DocumentRow>
          <DocumentRow label={t('capacity')}>{labels.applicantCapacity[request.applicantCapacity]}</DocumentRow>
        </SummaryList>
        {property ? (
          <SummaryList>
            <DocumentRow label={t('property')}>
              {labels.propertyType[property.propertyType]}
              {property.propertyNumber ? (
                <>
                  {' '}
                  <span dir="ltr" className="font-mono">
                    {property.propertyNumber}
                  </span>
                </>
              ) : null}
            </DocumentRow>
            {property.neighborhood ? <DocumentRow label={t('neighborhood')}>{property.neighborhood}</DocumentRow> : null}
            {property.buildingName ? <DocumentRow label={t('building')}>{property.buildingName}</DocumentRow> : null}
            {property.unit ? (
              <DocumentRow label={t('unit')}>
                <span dir="ltr" className="font-mono">
                  {property.unit.unitCode ?? '—'}
                </span>
                {property.unit.floor ? ` · ${t('floor', { floor: property.unit.floor })}` : null}
              </DocumentRow>
            ) : null}
          </SummaryList>
        ) : null}
      </section>

      <section className="space-y-3">
        <p className="font-semibold">{t('toWhom')}</p>
        <p className="whitespace-pre-line leading-relaxed">{request.statement ?? '—'}</p>
        {clearance ? (
          <p className="leading-relaxed">
            {t('clearance', {
              property: clearance.propertyNumber,
              date: formatDateTime(clearance.checkedAt),
            })}
          </p>
        ) : null}
        {request.purpose ? <p className="leading-relaxed">{t('purpose', { purpose: request.purpose })}</p> : null}
      </section>

      {bill ? (
        <SummaryList className="rounded-md border px-3">
          <DocumentRow label={t('fee')}>
            <Money amount={bill.amount} currency={bill.currency} locale={locale} exact />
            {bill.invoiceNumber ? (
              <>
                {' · '}
                {t('invoice')}{' '}
                <span dir="ltr" className="font-mono">
                  {bill.invoiceNumber}
                </span>
              </>
            ) : null}
          </DocumentRow>
        </SummaryList>
      ) : request.fee === 0 ? (
        <p className="text-xs text-muted-foreground">{t('free')}</p>
      ) : null}

      <section className="grid gap-8 pt-4 sm:grid-cols-2">
        <SignatureBlock title={t('preparedBy')} note={request.readyByName ?? undefined} />
        <SignatureBlock title={t('head')} />
      </section>
      <p className="border-t pt-2 text-center text-xs text-muted-foreground">{t('stamp')}</p>
    </article>
  );
}
