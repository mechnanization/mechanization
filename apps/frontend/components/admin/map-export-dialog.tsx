'use client';

import { useRef } from 'react';
import { Download, MapPin, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function MapExportDialog({
  open,
  onOpenChange,
  mapDataUrl,
  tenant,
  locale = 'ar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapDataUrl: string | null;
  tenant: string;
  locale?: string;
}) {
  const isEnglish = locale === 'en';
  const printRef = useRef<HTMLDivElement>(null);

  const handleDownload = () => {
    if (!mapDataUrl) return;
    const a = document.createElement('a');
    a.href = mapDataUrl;
    a.download = `municipal-map-${tenant}-${new Date().toISOString().slice(0, 10)}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handlePrint = () => {
    if (!mapDataUrl) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const formattedDate = new Date().toLocaleString(isEnglish ? 'en-US' : 'ar-LB', {
      dateStyle: 'full',
      timeStyle: 'short',
    });

    const tenantName =
      tenant === 'albazourieh'
        ? (isEnglish ? 'Municipality of Albazourieh' : 'بلدية البازورية')
        : (isEnglish ? `Municipality of ${tenant}` : `بلدية ${tenant}`);

    printWindow.document.write(`
      <!DOCTYPE html>
      <html dir="${isEnglish ? 'ltr' : 'rtl'}">
        <head>
          <title>${isEnglish ? 'Municipal Map Extract' : 'مخطط موقع عقاري - البلدية'}</title>
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              margin: 20px;
              color: #0f172a;
            }
            .header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              border-bottom: 2px solid #0f172a;
              padding-bottom: 12px;
              margin-bottom: 16px;
            }
            .title { font-size: 20px; font-weight: bold; }
            .subtitle { font-size: 13px; color: #475569; margin-top: 4px; }
            .map-container {
              border: 1px solid #cbd5e1;
              border-radius: 8px;
              overflow: hidden;
              margin-bottom: 16px;
            }
            .map-container img {
              width: 100%;
              display: block;
              max-height: 70vh;
              object-fit: contain;
            }
            .footer {
              display: flex;
              justify-content: space-between;
              font-size: 11px;
              color: #64748b;
              border-top: 1px dashed #cbd5e1;
              padding-top: 8px;
            }
            @media print {
              body { margin: 0; }
              @page { size: landscape; margin: 15mm; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <div class="title">${tenantName}</div>
              <div class="subtitle">${isEnglish ? 'Official Cadastral & Geographic Map' : 'المخطط الجغرافي والعقاري الرسمي'}</div>
            </div>
            <div style="text-align: end; font-size: 12px; color: #475569;">
              <div>${isEnglish ? 'Date of Issue:' : 'تاريخ الإصدار:'} ${formattedDate}</div>
              <div>${isEnglish ? 'Geographic System (GIS)' : 'نظام المعلومات الجغرافية'}</div>
            </div>
          </div>
          <div class="map-container">
            <img src="${mapDataUrl}" alt="Map Export" />
          </div>
          <div class="footer">
            <div>${isEnglish ? 'Electronic extract generated via Municipal Platform' : 'مستخرج إلكتروني صادر عن منصة مكننة العمل البلدي'}</div>
            <div>${isEnglish ? 'Cadastral Projection: WGS 84' : 'المسقط العقاري: WGS 84'}</div>
          </div>
          <script>
            window.onload = function() {
              window.print();
              window.onafterprint = function() { window.close(); };
            };
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl overflow-hidden p-0">
        <DialogHeader className="border-b p-4 pb-3">
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <MapPin className="size-5 text-primary" />
            {isEnglish ? 'Export & Print Map' : 'طباعة وتصدير المخطط الجغرافي'}
          </DialogTitle>
        </DialogHeader>

        <div className="p-4 space-y-4">
          {/* Map Preview Canvas */}
          <div
            ref={printRef}
            className="relative overflow-hidden rounded-xl border border-border/80 bg-muted/40 shadow-inner flex items-center justify-center min-h-[320px] max-h-[55dvh]"
          >
            {mapDataUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={mapDataUrl}
                alt="Map Snapshot"
                className="w-full h-auto max-h-[55dvh] object-contain rounded-lg"
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {isEnglish ? 'Capturing map view…' : 'جارٍ التقاط صورة الخريطة…'}
              </p>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <p className="text-xs text-muted-foreground">
              {isEnglish
                ? 'Includes active layers, parcel boundaries, and municipality metadata.'
                : 'يتضمن الطبقات النشطة، حدود العقارات، وترويسة البلدية الرسمية.'}
            </p>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={!mapDataUrl}
                className="gap-1.5 text-xs font-semibold cursor-pointer"
              >
                <Download className="size-3.5" />
                {isEnglish ? 'Save Image (PNG)' : 'حفظ كصورة (PNG)'}
              </Button>

              <Button
                type="button"
                size="sm"
                onClick={handlePrint}
                disabled={!mapDataUrl}
                className="gap-1.5 text-xs font-semibold cursor-pointer"
              >
                <Printer className="size-3.5" />
                {isEnglish ? 'Print Official Map' : 'طباعة المخطط'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}