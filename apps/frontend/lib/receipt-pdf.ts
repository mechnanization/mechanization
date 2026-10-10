/**
 * Turning the on-screen وصل قبض into a real PDF file.
 *
 * ── Why raster, not text ────────────────────────────────────────────────
 *
 * The receipt is rasterised by `html2canvas` and the bitmap placed into a PDF,
 * rather than written as PDF text runs. That is deliberate: jsPDF has no
 * Arabic shaping engine, so `بلدية البازورية` written as text comes out as
 * disconnected, left-to-right letterforms — `ب ل د ي ة` — unless you embed a
 * font *and* run bidi + glyph substitution yourself. The browser has already
 * done all of that to paint the element; photographing its output preserves it
 * exactly.
 *
 * The cost is that the PDF's text is not selectable or searchable. For a
 * receipt that is a facsimile of a paper book — filled in, signed by hand and
 * filed — that is the same trade a scanner makes, and the right one here.
 *
 * ── Why this is loaded lazily ───────────────────────────────────────────
 *
 * `jspdf` + `html2canvas` are ~200 kB gzipped between them. A clerk opens a
 * receipt a few times a day; every other page in the portal would otherwise
 * carry that weight on first load. The dynamic `import()` inside the function
 * keeps both out of the initial bundle and off every route that never prints.
 */

/** A4 in millimetres, each way round: landscape is what the single receipt's layout is drawn for. */
const PAGE = {
  landscape: { width: 297, height: 210 },
  portrait: { width: 210, height: 297 },
} as const;

export interface ReceiptPdfOptions {
  /**
   * The A4 sheet's orientation. Landscape, the default, is the single receipt's;
   * portrait is a document's, such as the consolidated receipt
   * (`BulkPaymentReceipt`), which prints on A4 portrait too (PRIM-28).
   */
  orientation?: 'landscape' | 'portrait';
  /**
   * The elements a sheet may end before, as a CSS selector (`tr`). With it a
   * capture taller than one sheet is fitted to the sheet's width and cut
   * between those elements over as many sheets as it needs, so a long list
   * stays readable instead of shrinking onto one page; without it the capture
   * is shrunk onto one sheet, as the single receipt always has been.
   */
  breakBefore?: string;
}

/**
 * Renders `element` to a PDF and returns it as a `File`: one sheet, or several
 * when `breakBefore` is given and the capture is taller than one.
 *
 * A `File` rather than a `Blob` because `navigator.share` requires one — the
 * share sheet needs a name and a MIME type to hand WhatsApp, and a bare Blob
 * is rejected by `canShare`.
 */
export async function renderReceiptPdf(
  element: HTMLElement,
  fileName: string,
  options: ReceiptPdfOptions = {},
): Promise<File> {
  const orientation = options.orientation ?? 'landscape';
  const sheet = PAGE[orientation];
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  const dpr = typeof window !== 'undefined' ? Math.max(2, window.devicePixelRatio || 2) : 2;
  const canvas = await html2canvas(element, {
    // 2× minimum so the print is not visibly soft — a receipt is read at arm's length
    // on paper, where a 1× rasterisation of 11px Arabic is mush.
    scale: dpr,
    // The receipt is deliberately black-on-white regardless of the dashboard's
    // theme; without this the dark-mode surface bleeds through as a black page.
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
    /*
      Photographed in the light theme. A document drawn in the theme's tokens —
      the consolidated receipt, like the statement — would otherwise come out
      as the dark theme's surfaces under near-white text. The single receipt is
      literal black on white and looks the same either way. Only the copy
      html2canvas renders is changed, never the page.
    */
    onclone: (copy) => {
      copy.documentElement.classList.remove('dark');
    },
  });

  const pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4' });

  const margin = 10;
  const maxWidth = sheet.width - margin * 2;
  const maxHeight = sheet.height - margin * 2;

  // Canvas pixels per millimetre with the capture at the sheet's full width.
  const perMm = canvas.width / maxWidth;
  if (options.breakBefore && canvas.height > maxHeight * perMm) {
    addSheets(pdf, canvas, element, options.breakBefore, { margin, maxWidth, maxHeight, perMm, orientation });
  } else {
    // Fit the capture inside the page while preserving its aspect ratio, then
    // centre it. Stretching to the page would distort the form's rules and boxes.
    const ratio = Math.min(maxWidth / canvas.width, maxHeight / canvas.height);
    const width = canvas.width * ratio;
    const height = canvas.height * ratio;

    pdf.addImage(
      canvas.toDataURL('image/png'),
      'PNG',
      (sheet.width - width) / 2,
      (sheet.height - height) / 2,
      width,
      height,
    );
  }

  const blob = pdf.output('blob');
  return new File([blob], fileName, { type: 'application/pdf' });
}

/**
 * Lays a capture taller than one sheet over several, at the sheet's full width,
 * each sheet ending before one of the `breakBefore` elements (a table row), so
 * no row is cut through its text. A sheet with no such element in its lower two
 * thirds is cut at its foot instead, rather than leaving most of it blank.
 */
function addSheets(
  pdf: import('jspdf').jsPDF,
  canvas: HTMLCanvasElement,
  element: HTMLElement,
  breakBefore: string,
  layout: { margin: number; maxWidth: number; maxHeight: number; perMm: number; orientation: 'landscape' | 'portrait' },
): void {
  const sheetPx = Math.floor(layout.maxHeight * layout.perMm);
  const box = element.getBoundingClientRect();
  // Canvas pixels per CSS pixel: the capture's scale, measured rather than assumed.
  const scale = canvas.height / Math.max(1, box.height);
  const cuts = Array.from(element.querySelectorAll(breakBefore))
    .map((node) => Math.round((node.getBoundingClientRect().top - box.top) * scale))
    .filter((y) => y > 0 && y < canvas.height)
    .sort((a, b) => a - b);

  let start = 0;
  let first = true;
  while (start < canvas.height) {
    let end = Math.min(start + sheetPx, canvas.height);
    if (end < canvas.height) {
      const cut = cuts.filter((y) => y > start + sheetPx / 3 && y <= end).pop();
      if (cut !== undefined) end = cut;
    }
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    slice.height = end - start;
    const context = slice.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');
    // The capture is opaque (painted on white above), so the slice needs no background of its own.
    context.drawImage(canvas, 0, start, canvas.width, end - start, 0, 0, canvas.width, end - start);
    if (!first) pdf.addPage('a4', layout.orientation);
    pdf.addImage(
      slice.toDataURL('image/png'),
      'PNG',
      layout.margin,
      layout.margin,
      layout.maxWidth,
      (end - start) / layout.perMm,
    );
    first = false;
    start = end;
  }
}

/**
 * Hands a file to the OS share sheet — which on a phone, and on desktops with
 * WhatsApp installed, includes WhatsApp itself.
 *
 * **This is the only way a `wa.me`-based flow can carry an actual attachment.**
 * A `wa.me` link takes a `text` parameter and nothing else; there is no
 * parameter for a file, and no amount of URL construction adds one. The Web
 * Share API is the browser's own hand-off to a native app, so the PDF goes
 * across as a document rather than as a link to one.
 *
 * Returns false when the browser cannot share files (Firefox, and most desktop
 * browsers without a share target), so the caller can fall back rather than
 * silently doing nothing.
 */
export async function shareFile(file: File, text: string): Promise<boolean> {
  // `canShare` must be asked about the *actual* payload: a browser can support
  // `share` for text and still refuse files, and calling `share` regardless
  // throws a TypeError the user would see as a broken button.
  if (typeof navigator === 'undefined' || !navigator.canShare?.({ files: [file] })) {
    return false;
  }

  try {
    await navigator.share({ files: [file], text });
    return true;
  } catch (error) {
    // A user dismissing the sheet raises AbortError. That is not a failure and
    // must not trigger the "sharing did not work" fallback — re-opening a
    // download they just cancelled is worse than doing nothing.
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    return false;
  }
}

/** Saves the PDF to disk, for the fallback path. */
export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  // Revoked on the next tick rather than immediately: Safari has not finished
  // reading the blob when `click()` returns, and revoking synchronously there
  // produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
