'use client';

import * as React from 'react';
import { Download, Loader2, MessageCircle, Printer, X } from 'lucide-react';
import { ar } from '@mechanization/shared-schemas';
import type { CitizenProfile, CitizenProfilePayment, CitizenProfileProperty } from '@/lib/api-client';
import { formatLbp } from '@/lib/currency';
import { formatDate } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { downloadFile, renderReceiptPdf, shareFile } from '@/lib/receipt-pdf';

/**
 * Al-Bazourieh's own scanned receipt booklet — the one municipality that
 * asked for a facsimile of their actual paper, rather than the drawn
 * approximation every other tenant gets. Gated by slug rather than offered
 * to everyone: the image has "بلدية البازورية" and "قائمقامية صور" baked into
 * its pixels, which would be wrong printed for any other municipality.
 */
const IMAGE_TEMPLATE_TENANT = 'albazourieh';

/**
 * A receipt number that is stable for a given payment.
 */
function receiptNumber(payment: CitizenProfilePayment): string {
  return payment.id.replace(/-/g, '').slice(0, 10).toUpperCase();
}

/** `+9617xxxxxxx` / `03 123456` → the digits wa.me expects, Lebanon-defaulted. */
function whatsappNumber(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('961')) return digits;
  if (digits.startsWith('0')) return `961${digits.slice(1)}`;
  return digits.length <= 8 ? `961${digits}` : digits;
}

/**
 * Official Republic of Lebanon Calligraphy SVG Vector Emblem.
 */
function LebaneseRepublicCalligraphy({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 60"
      fill="currentColor"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="الجمهورية اللبنانية"
    >
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        style={{
          fontFamily: "'Amiri', 'Traditional Arabic', 'Scheherazade New', 'Noto Naskh Arabic', serif",
          fontSize: '32px',
          fontWeight: 'bold',
          letterSpacing: '0.02em',
        }}
      >
        الجمهورية اللبنانية
      </text>
    </svg>
  );
}

/**
 * وصل قبض / ايصال جباية — Official municipal collection receipt matching the official physical printed book.
 */
export function PaymentReceipt({
  open,
  onOpenChange,
  tenant,
  citizen,
  payment,
  municipalityName,
  governorate,
  district,
  contactPhone,
  officeWhatsapp,
  receivedAmount,
  councilDecisionRef,
  locale = 'ar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tenant slug — decides which facsimile renders. See `IMAGE_TEMPLATE_TENANT`. */
  tenant?: string;
  citizen: CitizenProfile;
  payment: CitizenProfilePayment | null;
  municipalityName: string;
  /** المحافظة — from settings, not hardcoded: every municipality sits under a different one. */
  governorate?: string | null;
  /** القضاء / قائمقامية — same reasoning as `governorate`. */
  district?: string | null;
  contactPhone?: string | null;
  officeWhatsapp?: string | null;
  receivedAmount?: number;
  /**
   * تاريخ ورقم قرار المجلس البلدي, if the council has issued one (§7 Q1).
   *
   * Optional, and the footer says something either way: with a decision it
   * cites the decision, without one it cites the municipal survey and valuation
   * authority — which is the power the numbering actually rests on. What it
   * never does is print a building code with nothing behind it.
   */
  councilDecisionRef?: string | null;
  locale?: string;
}) {
  const printRef = React.useRef<HTMLDivElement>(null);
  const [busy, setBusy] = React.useState<null | 'share' | 'download'>(null);
  const [shareNote, setShareNote] = React.useState<string | null>(null);

  if (!payment) return null;

  const amount = receivedAmount ?? payment.amount;
  const properties = citizen.registrations.flatMap((r) => r.properties);
  const property = properties[0] ?? null;

  // The template's tick boxes, resolved from register
  const isCommercial = properties.some(
    (p) => p.unitType === 'SHOP' || p.units?.some((u) => u.unitType === 'SHOP'),
  );
  const isOwner = property?.occupancyType === 'OWNER';
  const isDisplaced = citizen.residentStatus === 'DISPLACED';

  const residentialUnits = properties.reduce(
    (total, p) =>
      total +
      (p.units?.filter((u) => u.unitType === 'APARTMENT').length ||
        (p.unitType === 'APARTMENT' ? 1 : 0)),
    0,
  );
  const shopUnits = properties.reduce(
    (total, p) =>
      total +
      (p.units?.filter((u) => u.unitType === 'SHOP').length || (p.unitType === 'SHOP' ? 1 : 0)),
    0,
  );

  const wa = whatsappNumber(citizen.whatsapp ?? citizen.phone);

  const message = [
    `بلدية ${municipalityName}`,
    `وصل قبض رقم ${receiptNumber(payment)}`,
    '',
    `المكلّف: ${citizen.fullName}`,
    citizen.referenceNumber ? `الرقم المرجعي: ${citizen.referenceNumber}` : null,
    `البند: ${payment.title}`,
    `المبلغ المقبوض: ${formatLbp(amount)}`,
    payment.remaining > 0
      ? `الرصيد المتبقي: ${formatLbp(payment.remaining)}`
      : 'تم تسديد كامل المبلغ. شكراً لكم.',
    '',
    `التاريخ: ${formatDate(new Date())}`,
    contactPhone ? `للاستفسار: ${contactPhone}` : null,
    officeWhatsapp ? `واتساب البلدية: ${officeWhatsapp}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const waHref = wa ? `https://wa.me/${wa}?text=${encodeURIComponent(message)}` : null;
  const useImageTemplate = tenant === IMAGE_TEMPLATE_TENANT;

  const handlePdf = async (mode: 'share' | 'download') => {
    const node = printRef.current;
    if (!node) return;

    setBusy(mode);
    setShareNote(null);
    try {
      const file = await renderReceiptPdf(node, `وصل-${receiptNumber(payment)}.pdf`);

      if (mode === 'download') {
        downloadFile(file);
        return;
      }

      if (await shareFile(file, message)) return;

      downloadFile(file);
      setShareNote(
        'متصفحك لا يدعم إرسال الملفات مباشرة. تم تنزيل الوصل — افتح واتساب وأرفقه بالرسالة.',
      );
      if (waHref) window.open(waHref, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error(error);
      setShareNote('تعذّر إنشاء ملف PDF. جرّب «طباعة» بدلاً من ذلك.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={locale === 'en' ? 'Close' : 'إغلاق'}
        className="flex max-h-[94dvh] flex-col gap-0 p-0 sm:max-w-4xl"
      >
        <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-6 bg-muted/20">
          {/* Printable Receipt Facsimile */}
          <div
            id="receipt-print-area"
            ref={printRef}
            dir="rtl"
            className={
              useImageTemplate
                ? 'relative mx-auto max-w-[900px] bg-white text-black shadow-md select-none'
                : 'relative mx-auto min-w-[620px] max-w-[760px] bg-white p-4 text-black shadow-md select-none font-sans'
            }
            style={{
              boxShadow: '0 0 0 1px rgba(0,0,0,0.15), 0 4px 12px rgba(0,0,0,0.08)',
            }}
          >
            {useImageTemplate ? (
              <ImageFacsimile
                citizen={citizen}
                payment={payment}
                amount={amount}
                property={property}
                isCommercial={isCommercial}
                isOwner={isOwner}
                residentialUnits={residentialUnits}
                shopUnits={shopUnits}
              />
            ) : (
              <DrawnFacsimile
                citizen={citizen}
                payment={payment}
                amount={amount}
                property={property}
                isCommercial={isCommercial}
                isOwner={isOwner}
                isDisplaced={isDisplaced}
                residentialUnits={residentialUnits}
                shopUnits={shopUnits}
                municipalityName={municipalityName}
                governorate={governorate}
                district={district}
                councilDecisionRef={councilDecisionRef}
              />
            )}
          </div>
        </div>

        {/* Modal Action Buttons Footer */}
        <footer className="shrink-0 space-y-2 border-t p-4 bg-card">
          {shareNote ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              {shareNote}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground font-mono">
              {locale === 'en'
                ? `Receipt #${receiptNumber(payment)} • Date: ${formatDate(new Date())}`
                : `رقم الوصل: ${receiptNumber(payment)} • التاريخ: ${formatDate(new Date())}`}
            </span>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                <X className="size-4 rtl:ml-1.5 ltr:mr-1.5" />
                {locale === 'en' ? 'Close' : 'إغلاق'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                <Printer className="size-4 rtl:ml-1.5 ltr:mr-1.5" />
                {locale === 'en' ? 'Print Receipt' : 'طباعة الوصل'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handlePdf('download')}
                disabled={busy !== null}
              >
                {busy === 'download' ? (
                  <Loader2 className="size-4 animate-spin rtl:ml-1.5 ltr:mr-1.5" />
                ) : (
                  <Download className="size-4 rtl:ml-1.5 ltr:mr-1.5" />
                )}
                {locale === 'en' ? 'Download PDF' : 'تنزيل PDF'}
              </Button>
              <Button
                size="sm"
                onClick={() => void handlePdf('share')}
                disabled={busy !== null || !wa}
              >
                {busy === 'share' ? (
                  <Loader2 className="size-4 animate-spin rtl:ml-1.5 ltr:mr-1.5" />
                ) : (
                  <MessageCircle className="size-4 rtl:ml-1.5 ltr:mr-1.5" />
                )}
                {locale === 'en' ? 'Send via WhatsApp' : 'إرسال عبر واتساب'}
              </Button>
            </div>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** What both facsimiles need from the payment beyond the raw record. */
interface FacsimileProps {
  citizen: CitizenProfile;
  payment: CitizenProfilePayment;
  amount: number;
  property: CitizenProfileProperty | null;
  isCommercial: boolean;
  isOwner: boolean;
  residentialUnits: number;
  shopUnits: number;
}

/** The hand-drawn CSS approximation every tenant but Al-Bazourieh gets. */
function DrawnFacsimile({
  citizen,
  payment,
  amount,
  property,
  isCommercial,
  isOwner,
  isDisplaced,
  residentialUnits,
  shopUnits,
  municipalityName,
  governorate,
  district,
  councilDecisionRef,
}: FacsimileProps & {
  isDisplaced: boolean;
  municipalityName: string;
  governorate?: string | null;
  district?: string | null;
  /** §7 Q1 — see the note on the prop of the same name above. */
  councilDecisionRef?: string | null;
}) {
  return (
    <div className="p-4">
      {/* Outer Frame with Corner Ticks — a thin outer rule and a bold inner
          one, rather than two equally heavy borders stacked, is what
          reads as typeset rather than drawn in a form builder. */}
      <div className="relative border border-black/70 p-2.5 bg-white">
        {/* Corner tick marks (Printing / Boundary Marks) */}
        <div className="pointer-events-none absolute -top-2.5 -start-2.5 size-5 border-e-2 border-b-2 border-black" />
        <div className="pointer-events-none absolute -top-2.5 -end-2.5 size-5 border-s-2 border-b-2 border-black" />
        <div className="pointer-events-none absolute -bottom-2.5 -start-2.5 size-5 border-e-2 border-t-2 border-black" />
        <div className="pointer-events-none absolute -bottom-2.5 -end-2.5 size-5 border-s-2 border-t-2 border-black" />

        {/* Inner Solid Border */}
        <div className="border-2 border-black p-5 sm:p-6 bg-white space-y-4">
          {/* 1. Top Header */}
          <header className="flex items-start justify-between gap-4 border-b-2 border-black pb-3">
            {/* Right (first, in RTL): receipt number stamp, bill title, and rule */}
            <div className="text-center pt-1 space-y-1.5">
              <div className="mx-auto inline-flex items-center gap-1.5 rounded-sm border border-black/60 px-2 py-0.5 text-xs font-bold tracking-wide text-black">
                <span>رقم الوصل</span>
                <span className="font-mono">{receiptNumber(payment)}</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black tracking-tight font-sans">
                وصل بدل {payment.title || 'رسوم بلدية'}
              </h2>
              <div className="w-16 h-[2px] bg-black mx-auto mt-1" />
            </div>

            {/* Left (second, in RTL): Republic of Lebanon Emblem & Municipality Details,
                drawn from settings — governorate/district differ per municipality. */}
            <div className="text-center space-y-0.5 leading-tight">
              <div className="flex justify-center -mb-1">
                <LebaneseRepublicCalligraphy className="h-9 w-44 text-black" />
              </div>
              <p className="text-xs font-bold text-black">
                وزارة الداخلية والبلديات{governorate ? ` ـ محافظة ${governorate}` : ''}
              </p>
              {district ? (
                <p className="text-xs font-bold text-black">قائمقامية {district}</p>
              ) : null}
              <div className="pt-0.5">
                <span className="inline-block border-b-2 border-black pb-0.5 text-base sm:text-lg font-black text-black">
                  بلدية {municipalityName || '—'}
                </span>
              </div>
            </div>
          </header>

          {/* 2. Payer Section (إستلمنا من السيد/ السيدة) */}
          <section className="space-y-2 text-black">
            <div className="flex flex-wrap items-center gap-3">
              <DottedField
                label="إستلمنا من السيد / السيدة"
                value={citizen.fullName}
                flex="flex-[3]"
              />
              <DottedField
                label="رقم الهاتف"
                value={citizen.phone || citizen.whatsapp || '—'}
                flex="flex-[2]"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <DottedField
                label="المحلّة / الحي"
                value={property?.neighborhood || '—'}
                flex="flex-[2]"
              />
              <DottedField
                label="رقم العقار"
                value={property?.propertyNumber || '—'}
                flex="flex-[1]"
              />
              <DottedField
                label="اسم المبنى"
                value={property?.buildingName || '—'}
                flex="flex-[2]"
              />
            </div>

            {/*
              The building's code and the number painted on it, side by side —
              and both, never one (D14).

              Where the register says `A-1042-B` and the door says `12`, the
              collector standing in the street trusts the door. A notice that
              printed only our code would send them looking for a building
              nobody in the neighbourhood calls by that name; one that printed
              only the painted number could not be looked up in the register.
              The row is omitted entirely when the card was never linked to a
              censused structure, which is most cards until a parcel is
              surveyed.
            */}
            {property?.buildingCode ? (
              <div className="flex flex-wrap items-center gap-3">
                <DottedField
                  label="رمز المبنى (مسح البلدية)"
                  value={property.buildingCode}
                  flex="flex-[2]"
                />
                <DottedField
                  label="الرقم المكتوب على المبنى"
                  value={property.buildingPostedNumber || '—'}
                  flex="flex-[1]"
                />
                <DottedField
                  label="رقم الوحدة"
                  value={property.units?.find((unit) => unit.unitCode)?.unitCode || '—'}
                  flex="flex-[1]"
                />
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <DottedField
                label="رقم السجل"
                value={citizen.civilRecordNumber || '—'}
                flex="flex-[1]"
              />
              <DottedField
                label="رقم الملف / المرجع"
                value={citizen.referenceNumber || '—'}
                flex="flex-[2]"
              />
            </div>
          </section>

          {/* 3. Checkboxes Row (طبيعة الإشغال والصفة) */}
          <section className="border-y border-black/70 py-2.5 my-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <CheckboxItem label="سكني" checked={!isCommercial} />
              <CheckboxItem label="تجاري / مهني" checked={isCommercial} />
              <CheckboxItem label="مالك" checked={isOwner} />
              <CheckboxItem label="مستأجر" checked={!isOwner} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2 pt-2 border-t border-black/30 text-xs">
              <CheckboxItem label="مقيم دائم" checked={!isDisplaced} />
              <CheckboxItem label="وافد / نازح" checked={isDisplaced} />
              <div className="text-start font-bold">
                عدد الوحدات: {residentialUnits} سكني {shopUnits > 0 ? `• ${shopUnits} تجاري` : ''}
              </div>
            </div>
          </section>

          {/* 4. Financial Details Section */}
          <section className="space-y-2 text-black">
            <div className="flex flex-wrap items-center gap-3">
              <DottedField
                label="المبلغ رقماً"
                value={<span className="font-mono text-base font-black">{formatLbp(amount)}</span>}
                flex="flex-[2]"
              />
              <DottedField
                label="تاريخ القبض"
                value={formatDate(payment.paidAt || new Date())}
                flex="flex-[1]"
              />
            </div>

            <DottedField
              label="المبلغ كتابةً"
              value={payment.title ? `عن: ${payment.title}` : 'بدل رسوم خدمات بلدية'}
              flex="w-full"
            />
            <DottedField
              label="ملاحظات / طريقة الدفع"
              value={`طريقة الدفع: ${(ar.paymentMethod as Record<string, string>)[payment.paymentMethod || 'CASH'] || payment.paymentMethod || 'نقداً'} ${payment.reviewNote ? `• ${payment.reviewNote}` : ''}`}
              flex="w-full"
            />
          </section>

          {/* 5. Signatures Footer, with a seal placeholder between the two — the
              third mark a physical municipal receipt carries alongside them. */}
          <div className="pt-4 border-t-2 border-black flex items-center justify-around text-center text-xs sm:text-sm text-black">
            <div>
              <p className="font-bold">توقيع أمين الصندوق</p>
              <div className="w-24 sm:w-32 border-b-2 border-black mt-6 mx-auto" />
            </div>
            <div
              aria-hidden
              className="flex size-16 shrink-0 items-center justify-center rounded-full border border-dashed border-black/40 text-xs font-bold text-black/40"
            >
              الختم
            </div>
            <div>
              <p className="font-bold">توقيع المكلف</p>
              <div className="w-24 sm:w-32 border-b-2 border-black mt-6 mx-auto" />
            </div>
          </div>

          {/*
            Where the building code on this notice comes from (§7 Q1).

            Printed only when the notice actually carries a code, because
            otherwise it cites an authority for nothing. With a council decision
            on file it names the decision; without one it names the power the
            numbering already rests on — internal cadastral indexing and
            parcel-linked building numbering are an administrative and fiscal
            survey competence, which is precisely why Q1 concluded that no
            decree is needed for the codes to be valid.
          */}
          {property?.buildingCode ? (
            <p className="mt-3 border-t border-black/30 pt-2 text-center text-xs leading-relaxed text-black/70">
              {councilDecisionRef
                ? `رمز المبنى معتمد بموجب ${councilDecisionRef}.`
                : 'رمز المبنى صادر ضمن أعمال المسح والتخمين البلدي، وهو رمز مسحي داخلي لا يحل محل رقم العقار في السجل العقاري.'}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * One field positioned over the scanned image, as a percentage of its
 * 1280×720 pixels — so it tracks the image regardless of how large the
 * dialog renders it. `right`/`width` rather than `left`: every field on this
 * form is a label followed by blank space *to its left*, so anchoring the
 * text box to the right edge (where the label ends) and letting it grow
 * left is what keeps a short value hugging the label instead of floating
 * in the middle of the blank space.
 */
interface ImageField {
  top: number;
  right: number;
  width: number;
  height: number;
}

const IMAGE_FIELDS = {
  payerName: { top: 30.0, right: 100 - 60.7, width: 39.14, height: 7.64 },
  amountUsd: { top: 37.5, right: 100 - 46.1, width: 19.22, height: 8.75 },
  amountLbp: { top: 37.5, right: 100 - 70.5, width: 19.22, height: 8.75 },
  propertyNumber: { top: 53.75, right: 100 - 76.09, width: 12.5, height: 5 },
  buildingName: { top: 53.75, right: 100 - 61.02, width: 13.05, height: 5 },
  neighborhood: { top: 53.75, right: 100 - 46.88, width: 12.89, height: 5 },
  units: { top: 59.03, right: 100 - 69.61, width: 12.97, height: 5 },
  shops: { top: 59.03, right: 100 - 51.95, width: 8.13, height: 5 },
  phone: { top: 69.44, right: 100 - 43.28, width: 12.03, height: 5 },
  whatsapp: { top: 69.44, right: 100 - 26.48, width: 6.09, height: 5 },
  landlord: { top: 69.44, right: 100 - 70.86, width: 10.31, height: 5 },
} as const satisfies Record<string, ImageField>;

const IMAGE_CHECKBOXES = {
  residential: { top: 48.89, right: 100 - 67.19, width: 3.36, height: 3.89 },
  commercial: { top: 48.89, right: 100 - 58.05, width: 3.44, height: 3.89 },
  owner: { top: 48.89, right: 100 - 50.08, width: 3.36, height: 3.89 },
  displaced: { top: 48.89, right: 100 - 42.73, width: 3.44, height: 3.89 },
  bloodType: { top: 48.89, right: 100 - 32.73, width: 3.44, height: 3.89 },
} as const satisfies Record<string, ImageField>;

/** Text sized and positioned to sit in one blank field of the scanned form. */
function ImageOverlay({ field, children }: { field: ImageField; children: React.ReactNode }) {
  return (
    <div
      className="absolute flex items-center justify-end overflow-hidden whitespace-nowrap text-[1.15cqw] font-bold text-black"
      style={{
        top: `${field.top}%`,
        right: `${field.right}%`,
        width: `${field.width}%`,
        height: `${field.height}%`,
      }}
    >
      {children}
    </div>
  );
}

/** A checkmark drawn inside one of the form's printed checkbox squares. */
function ImageCheckbox({ field, checked }: { field: ImageField; checked: boolean }) {
  if (!checked) return null;
  return (
    <div
      aria-hidden
      className="absolute flex items-center justify-center text-[1.6cqw] font-black leading-none text-black"
      style={{
        top: `${field.top}%`,
        right: `${field.right}%`,
        width: `${field.width}%`,
        height: `${field.height}%`,
      }}
    >
      ✓
    </div>
  );
}

/**
 * Al-Bazourieh's actual paper booklet, scanned, with every blank field typed
 * over it. Positions in `IMAGE_FIELDS`/`IMAGE_CHECKBOXES` were measured
 * directly off the image's pixels (connected-component and edge detection on
 * the gray name box, the amount pills, the checkbox borders, and a row-wise
 * ink-density profile for the dotted lines) — not eyeballed, but still a
 * first pass: nudge the percentages there if a value drifts off its line.
 *
 * `container-type: inline-size` + `cqw` units size the overlay text off the
 * *rendered* width of this element rather than the viewport, so the same
 * numbers hold whether this is the ~700px dialog preview or the full-width
 * capture `html2canvas` rasterises for the PDF.
 */
function ImageFacsimile({
  citizen,
  payment,
  amount,
  property,
  isCommercial,
  isOwner,
  residentialUnits,
  shopUnits,
}: FacsimileProps) {
  const isTenant = property?.occupancyType === 'TENANT';

  return (
    <div className="relative" style={{ containerType: 'inline-size' }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- rasterised by
          html2canvas for the PDF export; next/image's runtime optimisation
          would only get in the way of that. */}
      <img src="/receipt-template.png" alt="" className="block w-full h-auto select-none" draggable={false} />

      <ImageOverlay field={IMAGE_FIELDS.payerName}>{citizen.fullName}</ImageOverlay>
      <ImageOverlay field={IMAGE_FIELDS.amountLbp}>
        <span className="font-mono">{Math.round(amount).toLocaleString('en-US')}</span>
      </ImageOverlay>
      {payment.currency === 'USD' ? (
        <ImageOverlay field={IMAGE_FIELDS.amountUsd}>
          <span className="font-mono">{Math.round(amount).toLocaleString('en-US')}</span>
        </ImageOverlay>
      ) : null}

      <ImageCheckbox field={IMAGE_CHECKBOXES.residential} checked={!isCommercial} />
      <ImageCheckbox field={IMAGE_CHECKBOXES.commercial} checked={isCommercial} />
      <ImageCheckbox field={IMAGE_CHECKBOXES.owner} checked={isOwner} />
      <ImageCheckbox field={IMAGE_CHECKBOXES.displaced} checked={citizen.residentStatus === 'DISPLACED'} />
      <ImageCheckbox field={IMAGE_CHECKBOXES.bloodType} checked={Boolean(citizen.bloodType)} />

      <ImageOverlay field={IMAGE_FIELDS.propertyNumber}>{property?.propertyNumber || ''}</ImageOverlay>
      <ImageOverlay field={IMAGE_FIELDS.buildingName}>{property?.buildingName || ''}</ImageOverlay>
      <ImageOverlay field={IMAGE_FIELDS.neighborhood}>{property?.neighborhood || ''}</ImageOverlay>
      <ImageOverlay field={IMAGE_FIELDS.units}>{residentialUnits > 0 ? String(residentialUnits) : ''}</ImageOverlay>
      <ImageOverlay field={IMAGE_FIELDS.shops}>{shopUnits > 0 ? String(shopUnits) : ''}</ImageOverlay>
      <ImageOverlay field={IMAGE_FIELDS.phone}>
        <span className="font-mono" dir="ltr">{citizen.phone || ''}</span>
      </ImageOverlay>
      <ImageOverlay field={IMAGE_FIELDS.whatsapp}>
        <span className="font-mono" dir="ltr">{citizen.whatsapp || ''}</span>
      </ImageOverlay>
      {isTenant ? (
        <ImageOverlay field={IMAGE_FIELDS.landlord}>{property?.landlordName || ''}</ImageOverlay>
      ) : null}
    </div>
  );
}

/** Checkbox item matching the official template square boxes. */
function CheckboxItem({ label, checked }: { label: string; checked: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-xs sm:text-sm font-bold text-black">
      <div className="size-5 border-2 border-black flex items-center justify-center font-black text-xs text-black">
        {checked ? '✓' : ''}
      </div>
      <span>{label}</span>
    </div>
  );
}

/** Dotted line fillable row field matching the official municipal receipt format. */
function DottedField({
  label,
  value,
  flex = 'flex-1',
}: {
  label: string;
  value?: React.ReactNode;
  flex?: string;
}) {
  return (
    <div className={`flex items-baseline gap-1.5 ${flex} min-w-0`}>
      <span className="shrink-0 text-xs sm:text-sm font-bold whitespace-nowrap text-black">
        {label} :
      </span>
      <div className="flex-1 border-b-2 border-dotted border-black/80 px-1.5 min-h-[22px] flex items-center font-semibold text-xs sm:text-sm truncate text-black">
        {value || ''}
      </div>
    </div>
  );
}
