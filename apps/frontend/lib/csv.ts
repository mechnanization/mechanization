import {
  IMPORT_COLUMNS,
  IMPORT_HEADER_TO_KEY,
  normalizeArabic,
  type ImportColumnKey,
  type ImportRow,
} from '@mechanization/shared-schemas';

/**
 * CSV reading and writing for the citizen import.
 *
 * Hand-rolled rather than pulled from npm. The requirement is one table of
 * text with quoted fields — RFC 4180 minus everything a spreadsheet never
 * emits — and the parsers that would do it bring a streaming API, a worker
 * harness and a type-inference layer that this has no use for. What is *not*
 * negotiable is the handful of things an Arabic register out of Excel actually
 * does: a UTF-8 BOM, semicolon delimiters, CRLF endings and quoted cells with
 * commas inside. Those are handled below and are the reason this is not a
 * `split(',')`.
 */

/** Excel writes a BOM on UTF-8 CSV; left in place it becomes part of header one. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Picks the delimiter from the header line.
 *
 * Excel follows the machine's list separator, which is `;` across the Arabic
 * and European locales this will be used in and `,` elsewhere — the same file
 * saved on two clerks' laptops differs in this one character. Counting on the
 * header alone is deliberate: a data row may contain semicolons legitimately
 * (`sharedRights` uses them), while the header never does.
 */
function detectDelimiter(headerLine: string): string {
  const counts = [',', ';', '\t'].map(
    (candidate) => [candidate, headerLine.split(candidate).length - 1] as const,
  );
  const [best] = counts.sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

/**
 * Splits CSV text into rows of cells.
 *
 * A character-at-a-time walk because a newline inside a quoted cell is data,
 * not a row break — splitting on `\n` first and repairing afterwards is the
 * bug this shape avoids. `""` inside a quoted run is a literal quote.
 */
function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  // Whatever is still in hand is the last row, unless the file ended on a
  // newline and there is genuinely nothing left.
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

export interface ParsedCsv {
  /** Rows keyed by import column, header row excluded. */
  rows: ImportRow[];
  /** Headers that matched no known column — surfaced, never silently dropped. */
  unknownHeaders: string[];
  /** Required columns the file is missing entirely. */
  missingColumns: string[];
}

/**
 * Reads a citizen-import CSV.
 *
 * Headers are matched through `normalizeArabic`, so a file whose الشهرة picked
 * up a trailing space or a stray diacritic still lands on the right column
 * rather than being reported as unknown while the real column reads blank.
 * Column *order* is never assumed — a register exported from another system
 * will not match the template's order, and demanding that it does would make
 * the template the only usable input.
 */
export function parseCitizenCsv(text: string): ParsedCsv {
  const cleaned = stripBom(text).trim();
  if (cleaned === '') return { rows: [], unknownHeaders: [], missingColumns: [] };

  const firstLineEnd = cleaned.indexOf('\n');
  const headerLine = firstLineEnd < 0 ? cleaned : cleaned.slice(0, firstLineEnd);
  const table = parseRows(cleaned, detectDelimiter(headerLine));
  if (table.length === 0) return { rows: [], unknownHeaders: [], missingColumns: [] };

  const lookup = new Map(
    Object.entries(IMPORT_HEADER_TO_KEY).map(([header, key]) => [normalizeArabic(header), key]),
  );

  const [headerCells, ...bodyRows] = table;
  const unknownHeaders: string[] = [];
  const columnKeys = headerCells.map((header) => {
    const key = lookup.get(normalizeArabic(header));
    if (!key && header.trim() !== '') unknownHeaders.push(header.trim());
    return key;
  });

  const present = new Set(columnKeys.filter(Boolean) as ImportColumnKey[]);
  const missingColumns = IMPORT_COLUMNS.filter(
    (column) => column.always && !present.has(column.key),
  ).map((column) => column.header);

  const rows: ImportRow[] = [];
  for (const cells of bodyRows) {
    // A trailing blank line, or a row of empty cells left behind by a deleted
    // record, is not a citizen — importing it would report a wall of
    // "الاسم مطلوب" against rows the clerk did not know were there.
    if (cells.every((cell) => cell.trim() === '')) continue;

    const row: ImportRow = {};
    columnKeys.forEach((key, index) => {
      if (!key) return;
      const value = (cells[index] ?? '').trim();
      if (value !== '') row[key] = value;
    });
    rows.push(row);
  }

  return { rows, unknownHeaders, missingColumns };
}

/** Quotes a cell only when it has to be — a fully quoted file is unreadable in a text editor. */
function escapeCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Quotes a cell, and neutralises formula injection.
 *
 * Arabic names are fine; a value starting with `=`, `+`, `-` or `@` is executed
 * by Excel the moment a clerk opens the file. Every column of a census export
 * is text somebody typed into this system — a building name, an officer's note
 * — so a field a resident can influence must not be able to run a formula on a
 * municipality's machine.
 *
 * Deliberately identical to `csvCell` in `reporting.service.ts`, which does the
 * same job for the server-side citizen export. Two copies rather than a shared
 * module because the two live in different packages with no dependency between
 * them; a third would be the moment to move it into shared-schemas.
 *
 * Unlike `escapeCell` this always quotes, and the two halves are not separable:
 * a leading `'` only means "treat the rest as text" inside a quoted field.
 */
export function csvCell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * A whole sheet — header row plus data rows — with the BOM Excel needs to read
 * Arabic as UTF-8 rather than mojibake.
 *
 * The same BOM `stripBom` removes on the way back in. Without it every Arabic
 * column opens as `Ø§Ù„Ø­ÙŠ`, which is the failure this format is most often
 * blamed for and the easiest to prevent.
 */
export function buildCsv(header: readonly string[], rows: readonly unknown[][]): string {
  const lines = [
    header.map(csvCell).join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ];
  return `﻿${lines.join('\n')}\n`;
}

/**
 * The downloadable template: the header row, plus one filled example row.
 *
 * The example is worth more than the column reference beside it — it shows the
 * expected shape of a phone number and which columns to leave blank for an
 * owner, which is most of what a clerk gets wrong on the first attempt. It is a
 * HOUSE row because that is the commonest record in the register.
 */
export function buildCitizenTemplate(): string {
  const example: ImportRow = {
    firstName: 'علي',
    middleName: 'حسن',
    lastName: 'خليل',
    gender: 'ذكر',
    isLebanese: 'نعم',
    nationality: 'لبناني',
    residentStatus: 'من سكان الضيعة',
    identityDocType: 'هوية',
    identityDocNumber: '1234567',
    civilRecordNumber: '12',
    maritalStatus: 'متزوج',
    phone: '03123456',
    totalRegisteredMembers: '5',
    actualHouseholdMembers: '5',
    occupancyType: 'مالك',
    propertyType: 'منزل',
    neighborhood: 'الحي الشرقي',
    propertyNumber: '1024',
    buildingName: 'منزل خليل',
    unitArea: '180',
  };

  const header = IMPORT_COLUMNS.map((column) => escapeCell(column.header)).join(',');
  const row = IMPORT_COLUMNS.map((column) => escapeCell(example[column.key] ?? '')).join(',');

  // Leading BOM so Excel opens it as UTF-8 rather than mojibake — the same
  // BOM `stripBom` removes on the way back in.
  return `﻿${header}\n${row}\n`;
}

/** Triggers a client-side download without a round trip to the server. */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
