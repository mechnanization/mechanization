import { z } from 'zod';
import { ar } from './labels';
import {
  BLOOD_TYPE,
  GENDER,
  IDENTITY_DOC_TYPE,
  LAND_TYPE,
  MARITAL_STATUS,
  NON_OWNER_OCCUPANCY,
  OCCUPANCY_TYPE,
  PROPERTY_TYPE,
  RESIDENT_STATUS,
  UNIT_STATUS,
  UNIT_TYPE,
} from './enums';
import { normalizeDigits } from './primitives';

/**
 * Bulk citizen import — one spreadsheet row per citizen.
 *
 * The municipality's existing register arrives as a spreadsheet, not as two
 * hundred visits to «تسجيل مواطن جديد». What this file owns is the *mapping*
 * from a flat Arabic-headed row to the nested payload the create path already
 * takes; it deliberately owns no validation rules of its own. A row is shaped
 * here and then handed to `adminCreateCitizenSchema` — the same object the
 * single-citizen form validates against — so an import can never accept a
 * record the form would reject, which is the failure mode that makes bulk
 * loaders quietly corrupt a register.
 */

/**
 * A building is the one property type this cannot fully express.
 *
 * A مبنى holds many units, and many units do not fit on one row. Rather than
 * inventing a nested CSV dialect nobody can produce from Excel, a BUILDING row
 * carries exactly one unit through the `unit*` columns — the overwhelmingly
 * common case in the register — and a landlord with a genuine multi-unit block
 * is entered through the form, which already has a units editor. The import
 * says so rather than silently dropping the other units.
 */
export const IMPORT_COLUMN_KEYS = [
  'firstName',
  'middleName',
  'lastName',
  'gender',
  'bloodType',
  'isLebanese',
  'nationality',
  'residentStatus',
  'identityDocType',
  'identityDocNumber',
  'civilRecordNumber',
  'residencyNumber',
  'maritalStatus',
  'phone',
  'whatsapp',
  'totalRegisteredMembers',
  'actualHouseholdMembers',
  'occupancyType',
  'landlordName',
  'landlordPhone',
  'propertyType',
  'neighborhood',
  'propertyNumber',
  'buildingName',
  'side',
  'unitArea',
  'landType',
  'shares',
  'tentLocation',
  'sharedRights',
  'unitType',
  'unitFloor',
  'unitStatus',
] as const;

export type ImportColumnKey = (typeof IMPORT_COLUMN_KEYS)[number];

export interface ImportColumn {
  key: ImportColumnKey;
  /** The Arabic header a clerk sees in the template's first row. */
  header: string;
  /** Shown in the column reference; says when the column is needed. */
  hint: string;
  /** Required on every row regardless of the branches taken. */
  always?: boolean;
}

/**
 * The template's columns, in order.
 *
 * One list drives the downloadable template, the header matcher and the
 * on-screen reference — three things that were guaranteed to drift if each
 * spelled the headers itself.
 */
export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  { key: 'firstName', header: 'الاسم الأول', hint: 'إلزامي', always: true },
  { key: 'middleName', header: 'اسم الأب', hint: 'إلزامي', always: true },
  { key: 'lastName', header: 'الشهرة', hint: 'إلزامي', always: true },
  {
    key: 'gender',
    header: 'الجنس',
    hint: Object.values(ar.gender).join(' / '),
    always: true,
  },
  {
    key: 'bloodType',
    header: 'فئة الدم',
    hint: Object.values(ar.bloodType).join(' / '),
    always: true,
  },
  { key: 'isLebanese', header: 'لبناني', hint: 'نعم / لا', always: true },
  { key: 'nationality', header: 'الجنسية', hint: 'مثال: لبناني، سوري', always: true },
  {
    key: 'residentStatus',
    header: 'صفة الإقامة',
    hint: Object.values(ar.residentStatus).join(' / '),
    always: true,
  },
  /*
    The identity-document columns stay so sheets built against the old template
    keep parsing, but nothing requires them any more: an identity document is no
    longer collected for a Lebanese citizen, and a non-Lebanese one's passport and
    residency numbers are «إلزامي إن وجد» — written when the person has one, never
    invented. See `personalDetailsObject.identityDocType`.
  */
  {
    key: 'identityDocType',
    header: 'نوع الوثيقة',
    hint: 'لغير اللبنانيين: جواز سفر — اختياري',
  },
  // Header text is the column's identity (`HEADER_TO_KEY`), so it keeps its old
  // wording; only the hint changed.
  { key: 'identityDocNumber', header: 'رقم الوثيقة', hint: 'رقم جواز السفر لغير اللبنانيين — إلزامي إن وجد' },
  { key: 'civilRecordNumber', header: 'رقم السجل', hint: 'إلزامي للبنانيين، أرقام فقط' },
  { key: 'residencyNumber', header: 'رقم الإقامة', hint: 'لغير اللبنانيين — إلزامي إن وجد' },
  {
    key: 'maritalStatus',
    header: 'الحالة الاجتماعية',
    hint: Object.values(ar.maritalStatus).join(' / '),
    always: true,
  },
  { key: 'phone', header: 'رقم الهاتف', hint: 'مثال: 03123456', always: true },
  { key: 'whatsapp', header: 'رقم الواتساب', hint: 'اتركه فارغاً إن كان نفس الهاتف' },
  {
    key: 'totalRegisteredMembers',
    header: 'عدد أفراد الأسرة الإجمالي',
    hint: 'شاملاً الأبناء المتزوجين',
    always: true,
  },
  {
    key: 'actualHouseholdMembers',
    header: 'عدد أفراد الأسرة الفعليين',
    hint: 'باستثناء الأبناء المتزوجين المستقلين',
    always: true,
  },
  {
    key: 'occupancyType',
    header: 'نوع الإشغال',
    hint: Object.values(ar.occupancyType).join(' / '),
    always: true,
  },
  {
    key: 'landlordName',
    header: 'اسم المالك',
    hint: 'إلزامي للمستأجر والشاغل بتسامح',
  },
  { key: 'landlordPhone', header: 'هاتف المالك', hint: 'إلزامي للمستأجر فقط' },
  {
    key: 'propertyType',
    header: 'نوع العقار',
    hint: Object.values(ar.propertyType).join(' / '),
    always: true,
  },
  /*
    The column stays in the template so sheets already built against it keep
    importing their values, but it is no longer required — see
    `neighborhoodField`. A hint still reading «إلزامي» would send people looking
    for a value nothing asks for and nothing refuses.
  */
  { key: 'neighborhood', header: 'الحي', hint: 'اختياري', always: true },
  { key: 'propertyNumber', header: 'رقم العقار', hint: 'يُطابَق مع السجل العقاري', always: true },
  { key: 'buildingName', header: 'اسم المبنى', hint: 'إلزامي للمبنى والمنزل' },
  { key: 'side', header: 'الجهة', hint: 'اختياري — للمنزل والوحدة' },
  { key: 'unitArea', header: 'المساحة', hint: 'م² — إلزامي للمنزل والأرض والوحدة' },
  {
    key: 'landType',
    header: 'نوع الأرض',
    hint: `${Object.values(ar.landType).join(' / ')} — للأرض فقط`,
  },
  // Header unchanged (it is the column's identity); a tenant of land holds no shares.
  { key: 'shares', header: 'الأسهم', hint: 'من أصل 2400 — إلزامي لمالك الأرض فقط' },
  { key: 'tentLocation', header: 'موقع الخيمة', hint: 'إلزامي للخيمة فقط' },
  { key: 'sharedRights', header: 'الحقوق المشتركة', hint: 'اختياري — افصل بينها بفاصلة منقوطة ؛' },
  {
    key: 'unitType',
    header: 'نوع الوحدة',
    hint: `${Object.values(ar.unitType).join(' / ')} — للمبنى فقط`,
  },
  { key: 'unitFloor', header: 'الطابق', hint: 'إلزامي للمبنى فقط' },
  {
    key: 'unitStatus',
    header: 'حالة الوحدة',
    // Optional in the file for the same reason it is optional in the form: an
    // imported register that never recorded vacancy should not have a value
    // invented for every row on the way in. Blank means "not asked", and the
    // biller reads it as occupied.
    hint: `${Object.values(ar.unitStatus).join(' / ')} — اختياري، للمالك فقط`,
  },
];

/** Header → key, for matching whatever order a clerk's file happens to use. */
export const IMPORT_HEADER_TO_KEY: Readonly<Record<string, ImportColumnKey>> =
  Object.fromEntries(IMPORT_COLUMNS.map((column) => [column.header, column.key]));

/**
 * Folds the spelling differences that are not differences.
 *
 * A register typed by several people over several years contains مطلّق and
 * مطلق, أعزب and اعزب, and trailing spaces from every one of them. Comparing
 * raw strings against the label table rejects all but one spelling and reports
 * it as an invalid value, which is both wrong and impossible to act on. The
 * normalisation is the standard Arabic set — strip the diacritics that are
 * optional in writing, unify the alef and yeh forms — and is applied to both
 * sides of every enum comparison.
 */
export function normalizeArabic(value: string): string {
  return value
    .trim()
    // Harakat and tatweel: decorative, and never typed consistently.
    .replace(/[ً-ْـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}


/**
 * Resolves a cell to an enum member, accepting either the Arabic label a clerk
 * reads or the machine value an export produced.
 */
function toEnum<T extends string>(
  values: readonly T[],
  labels: Record<string, string>,
  cell: string,
): T | undefined {
  const needle = normalizeArabic(cell);
  if (!needle) return undefined;

  for (const value of values) {
    if (normalizeArabic(value) === needle) return value;
    if (normalizeArabic(labels[value] ?? '') === needle) return value;
  }
  return undefined;
}

const YES = ['نعم', 'true', '1', 'y', 'yes', 'لبناني'].map(normalizeArabic);
const NO = ['لا', 'false', '0', 'n', 'no', 'اجنبي', 'غير لبناني'].map(normalizeArabic);

/** Tri-state on purpose: an unrecognised cell must not silently read as false. */
function toBoolean(cell: string): boolean | undefined {
  const needle = normalizeArabic(cell);
  if (YES.includes(needle)) return true;
  if (NO.includes(needle)) return false;
  return undefined;
}

/** Blank cells become `undefined` so optional fields stay genuinely absent. */
function text(cell: string | undefined): string | undefined {
  const trimmed = (cell ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

export type ImportRow = Partial<Record<ImportColumnKey, string>>;

/**
 * Shapes one flat row into the nested object `adminCreateCitizenSchema` takes.
 *
 * Returns a plain `unknown` rather than a typed payload, and does not validate:
 * every rule — a tenant needing a landlord, a Lebanese citizen needing a رقم
 * سجل, خيمة being refugee-only — belongs to that schema and is enforced by it.
 * What happens here is only translation, so a wrong cell surfaces as the same
 * Arabic message the form would have shown for the same mistake.
 */
export function buildCitizenPayload(row: ImportRow): unknown {
  const propertyType = toEnum(PROPERTY_TYPE, ar.propertyType, row.propertyType ?? '');
  const occupancyType = toEnum(OCCUPANCY_TYPE, ar.occupancyType, row.occupancyType ?? '');

  const sharedRights = text(row.sharedRights)
    // Semicolon, not comma: a comma inside a CSV cell has to be quoted, and a
    // register exported from Excel by a clerk will not be.
    ? text(row.sharedRights)!
        .split(/[;؛]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

  const area = text(row.unitArea) ? normalizeDigits(text(row.unitArea)!) : undefined;

  /** The property-type branch, mirroring `propertyBranch` field for field. */
  /*
    A شاغل بتسامح needs the landlord block too.

    Gated on TENANT alone, a file whose نوع الإشغال column says «شاغل بتسامح»
    would have its اسم المالك silently dropped here and then be rejected for
    not having one — a validation error naming a column the clerk did fill in.
  */
  const isNonOwner = (NON_OWNER_OCCUPANCY as readonly string[]).includes(
    occupancyType as string,
  );

  const unitStatus = row.unitStatus
    ? toEnum(UNIT_STATUS, ar.unitStatus, row.unitStatus)
    : undefined;

  const property: Record<string, unknown> = {
    occupancyType,
    ...(isNonOwner
      ? { landlordName: text(row.landlordName), landlordPhone: text(row.landlordPhone) }
      : {}),
    propertyType,
    neighborhood: text(row.neighborhood),
    propertyNumber: text(row.propertyNumber),
  };

  if (propertyType === 'BUILDING') {
    property.buildingName = text(row.buildingName);
    property.units = [
      {
        unitType: toEnum(UNIT_TYPE, ar.unitType, row.unitType ?? ''),
        floor: text(row.unitFloor),
        side: text(row.side),
        unitArea: area,
        sharedRights,
        unitStatus,
      },
    ];
  } else if (propertyType === 'HOUSE') {
    property.buildingName = text(row.buildingName);
    property.side = text(row.side);
    property.unitArea = area;
    property.sharedRights = sharedRights;
    property.unitStatus = unitStatus;
  } else if (propertyType === 'LAND') {
    property.landType = toEnum(LAND_TYPE, ar.landType, row.landType ?? '');
    property.unitArea = area;
    property.shares = text(row.shares) ? normalizeDigits(text(row.shares)!) : undefined;
  } else if (propertyType === 'TENT') {
    property.tentLocation = text(row.tentLocation);
  }

  const whatsapp = text(row.whatsapp);

  return {
    personal: {
      firstName: text(row.firstName),
      middleName: text(row.middleName),
      lastName: text(row.lastName),
      gender: toEnum(GENDER, ar.gender, row.gender ?? ''),
      bloodType:
        toEnum(BLOOD_TYPE, ar.bloodType, row.bloodType ?? '') ??
        (row.bloodType?.trim().toUpperCase() as never),
      identityDocType: toEnum(IDENTITY_DOC_TYPE, ar.identityDocType, row.identityDocType ?? ''),
      identityDocNumber: text(row.identityDocNumber),
      civilRecordNumber: text(row.civilRecordNumber)
        ? normalizeDigits(text(row.civilRecordNumber)!)
        : undefined,
      nationality: text(row.nationality),
      isLebanese: toBoolean(row.isLebanese ?? ''),
      residencyNumber: text(row.residencyNumber),
      residentStatus: toEnum(RESIDENT_STATUS, ar.residentStatus, row.residentStatus ?? ''),
    },
    contact: {
      maritalStatus: toEnum(MARITAL_STATUS, ar.maritalStatus, row.maritalStatus ?? ''),
      phone: text(row.phone),
      // A blank الواتساب column means "same as the phone" rather than "no
      // WhatsApp": the contact schema copies the phone across when this is on.
      whatsappSameAsPhone: whatsapp === undefined,
      whatsapp,
      totalRegisteredMembers: text(row.totalRegisteredMembers)
        ? normalizeDigits(text(row.totalRegisteredMembers)!)
        : undefined,
      actualHouseholdMembers: text(row.actualHouseholdMembers)
        ? normalizeDigits(text(row.actualHouseholdMembers)!)
        : undefined,
    },
    properties: [property],
  };
}

/**
 * The wire format: raw cells, not a pre-shaped payload.
 *
 * The browser sends what it read out of the file and the server does the
 * shaping, so the mapping above runs exactly once, on the side that also runs
 * the validation. A client that shaped the payload itself would be a second
 * implementation of the branch rules, free to disagree with this one.
 */
export const citizenImportSchema = z.object({
  /**
   * One **batch**, not one file.
   *
   * The client splits a file into batches of `IMPORT_BATCH_SIZE` and posts them
   * in turn, so this ceiling bounds a single request rather than the size of
   * register a municipality may load. Two things forced that shape: Arabic is
   * two bytes a character, so a whole file of a few hundred rows overran the
   * body limit; and each row opens a transaction, so a file sent in one request
   * would hold the connection open long past any proxy's patience.
   */
  rows: z
    .array(z.record(z.string(), z.string()))
    .min(1, 'الملف لا يحتوي على أي صف')
    .max(500, 'عدد الصفوف في الدفعة كبير جداً'),
  /**
   * Row number of `rows[0]` **in the clerk's file**, header excluded.
   *
   * Without it every batch would number its rows from one, and the second
   * batch's errors would point at the first batch's rows — the single most
   * confusing thing a batched importer can do to someone holding the
   * spreadsheet.
   */
  startRow: z.number().int().min(1).default(1),
  /** Validate and report without writing anything. */
  dryRun: z.boolean().default(false),
});

/**
 * Rows per request.
 *
 * Sized so a batch stays well inside the API's 1 MB body limit with Arabic
 * text at two bytes a character, and small enough that the progress bar moves
 * often enough to look alive on a slow connection.
 */
export const IMPORT_BATCH_SIZE = 100;

export type CitizenImportRequest = z.infer<typeof citizenImportSchema>;

/** One row's outcome, in the order the rows were sent. */
export interface CitizenImportRowResult {
  /** 1-based row number *in the file*, header excluded — what the clerk sees. */
  row: number;
  ok: boolean;
  name?: string;
  referenceNumber?: string;
  /** Arabic, already user-facing — the same message the form would have shown. */
  error?: string;
  /** Which column the error belongs to, when the failure names a field. */
  column?: string;
}

export interface CitizenImportResult {
  dryRun: boolean;
  created: number;
  failed: number;
  results: CitizenImportRowResult[];
}
