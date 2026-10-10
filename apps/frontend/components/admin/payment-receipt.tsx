'use client';

import * as React from 'react';
import { Download, Loader2, MessageCircle, Printer, X } from 'lucide-react';
import { ar } from '@mechanization/shared-schemas';
import type { CitizenProfile, CitizenProfilePayment, CitizenProfileProperty } from '@/lib/api-client';
import { formatForeign, formatLbp } from '@/lib/currency';
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
 * The bill's own reference, for a reprint that has no ledger movement in hand.
 * A payment just recorded prints the ledger's RCP-… number instead
 * (`RecordedMovement.receiptNumber`) — the one a reprint and an audit look up.
 */
function billReference(payment: CitizenProfilePayment): string {
  /*
    The bill's own number, once it has one. Bills raised before migration 0079
    never got one and never will, so those keep printing the derived reference
    below: minting a number today for a document issued last year would put a
    fiction on a printed page.
  */
  if (payment.invoiceNumber) return payment.invoiceNumber;
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
  payment: billRow,
  municipalityName,
  governorate,
  district,
  contactPhone,
  officeWhatsapp,
  receivedAmount,
  recorded,
  councilDecisionRef,
  canSend,
  locale = 'ar',
}: {
  open: boolean;
  /**
   * Whether «إرسال عبر واتساب» is offered. The message carries the citizen's
   * رقم مرجعي, which «مشاهد فقط» is never given (`REFERENCE_SEND_ROLES`): that
   * account reads and prints a receipt, and sends nothing. Required, so a new
   * caller decides rather than inheriting a default that fails open.
   */
  canSend: boolean;
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
  /** For a reprint: the amount to print when it is not the whole bill. */
  receivedAmount?: number;
  /**
   * The movement the server just recorded — its RCP number, its date (a
   * back-dated payment prints its own day), the notes handed over, the rate
   * against the official one, and the change. When present it is the receipt;
   * nothing on it is reconstructed on the client.
   */
  recorded?: RecordedMovement | null;
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

  if (!billRow) return null;

  /*
    A receipt for a movement just recorded describes that movement: its method,
    and none of the bill's review note, which belongs to an earlier movement (a
    Whish claim's review) and would print on a cash receipt as if it were this one's.
  */
  const payment: CitizenProfilePayment = recorded
    ? { ...billRow, paymentMethod: recorded.method ?? billRow.paymentMethod, reviewNote: null }
    : billRow;

  const amount = recorded?.received ?? receivedAmount ?? payment.amount;
  const tenderLine = describeTender(recorded?.tender ?? null, recorded?.changeGiven ?? 0);
  const number = recorded?.receiptNumber ?? billReference(payment);
  // The day the money moved: the recorded one, else the bill's settlement day, else today.
  const receivedOn = formatDate(recorded?.occurredAt ?? payment.paidAt ?? new Date());
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
    `وصل قبض رقم ${number}`,
    '',
    `المكلّف: ${citizen.fullName}`,
    citizen.referenceNumber ? `الرقم المرجعي: ${citizen.referenceNumber}` : null,
    `البند: ${payment.title}`,
    `المبلغ المقبوض: ${formatLbp(amount)}`,
    tenderLine ? `نقداً: ${tenderLine}` : null,
    payment.remaining > 0
      ? `الرصيد المتبقي: ${formatLbp(payment.remaining)}`
      : 'تم تسديد كامل المبلغ. شكراً لكم.',
    '',
    `التاريخ: ${receivedOn}`,
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
      const file = await renderReceiptPdf(node, `وصل-${number}.pdf`);

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
                number={number}
                receivedOn={receivedOn}
                tenderLine={tenderLine}
                tender={recorded?.tender ?? null}
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
                number={number}
                receivedOn={receivedOn}
                tenderLine={tenderLine}
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
                ? `Receipt #${number} • Date: ${receivedOn}`
                : `رقم الوصل: ${number} • التاريخ: ${receivedOn}`}
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
              {canSend ? (
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
              ) : null}
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
  /** The ledger's RCP number for a payment just recorded; the bill reference on a reprint. */
  number: string;
  /** The day the money was received, already formatted. */
  receivedOn: string;
  /** «20 $ + 200,000 ل.ل — بسعر 89,500 …», when cash came in two currencies. */
  tenderLine?: string | null;
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
  tenderLine,
  number,
  receivedOn,
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
                <span className="font-mono">{number}</span>
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
                value={<span className="text-base font-black tabular-nums">{formatLbp(amount)}</span>}
                flex="flex-[2]"
              />
              <DottedField label="تاريخ القبض" value={receivedOn} flex="flex-[1]" />
            </div>

            <DottedField
              label="المبلغ كتابةً"
              value={payment.title ? `عن: ${payment.title}` : 'بدل رسوم خدمات بلدية'}
              flex="w-full"
            />
            {tenderLine ? <DottedField label="نقداً" value={tenderLine} flex="w-full" wrap /> : null}
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
 * dialog renders it.
 *
 * Two rules keep a typed value off the printed ink around it, and both were
 * broken until the boxes below were re-measured against the scan:
 *
 * 1. A box is the *blank* and nothing more. Every row on this form reads
 *    «label : ……………» right to left, so a field's box is inset to its own
 *    run of printed dots, a few pixels clear of the label on its right and
 *    of the next label on its left. A box that reached past either end put
 *    the value on top of the label — which is how «8» came to sit inside
 *    «إسم المبنى», and the phone inside «الواتساب».
 * 2. The text anchors to the *right* edge of that box, where the label ends
 *    and a hand-filled value would start. Inside `dir="rtl"` that is
 *    `justify-start`, not `justify-end`: flex's main axis is reversed here,
 *    so the old `justify-end` pushed every value to the far left of its
 *    blank, as far from its own label as the box allowed and on top of the
 *    next one.
 *
 * Pixel ranges in the comments are measured ink, not estimates: dotted runs
 * from a column-wise classification of the scan (a column is "dots" when all
 * of its ink lies inside that rule's own 4px baseline band), squares and the
 * shaded name box from their borders. Re-measure rather than nudge if the
 * scan is ever replaced.
 */
interface ImageField {
  top: number;
  right: number;
  width: number;
  height: number;
}

/** px → % of the 1280×720 scan, so the table below can stay in measured pixels. */
function box(left: number, right: number, top: number, bottom: number): ImageField {
  return {
    top: (top / 720) * 100,
    right: ((1280 - right) / 1280) * 100,
    width: ((right - left) / 1280) * 100,
    height: ((bottom - top) / 720) * 100,
  };
}

const IMAGE_FIELDS = {
  /** The shaded box the booklet prints for the payer's name: x 275–778, y 215–272. */
  payerName: box(288, 766, 217, 271),
  /** The two rounded pills, «$» left and «ل.ل» right: x 341–591 / 653–903, y 279–331. */
  amountUsd: box(360, 576, 286, 326),
  amountLbp: box(672, 888, 286, 326),
  /** Row «رقم العقار : … إسم المبنى : … الحي : … المنطقة : …», rule at y 407. */
  propertyNumber: box(841, 949, 392, 413),
  buildingName: box(643, 742, 392, 413),
  neighborhood: box(461, 586, 392, 413),
  /** Row «عدد الوحدات السكنية : … المحلات التابعة : … عدد الافراد المقيمين : …», rule at y 443. */
  units: box(774, 877, 429, 450),
  shops: box(584, 652, 429, 450),
  residents: box(321, 428, 429, 450),
  /** Row «اسم المالك بحال كان مستأجر : … الهاتف : … الواتساب : …», rule at y 516. */
  landlord: box(721, 831, 503, 524),
  phone: box(541, 643, 503, 524),
  whatsapp: box(320, 463, 503, 524),
  // Not fields printed on the booklet: the blank under «ايصال», and the open
  // space below «ملاحظات». They carry what the paper never had a box for —
  // the ledger's receipt number and date, and the notes, rate and change of a
  // payment made in two currencies.
  receipt: box(300, 601, 143, 171),
  notes: box(800, 1026, 562, 623),
} as const satisfies Record<string, ImageField>;

/** The five printed squares, measured off their borders: y 352–381, each 45px wide. */
const IMAGE_CHECKBOXES = {
  residential: box(817, 862, 352, 382),
  commercial: box(699, 744, 352, 382),
  owner: box(598, 643, 352, 382),
  displaced: box(503, 548, 352, 382),
  bloodType: box(375, 420, 352, 382),
} as const satisfies Record<string, ImageField>;

/**
 * The scale every overlay is typed at, as a fraction of the rendered width.
 *
 * `cqw` rather than `px` or `rem`: the same numbers then hold for the ~700px
 * dialog preview and for the full-width capture `html2canvas` rasterises into
 * the PDF. The booklet's own printed labels are ~14px tall at 1280px wide,
 * which is where `field`'s 1.05cqw comes from — a typed value matching the
 * pre-printed ink reads as part of the form rather than stuck onto it.
 */
const OVERLAY_TYPE = {
  /** The two pills. The one number a payer checks first, so the heaviest mark on the page. */
  amount: 'text-[1.6cqw] font-black tracking-tight',
  /** The payer's name, sized to the «إستلمنا من السيد/ السيدة» label beside it. */
  name: 'text-[1.45cqw] font-bold',
  /** A value written on one of the printed dotted rules. */
  field: 'text-[1.05cqw] font-bold',
  /** Latin digit runs — a phone, the receipt's own number — which need the extra room. */
  digits: 'text-[0.9cqw] font-semibold tracking-tight',
  /** The tender note under «ملاحظات», the one overlay allowed to wrap. */
  note: 'text-[0.85cqw] font-semibold leading-snug',
} as const;

/** Text sized and positioned to sit in one blank field of the scanned form. */
function ImageOverlay({
  field,
  type = 'field',
  wrap = false,
  children,
}: {
  field: ImageField;
  type?: keyof typeof OVERLAY_TYPE;
  /** Lets a longer note break across lines inside its box instead of being clipped. */
  wrap?: boolean;
  children: React.ReactNode;
}) {
  const style = {
    top: `${field.top}%`,
    right: `${field.right}%`,
    width: `${field.width}%`,
    height: `${field.height}%`,
  };

  if (wrap) {
    return (
      <div
        className={`absolute overflow-hidden text-start text-black ${OVERLAY_TYPE[type]}`}
        style={style}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className={`absolute flex items-center justify-start overflow-hidden whitespace-nowrap text-black ${OVERLAY_TYPE[type]}`}
      style={style}
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
      className="absolute flex items-center justify-center text-[1.4cqw] font-black leading-none text-black"
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
 * over it. The shaded box behind the payer's name and the five squares are
 * printed on the paper itself — pixels in `receipt-template.png`, not
 * anything this component draws — so the work here is seating a value inside
 * each of them, never restyling them.
 *
 * `container-type: inline-size` + `cqw` units size the overlay text off the
 * *rendered* width of this element rather than the viewport. See
 * `IMAGE_FIELDS` for how each box was measured and why values anchor right.
 */
function ImageFacsimile({
  citizen,
  payment,
  amount,
  number,
  receivedOn,
  tenderLine,
  tender,
  property,
  isCommercial,
  isOwner,
  residentialUnits,
  shopUnits,
}: FacsimileProps & { tender: RecordedTender | null }) {
  const isTenant = property?.occupancyType === 'TENANT';

  /*
    The occupancy squares are one answer, not five independent ticks.

    «سكني» used to be `!isCommercial`, which is true of a file carrying no
    property at all — so every card awaiting its first survey printed as
    residential, stated as flatly as one a surveyor had actually walked. The
    blank square is the honest mark there; the collector ticks it in pen.
  */
  const isResidential = property !== null && !isCommercial;

  /*
    One number, printed once. Most files carry the same line as both الهاتف
    and الواتساب, and printing it twice side by side reads as two numbers that
    happen to match — the reader then has to work out which is which, on a
    receipt whose whole job is to be glanced at.
  */
  const whatsapp = citizen.whatsapp && citizen.whatsapp !== citizen.phone ? citizen.whatsapp : null;

  return (
    <div className="relative" style={{ containerType: 'inline-size' }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- rasterised by
          html2canvas for the PDF export; next/image's runtime optimisation
          would only get in the way of that. */}
      <img src="/receipt-template.png" alt="" className="block w-full h-auto select-none" draggable={false} />

      <ImageOverlay field={IMAGE_FIELDS.receipt} type="digits">
        <span className="tabular-nums" dir="ltr">
          {number} · {receivedOn}
        </span>
      </ImageOverlay>
      <ImageOverlay field={IMAGE_FIELDS.payerName} type="name">
        {citizen.fullName}
      </ImageOverlay>
      {/* The ليرة pill is the credit; the dollar pill, the dollars actually handed over. */}
      <ImageOverlay field={IMAGE_FIELDS.amountLbp} type="amount">
        <span className="tabular-nums">{Math.round(amount).toLocaleString('en-US')}</span>
      </ImageOverlay>
      {payment.currency === 'USD' || (tender && tender.foreignCurrency === 'USD') ? (
        <ImageOverlay field={IMAGE_FIELDS.amountUsd} type="amount">
          <span className="tabular-nums">
            {(payment.currency === 'USD' ? amount : (tender?.foreign ?? 0)).toLocaleString('en-US', {
              maximumFractionDigits: 2,
            })}
          </span>
        </ImageOverlay>
      ) : null}
      {tenderLine ? (
        <ImageOverlay field={IMAGE_FIELDS.notes} type="note" wrap>
          {tenderLine}
        </ImageOverlay>
      ) : null}

      <ImageCheckbox field={IMAGE_CHECKBOXES.residential} checked={isResidential} />
      <ImageCheckbox field={IMAGE_CHECKBOXES.commercial} checked={isCommercial} />
      <ImageCheckbox field={IMAGE_CHECKBOXES.owner} checked={isOwner} />
      <ImageCheckbox field={IMAGE_CHECKBOXES.displaced} checked={citizen.residentStatus === 'DISPLACED'} />
      <ImageCheckbox field={IMAGE_CHECKBOXES.bloodType} checked={Boolean(citizen.bloodType)} />

      {property?.propertyNumber ? (
        <ImageOverlay field={IMAGE_FIELDS.propertyNumber}>{property.propertyNumber}</ImageOverlay>
      ) : null}
      {property?.buildingName ? (
        <ImageOverlay field={IMAGE_FIELDS.buildingName}>{property.buildingName}</ImageOverlay>
      ) : null}
      {property?.neighborhood ? (
        <ImageOverlay field={IMAGE_FIELDS.neighborhood}>{property.neighborhood}</ImageOverlay>
      ) : null}
      {residentialUnits > 0 ? (
        <ImageOverlay field={IMAGE_FIELDS.units}>{residentialUnits}</ImageOverlay>
      ) : null}
      {shopUnits > 0 ? <ImageOverlay field={IMAGE_FIELDS.shops}>{shopUnits}</ImageOverlay> : null}
      {citizen.actualHouseholdMembers ? (
        <ImageOverlay field={IMAGE_FIELDS.residents}>{citizen.actualHouseholdMembers}</ImageOverlay>
      ) : null}
      {citizen.phone ? (
        <ImageOverlay field={IMAGE_FIELDS.phone} type="digits">
          <span className="font-mono" dir="ltr">
            {citizen.phone}
          </span>
        </ImageOverlay>
      ) : null}
      {whatsapp ? (
        <ImageOverlay field={IMAGE_FIELDS.whatsapp} type="digits">
          <span className="font-mono" dir="ltr">
            {whatsapp}
          </span>
        </ImageOverlay>
      ) : null}
      {isTenant && property?.landlordName ? (
        <ImageOverlay field={IMAGE_FIELDS.landlord}>{property.landlordName}</ImageOverlay>
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
  wrap = false,
}: {
  label: string;
  value?: React.ReactNode;
  flex?: string;
  /** A line that must print whole — the tender and its rate — wraps instead of truncating. */
  wrap?: boolean;
}) {
  return (
    <div className={`flex items-baseline gap-1.5 ${flex} min-w-0`}>
      <span className="shrink-0 text-xs sm:text-sm font-bold whitespace-nowrap text-black">
        {label} :
      </span>
      <div
        className={`flex-1 border-b-2 border-dotted border-black/80 px-1.5 min-h-[22px] flex items-center font-semibold text-xs sm:text-sm text-black ${wrap ? 'whitespace-normal break-words' : 'truncate'}`}
      >
        {value || ''}
      </div>
    </div>
  );
}

/** Cash as it was handed over — the ليرة part and a foreign part at the rate used. */
export interface RecordedTender {
  local: number;
  foreign: number;
  foreignCurrency: string;
  exchangeRate: number;
  /** The municipality's own rate at the time; printed when the one used differs. */
  officialExchangeRate: number | null;
}

/** What the server recorded for one payment — everything the receipt prints about it. */
export interface RecordedMovement {
  receiptNumber: string;
  occurredAt: string;
  received: number;
  remaining: number;
  changeGiven: number;
  tender: RecordedTender | null;
  /**
   * How this movement was paid — `CASH`, `WHISH_MONEY`, `COLLECTOR`. The bill's
   * own `paymentMethod` is its last movement's, which on a part-paid bill can be
   * an earlier one's; the receipt prints this one's. Optional for a caller that
   * does not know it (the bill's is printed then).
   */
  method?: string | null;
}

/**
 * «20 $ + 200,000 ل.ل — بسعر 89,500 — الباقي المُعاد 79,000 ل.ل», or nothing
 * when only ليرة changed hands and none came back (the total already says
 * that). A rate other than the official one says so on the citizen's copy.
 */
export function describeTender(tendered: RecordedTender | null, changeGiven = 0): string | null {
  const parts: string[] = [];
  if (tendered && tendered.foreign > 0) {
    const notes = [formatForeign(tendered.foreign, tendered.foreignCurrency)];
    if (tendered.local > 0) notes.push(formatLbp(tendered.local));
    parts.push(`${notes.join(' + ')} — بسعر ${tendered.exchangeRate.toLocaleString('en-US')}`);
    if (tendered.officialExchangeRate && tendered.officialExchangeRate !== tendered.exchangeRate) {
      parts.push(`(السعر المعتمد ${tendered.officialExchangeRate.toLocaleString('en-US')})`);
    }
  }
  if (changeGiven > 0) parts.push(`الباقي المُعاد ${formatLbp(changeGiven)}`);
  return parts.length ? parts.join(' — ') : null;
}
