/**
 * The synthetic register the development seed writes: citizens, their filings,
 * the cards on those filings, supervisor reviews, field re-checks and the first
 * fee invoices. It is shaped like a municipality a few weeks into its census,
 * at several times the size production was when it was frozen on 2026-09-22
 * (305 citizens).
 *
 * Every filing is generated as the payload an officer's form sends, then put
 * through the checks the API applies before it becomes rows:
 * `adminCreateCitizenSubmissionSchema`, the cadastre flags, `statusForFlags`
 * and `PropertyEntry.create`. A rule change the generator no longer satisfies
 * fails the seed, and `seed-register.spec.ts` in CI, instead of seeding records
 * the app would refuse to save the first time someone edits them.
 *
 * Deliberately NOT generated:
 * - Map points. No card carries coordinates and no census building is
 *   created; the team places those through the app. Saving a seeded citizen
 *   later looks its parcel up and adds the dot, which is the app's own
 *   behaviour.
 * - Real people. Names come from common-name lists, every phone number starts
 *   77, and the SMS provider refuses to send anything in this codebase.
 *
 * Deterministic: the same tenant and count produce the same rows, ids and
 * reference numbers on every machine, so "citizen BZR-2609-… looks wrong" means
 * the same record to everyone. Each citizen draws from its own random stream,
 * so raising the count adds citizens without changing the existing ones.
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  adminCreateCitizenSubmissionSchema,
  cadastreFlags,
  statusForFlags,
  type FieldFlag,
} from '@mechanization/shared-schemas';
import { PropertyEntry } from '../domain/entities/property-entry.entity';
import { ReferenceNumber } from '../domain/value-objects/reference-number.vo';
import {
  identityDocumentOf,
  unestablishedOnCard,
} from '../application/features/registration/registration.service';
import { possibleDuplicateFlag } from '../application/features/citizens/possible-duplicates';

// ─────────────────────────────  Inputs  ─────────────────────────────

export interface SeedTenantProfile {
  slug: string;
  prefix: string;
  /** Keeps each municipality's phone numbers in their own range. */
  index: number;
  /** Which name lists and neighbourhoods read as local. */
  region: 'south' | 'bekaa';
  nameAr: string;
}

export interface SeedStaff {
  admin: string;
  auditor: string;
  officer: string;
  accountant: string;
  collector: string;
  /** Field inspectors, busiest first. */
  inspectors: readonly string[];
}

export interface SeedOptions {
  citizens: number;
  /** The municipality's cadastre. Empty when it has none. */
  parcels: readonly string[];
  staff: SeedStaff;
}

type Row = Record<string, unknown>;

export interface PlannedTransaction {
  id: string;
  paymentId: string;
  amount: number;
  method: 'CASH' | 'COLLECTOR' | 'WHISH_MONEY';
  externalRef: string | null;
  collectedById: string | null;
  recordedById: string | null;
  occurredAt: Date;
}

export interface Register {
  users: Row[];
  registrations: Row[];
  propertyEntries: Row[];
  buildingUnits: Row[];
  recordReviews: Row[];
  qualityChecks: Row[];
  systemSettings: Row;
  feeNotices: Row[];
  invoices: Row[];
  transactions: PlannedTransaction[];
}

// ─────────────────────────  Randomness, ids  ─────────────────────────

/** A seeded 32-bit generator (mulberry32). Same seed, same sequence, everywhere. */
export function randomSource(...seed: Array<string | number>): () => number {
  let state = createHash('sha256').update(seed.join('|')).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A UUID derived from its parts, so a re-run writes the same ids and skips what exists. */
export function seedId(...parts: Array<string | number>): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class Dice {
  constructor(private readonly next: () => number) {}

  /** In [0, 1). */
  float(): number {
    return this.next();
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** A whole number in [lo, hi], rounded to `step`. */
  step(lo: number, hi: number, step: number): number {
    return Math.max(step, Math.round(this.int(lo, hi) / step) * step);
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  weighted<T>(options: ReadonlyArray<readonly [T, number]>): T {
    const total = options.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of options) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return options[options.length - 1][0];
  }

  /** In [0, 1), leaning towards 1: the census ramps up, so later days are busier. */
  late(): number {
    return Math.sqrt(this.next());
  }

  randomInt = (max: number): number => Math.floor(this.next() * max);
}

// ──────────────────────────────  Names  ──────────────────────────────

const MALE_SOUTH = [
  'محمد', 'علي', 'حسن', 'حسين', 'أحمد', 'عباس', 'مهدي', 'جعفر', 'قاسم', 'خليل', 'إبراهيم',
  'يوسف', 'موسى', 'سامي', 'سمير', 'كمال', 'جمال', 'نبيل', 'وليد', 'رامي', 'هادي', 'فادي',
  'ربيع', 'زياد', 'بلال', 'حمزة', 'كاظم', 'رضا', 'باقر', 'صادق', 'مصطفى', 'محمود', 'عادل',
  'فؤاد', 'نزار', 'غسان', 'طلال', 'هيثم', 'مازن', 'ماهر', 'وسام', 'جهاد', 'رائد', 'عماد',
  'إيهاب', 'حيدر', 'علاء', 'ياسر', 'أيمن', 'نادر', 'سليمان', 'داود', 'يحيى', 'عبدالله',
  'توفيق', 'رفيق', 'منير', 'جواد', 'حسان', 'أكرم', 'عصام', 'نعيم', 'شادي', 'كريم', 'مروان',
  'سعيد', 'أنور', 'بسام', 'زين', 'مجتبى', 'مرتضى', 'حبيب',
] as const;

const FEMALE_SOUTH = [
  'فاطمة', 'زينب', 'مريم', 'خديجة', 'حوراء', 'زهراء', 'نور', 'هدى', 'سعاد', 'سميرة', 'ليلى',
  'رنا', 'رانيا', 'منى', 'سلمى', 'هالة', 'نادين', 'دعاء', 'إيمان', 'سناء', 'وفاء', 'رباب',
  'سهام', 'نجوى', 'أمل', 'رحاب', 'غادة', 'ريم', 'لينا', 'هبة', 'سارة', 'آمنة', 'رقية',
  'سكينة', 'نسرين', 'عبير', 'ميساء', 'هيفاء', 'جميلة', 'كوثر', 'نهى', 'إخلاص', 'حنان',
  'رولا', 'سوسن', 'ندى', 'وداد', 'باسمة', 'سمر', 'لمى', 'بتول', 'ملاك',
] as const;

const FAMILY_SOUTH = [
  'نصرالله', 'حمود', 'سرور', 'ضاهر', 'فقيه', 'بزي', 'شرف الدين', 'حيدر', 'عطوي', 'مغنية',
  'جابر', 'قاسم', 'سويدان', 'زين الدين', 'الحاج', 'صفا', 'ياسين', 'بدر الدين', 'مروة',
  'شعيتو', 'رمال', 'حجازي', 'عز الدين', 'فواز', 'طحيني', 'سلامة', 'بيضون', 'ترحيني',
  'عواضة', 'قبلان', 'حرب', 'سعد', 'دقدوق', 'مهدي', 'خليفة', 'شمس الدين', 'عيسى', 'نور الدين',
  'كوثراني', 'جواد', 'حمادة', 'فرحات', 'عاصي', 'غندور',
] as const;

const MALE_BEKAA = [
  'جورج', 'إيلي', 'طوني', 'شربل', 'جوزيف', 'ميشال', 'بيار', 'أنطوان', 'فادي', 'رامي', 'سامي',
  'نبيل', 'جان', 'إدوار', 'إميل', 'نقولا', 'إلياس', 'جوني', 'روجيه', 'كميل', 'فريد', 'سليم',
  'نعيم', 'وديع', 'منصور', 'خليل', 'جرجس', 'بطرس', 'حنا', 'عبدو', 'مارون', 'ريمون', 'غسان',
  'زياد', 'وليد', 'كريم', 'مروان', 'محمد', 'علي', 'حسن', 'أحمد', 'خالد', 'عمر',
] as const;

const FEMALE_BEKAA = [
  'ريتا', 'ماري', 'جوزفين', 'نادين', 'كارلا', 'ريما', 'ميرنا', 'ندى', 'هالة', 'لينا',
  'ليليان', 'كلود', 'جيهان', 'رولا', 'سهى', 'مايا', 'تيريز', 'روز', 'جورجيت', 'نهاد',
  'سعاد', 'لور', 'منى', 'سمر', 'غادة', 'فاطمة', 'زينب', 'مريم', 'هدى', 'رنا',
] as const;

const FAMILY_BEKAA = [
  'معلوف', 'سكاف', 'الهراوي', 'أبو خاطر', 'جريصاتي', 'عقل', 'طعمة', 'فتوش', 'زغيب', 'بريدي',
  'حداد', 'نصار', 'أبي نادر', 'خوري', 'رزق', 'شاهين', 'صليبا', 'عيد', 'عون', 'الغريب',
  'قزي', 'ضاهر', 'سابا', 'مطران', 'حبيقة', 'الترك', 'البعلبكي', 'الموسوي', 'دندش', 'زعيتر',
] as const;

const MALE_SYRIAN = [
  'أحمد', 'محمد', 'خالد', 'عمر', 'محمود', 'مصطفى', 'ياسر', 'عبد الرحمن', 'عبدالله', 'حسام',
  'فراس', 'ماهر', 'أنس', 'بلال', 'حمزة', 'يوسف', 'إبراهيم', 'سعيد', 'رياض', 'نضال',
] as const;

const FEMALE_SYRIAN = [
  'فاطمة', 'آمنة', 'هدى', 'رشا', 'ولاء', 'أسماء', 'نور', 'سلوى', 'رغد', 'بيان', 'هيام', 'عائشة',
] as const;

const FAMILY_SYRIAN = [
  'الأحمد', 'الحسين', 'العلي', 'المحمد', 'الخطيب', 'الحمصي', 'الحلبي', 'الشامي', 'الإدلبي',
  'الرفاعي', 'الزعبي', 'الحريري', 'الشيخ', 'العبدالله', 'الدرويش', 'الحسن', 'السيد',
] as const;

const FAMILY_PALESTINIAN = [
  'أبو علي', 'الشولي', 'عودة', 'الخطيب', 'حمدان', 'موعد', 'السعدي', 'قاسم', 'زيدان',
] as const;

const NEIGHBOURHOODS: Record<SeedTenantProfile['region'], readonly string[]> = {
  south: [
    'الحارة التحتا', 'الحارة الفوقا', 'حي البيادر', 'حي المدرسة', 'حي الجامع', 'الشارع العام',
    'حي البركة', 'طريق صور', 'حي العين', 'الكروم', 'حي الحسينية', 'الجبانة',
  ],
  bekaa: [
    'حوش الأمراء', 'البربارة', 'الميدان', 'المعلقة', 'كسارة', 'الراسية', 'مار الياس',
    'حوش الزراعنة', 'وادي العرايش', 'حي السيدة', 'الكرك', 'حي البيادر',
  ],
};

const RESIDENCE_PLACES = [
  'بيروت', 'الضاحية الجنوبية', 'صور', 'صيدا', 'النبطية', 'عرمون', 'ألمانيا', 'ساحل العاج',
  'السنغال', 'أستراليا', 'كندا', 'الولايات المتحدة', 'الكويت', 'الإمارات',
] as const;

const SIDES = ['شمالي', 'جنوبي', 'شرقي', 'غربي', 'يمين', 'يسار'] as const;

/** Folded the way possible-duplicates.ts folds before comparing. */
function fold(value: string): string {
  return value
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, '');
}

// ─────────────────────────────  Calendar  ─────────────────────────────

/** The census this pretends to be: filings from 8 to 25 September 2026. */
const FIRST_FILING_DAY = Date.UTC(2026, 8, 8);
const FILING_DAYS = 18;
/** The moment the seeded register is "as of". Reviews and payments stop here. */
export const SEED_NOW = new Date(Date.UTC(2026, 8, 26, 6, 0));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Office hours in Beirut (UTC+3), six days a week. */
function filingTime(d: Dice): Date {
  let day = Math.min(FILING_DAYS - 1, Math.floor(d.late() * FILING_DAYS));
  if (new Date(FIRST_FILING_DAY + day * DAY).getUTCDay() === 0) day = Math.max(0, day - 1);
  return new Date(FIRST_FILING_DAY + day * DAY + d.int(5, 14) * HOUR + d.int(0, 59) * 60_000);
}

function laterThan(d: Dice, from: Date, minHours: number, maxHours: number): Date | null {
  const at = new Date(from.getTime() + d.int(minHours * 60, maxHours * 60) * 60_000);
  return at.getTime() <= SEED_NOW.getTime() ? at : null;
}

// ─────────────────────────────  People  ─────────────────────────────

interface Person {
  index: number;
  firstName: string;
  middleName: string | null;
  lastName: string;
  motherName: string | null;
  gender: 'MALE' | 'FEMALE';
  phone: string;
  resident: boolean;
}

interface PersonDraft {
  residence: 'RESIDENT' | 'NON_RESIDENT_OWNER';
  personal: Record<string, unknown>;
  contact: Record<string, unknown>;
  residentStatus: 'VILLAGE_RESIDENT' | 'DISPLACED' | 'REFUGEE' | null;
  person: Person;
  flags: FieldFlag[];
}

/**
 * Local-format mobile numbers, 77 + one block digit + five digits. The block
 * keeps citizens, WhatsApp lines, landlords and local contacts apart, per
 * municipality, so no two roles ever share a number by accident.
 */
function phoneNumber(tenant: SeedTenantProfile, block: 1 | 2 | 3 | 4, n: number): string {
  return `77${block + tenant.index * 4}${String(n % 100_000).padStart(5, '0')}`;
}

const HOUSEHOLD_SIZE: ReadonlyArray<readonly [number, number]> = [
  [1, 7], [2, 12], [3, 15], [4, 20], [5, 18], [6, 12], [7, 8], [8, 5], [9, 3],
];

// ──────────────────────────────  Cards  ──────────────────────────────

interface CardDraft {
  card: Record<string, unknown>;
  /** Paths, relative to the card, this filing flags as never established. */
  unestablished: Array<{ field: string; reason: string }>;
}

interface OwnerOnFile {
  fullName: string;
  phone: string;
  parcel: string;
}

class ParcelBook {
  private readonly real: readonly string[];
  private readonly buildings: Array<{ parcel: string; name: string | null; units: number }> = [];
  readonly owners: OwnerOnFile[] = [];
  private landlordSerial = 0;

  constructor(parcels: readonly string[]) {
    this.real = parcels;
  }

  get hasCadastre(): boolean {
    return this.real.length > 0;
  }

  /** A parcel number: a real one where a cadastre exists, or 2% that are not in it. */
  number(d: Dice): string {
    if (!this.hasCadastre) return String(d.int(1, 2600));
    if (d.chance(0.02)) return String(this.real.length + d.int(5, 600));
    return d.pick(this.real);
  }

  /** An apartment building: most filings land in one that already has neighbours. */
  building(d: Dice, family: string): { parcel: string; name: string | null } {
    const open = this.buildings.filter((b) => b.units < 10);
    if (open.length > 0 && d.chance(0.65)) {
      const chosen = d.pick(open);
      chosen.units += 1;
      return chosen;
    }
    const created = {
      parcel: this.number(d),
      name: d.chance(0.6) ? `بناية ${family}` : null,
      units: 1,
    };
    this.buildings.push(created);
    return created;
  }

  landlordPhone(tenant: SeedTenantProfile): string {
    this.landlordSerial += 1;
    return phoneNumber(tenant, 3, this.landlordSerial);
  }
}

// ─────────────────────────────  Generator  ─────────────────────────────

interface Filed {
  citizenId: string;
  registrationId: string;
  registrationReference: string;
  person: Person;
  status: 'PENDING' | 'REQUIRES_REVIEW';
  flags: FieldFlag[];
  createdById: string;
  submittedAt: Date;
  updatedAt: Date;
}

/**
 * Generates the whole register for one municipality. Pure: no database, no
 * clock, no network. Throws if any generated filing fails the app's own
 * validation — the message names the filing and the rule.
 */
export function generateRegister(tenant: SeedTenantProfile, options: SeedOptions): Register {
  const book = new ParcelBook(options.parcels);
  const parcelSet = new Set(options.parcels);
  const usedNames = new Set<string>();
  const usedReferences = new Set<string>();
  const people: Person[] = [];
  const filed: Filed[] = [];

  const register: Register = {
    users: [],
    registrations: [],
    propertyEntries: [],
    buildingUnits: [],
    recordReviews: [],
    qualityChecks: [],
    systemSettings: systemSettingsFor(tenant),
    feeNotices: [],
    invoices: [],
    transactions: [],
  };

  const reference = (d: Dice, at: Date): string => {
    for (;;) {
      const value = ReferenceNumber.generate(tenant.prefix, at, d.randomInt).value;
      if (!usedReferences.has(value)) {
        usedReferences.add(value);
        return value;
      }
    }
  };

  const fieldStaff: ReadonlyArray<readonly [string, number]> = [
    ...options.staff.inspectors.map((id, i) => [id, [28, 20, 16, 10][i] ?? 8] as const),
    [options.staff.collector, 10],
    [options.staff.officer, 16],
  ];

  for (let index = 0; index < options.citizens; index += 1) {
    const d = new Dice(randomSource(tenant.slug, 'citizen', index));
    const citizenId = seedId(tenant.slug, 'citizen', index);
    const registrationId = seedId(tenant.slug, 'registration', index);
    const createdById = d.weighted(fieldStaff);
    const submittedAt = filingTime(d);

    // A second filing of someone already on the register, as the offline
    // queue produces it: same person, same phone, another officer, a few days
    // later — held with the possible-duplicate flag.
    const duplicateOf = index >= 200 && index % 331 === 200 ? filed[index - 57] : undefined;
    // The same person again with a hamza written differently, filed after the
    // officer asserted they were two people. Nothing holds it; the quality
    // screen's duplicate scan is what should catch it.
    const variantOf =
      index >= 300 && index % 457 === 300 ? spellingVariantOf(people[index - 91]) : undefined;

    const draft = duplicateOf
      ? repeatPerson(duplicateOf.person, index)
      : variantOf
        ? repeatPerson(variantOf, index)
        : drawPerson(d, tenant, index, usedNames);
    people.push(draft.person);

    const cards = drawCards(d, tenant, book, draft, index);
    const payload = {
      residence: draft.residence,
      personal: draft.personal,
      contact: draft.contact,
      properties: cards.map((c) => c.card),
      flags: [
        ...draft.flags,
        ...cards.flatMap((c, cardIndex) =>
          c.unestablished.map(({ field, reason }) => ({
            path: `properties.${cardIndex}.${field}`,
            reason,
            kind: 'UNESTABLISHED' as const,
          })),
        ),
      ],
      ...(variantOf ? { notes: 'أكّد الموظف أن صاحب هذا الملف شخص آخر يحمل الاسم نفسه.' } : {}),
      ...(d.chance(0.2) ? { clientSubmissionId: seedId(tenant.slug, 'client-submission', index) } : {}),
    };

    const parsed = adminCreateCitizenSubmissionSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `Generated filing #${index} (${tenant.slug}) fails the API's validation at ` +
          `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
    }
    const submission = parsed.data;

    // The same flags the registration service derives, in the same order.
    const missing = new Set(
      book.hasCadastre
        ? submission.properties
            .map((p) => p.propertyNumber?.trim())
            .filter((n): n is string => Boolean(n) && !parcelSet.has(n as string))
        : [],
    );
    const serverFlags: FieldFlag[] = duplicateOf
      ? [
          possibleDuplicateFlag([
            {
              fullName: fullNameOf(duplicateOf.person),
              referenceNumber: duplicateOf.registrationReference,
            } as never,
          ]),
        ]
      : [];
    const flags: FieldFlag[] = [
      ...submission.flags,
      ...cadastreFlags(submission.properties, missing, submission.flags),
      ...serverFlags,
    ];
    const status = statusForFlags(flags);

    let entries: PropertyEntry[];
    try {
      entries = submission.properties.map((card, cardIndex) =>
        PropertyEntry.create(
          { ...(card as Record<string, unknown>), latitude: null, longitude: null } as never,
          unestablishedOnCard(flags, cardIndex),
        ),
      );
    } catch (error) {
      throw new Error(
        `Generated filing #${index} (${tenant.slug}) fails PropertyEntry.create: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const citizenReference = reference(d, submittedAt);
    const registrationReference = reference(d, submittedAt);
    const personal = submission.personal as Record<string, unknown>;
    const contact = submission.contact as Record<string, unknown>;
    const identity = identityDocumentOf(submission as never);

    // A few records were corrected after filing; their last edit is later.
    const updatedAt = d.chance(0.12)
      ? (laterThan(d, submittedAt, 2, 96) ?? submittedAt)
      : submittedAt;

    register.users.push({
      id: citizenId,
      kind: 'CITIZEN',
      tenantSlug: tenant.slug,
      referenceNumber: citizenReference,
      phone: contact.phone ?? null,
      whatsapp: contact.whatsapp ?? contact.phone ?? null,
      firstName: personal.firstName,
      middleName: personal.middleName || null,
      lastName: personal.lastName,
      motherName: personal.motherName || null,
      gender: personal.gender ?? null,
      nationality: personal.nationality ?? null,
      isLebanese: personal.isLebanese ?? null,
      residencyNumber: personal.residencyNumber || null,
      residentStatus: personal.residentStatus ?? null,
      identityDocType: identity.identityDocNumber ? (identity.identityDocType ?? null) : null,
      identityDocNumber: identity.identityDocNumber ?? null,
      civilRecordNumber: personal.civilRecordNumber || null,
      totalRegisteredMembers: contact.totalRegisteredMembers ?? contact.actualHouseholdMembers ?? null,
      actualHouseholdMembers: contact.actualHouseholdMembers ?? null,
      maritalStatus: contact.maritalStatus ?? null,
      bloodType: personal.bloodType ?? null,
      residence: submission.residence,
      residencePlace: personal.residencePlace ?? null,
      localContactName: contact.localContactName || null,
      localContactPhone: contact.localContactPhone || null,
      createdAt: submittedAt,
      updatedAt,
    });

    register.registrations.push({
      id: registrationId,
      citizenId,
      referenceNumber: registrationReference,
      status,
      flaggedFields: flags,
      blanketFlagReason: null,
      notes: submission.notes ?? null,
      createdById,
      clientSubmissionId: submission.clientSubmissionId ?? null,
      submittedAt,
      updatedAt,
    });

    entries.forEach((entry, cardIndex) => {
      const p = entry.props;
      const entryId = seedId(tenant.slug, 'card', index, cardIndex);
      // Strictly increasing in card order: flag paths index cards by createdAt.
      const cardCreatedAt = new Date(submittedAt.getTime() + cardIndex * 10);
      register.propertyEntries.push({
        id: entryId,
        registrationId,
        occupancyType: p.occupancyType,
        landlordName: p.landlordName ?? null,
        landlordPhone: p.landlordPhone ?? null,
        propertyType: p.propertyType,
        neighborhood: p.neighborhood ?? null,
        propertyNumber: p.propertyNumber ?? null,
        unitType: p.unitType ?? null,
        landType: p.landType ?? null,
        buildingName: p.buildingName ?? null,
        floor: p.floor ?? null,
        side: p.side ?? null,
        tentLocation: p.tentLocation ?? null,
        unitArea: p.unitArea ?? null,
        shares: p.shares ?? null,
        sharedRights: p.sharedRights ?? [],
        unitStatus: p.unitStatus ?? null,
        // No map points: see the file header.
        latitude: null,
        longitude: null,
        buildingId: null,
        createdAt: cardCreatedAt,
        updatedAt,
      });
      (p.units ?? []).forEach((unit, unitIndex) => {
        register.buildingUnits.push({
          id: seedId(tenant.slug, 'unit', index, cardIndex, unitIndex),
          propertyEntryId: entryId,
          unitType: unit.unitType ?? null,
          floor: unit.floor ?? null,
          side: unit.side ?? null,
          unitArea: unit.unitArea ?? null,
          sharedRights: unit.sharedRights ?? [],
          unitStatus: unit.unitStatus ?? null,
          unitId: null,
          createdAt: new Date(cardCreatedAt.getTime() + unitIndex + 1),
          updatedAt,
        });
      });
    });

    // Owners become landlords that later tenants can name.
    submission.properties.forEach((p) => {
      if (
        p.occupancyType === 'OWNER' &&
        (p.propertyType === 'HOUSE' || p.propertyType === 'BUILDING') &&
        p.propertyNumber &&
        typeof contact.phone === 'string'
      ) {
        book.owners.push({
          fullName: `${personal.firstName as string} ${personal.lastName as string}`,
          phone: contact.phone,
          parcel: p.propertyNumber,
        });
      }
    });

    filed.push({
      citizenId,
      registrationId,
      registrationReference,
      person: { ...draft.person, phone: (contact.phone as string) ?? draft.person.phone },
      status,
      flags,
      createdById,
      submittedAt,
      updatedAt,
    });
  }

  addReviewsAndChecks(tenant, options.staff, filed, register);
  addBilling(tenant, options.staff, filed, register);
  return register;
}

function fullNameOf(person: Person): string {
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' ');
}

/** A hamza-less spelling of the first or last name, or nothing if neither has one. */
function spellingVariantOf(person: Person | undefined): Person | undefined {
  if (!person?.resident || !person.motherName) return undefined;
  const plain = (s: string): string => s.replace(/[أإآ]/g, 'ا');
  if (plain(person.firstName) !== person.firstName) {
    return { ...person, firstName: plain(person.firstName) };
  }
  if (plain(person.lastName) !== person.lastName) {
    return { ...person, lastName: plain(person.lastName) };
  }
  return undefined;
}

/** The personal and contact sections for someone already drawn once. */
function repeatPerson(person: Person, index: number): PersonDraft {
  return {
    residence: 'RESIDENT',
    residentStatus: 'VILLAGE_RESIDENT',
    person: { ...person, index },
    flags: [],
    personal: {
      firstName: person.firstName,
      middleName: person.middleName ?? '',
      lastName: person.lastName,
      motherName: person.motherName ?? '',
      gender: person.gender,
      isLebanese: true,
      nationality: 'لبناني',
      civilRecordNumber: String(100 + (index % 300)),
      residentStatus: 'VILLAGE_RESIDENT',
    },
    contact: {
      phone: person.phone.replace(/^\+961/, ''),
      whatsappSameAsPhone: true,
      maritalStatus: 'MARRIED',
      actualHouseholdMembers: 4,
      totalRegisteredMembers: 4,
    },
  };
}

function drawPerson(
  d: Dice,
  tenant: SeedTenantProfile,
  index: number,
  usedNames: Set<string>,
): PersonDraft {
  const phone = phoneNumber(tenant, 1, index + 1);
  const flags: FieldFlag[] = [];

  // ── Owners who live elsewhere: a short file, no mother's name (§ non-resident) ──
  if (d.chance(0.07)) {
    const { firstName, middleName, lastName } = uniqueName(d, tenant, 'MALE', false, usedNames, d.chance(0.5));
    const localContact = d.chance(0.6);
    return {
      residence: 'NON_RESIDENT_OWNER',
      residentStatus: null,
      flags,
      person: { index, firstName, middleName, lastName, motherName: null, gender: 'MALE', phone, resident: false },
      personal: {
        firstName,
        middleName: middleName ?? '',
        lastName,
        residencePlace: d.pick(RESIDENCE_PLACES),
      },
      contact: {
        phone,
        whatsappSameAsPhone: true,
        ...(localContact
          ? {
              localContactName: `${d.pick(namesFor(tenant, 'MALE', false).first)} ${lastName}`,
              ...(d.chance(0.7) ? { localContactPhone: phoneNumber(tenant, 4, index + 1) } : {}),
            }
          : {}),
      },
    };
  }

  // ── Residents ──
  const residentStatus = d.weighted<'VILLAGE_RESIDENT' | 'DISPLACED' | 'REFUGEE'>(
    tenant.region === 'south'
      ? [['VILLAGE_RESIDENT', 74], ['DISPLACED', 17], ['REFUGEE', 9]]
      : [['VILLAGE_RESIDENT', 70], ['DISPLACED', 10], ['REFUGEE', 20]],
  );
  const isLebanese = residentStatus !== 'REFUGEE' && d.chance(0.96);
  const foreign = !isLebanese;
  const palestinian = residentStatus === 'REFUGEE' && d.chance(0.15);
  const nationality = isLebanese
    ? 'لبناني'
    : palestinian
      ? 'فلسطيني'
      : residentStatus === 'REFUGEE'
        ? 'سوري'
        : d.weighted([['سوري', 7], ['مصري', 2], ['سوداني', 1]]);

  const gender: 'MALE' | 'FEMALE' = d.chance(0.78) ? 'MALE' : 'FEMALE';
  const { firstName, middleName, lastName } = uniqueName(d, tenant, gender, foreign, usedNames, true, palestinian);
  const mothers = namesFor(tenant, 'FEMALE', foreign, palestinian);
  const motherKnown = !d.chance(0.025);
  const motherName = motherKnown
    ? `${d.pick(mothers.first)} ${d.chance(0.35) ? lastName : d.pick(mothers.family)}`
    : null;
  if (!motherKnown) {
    flags.push({
      path: 'personal.motherName',
      kind: 'UNESTABLISHED',
      reason: d.pick([
        'الوالدة متوفاة ولم يُعرف اسمها الكامل.',
        'لم يتذكر صاحب العلاقة اسم الوالدة الكامل.',
        'يُستكمل اسم الوالدة من إخراج القيد في زيارة لاحقة.',
      ]),
    });
  }

  let civilRecordNumber = '';
  if (isLebanese) {
    if (d.chance(0.015)) {
      flags.push({
        path: 'personal.civilRecordNumber',
        kind: 'UNESTABLISHED',
        reason: 'لم يحضر إخراج القيد — يُستكمل رقم السجل لاحقاً.',
      });
    } else {
      civilRecordNumber = String(d.int(1, 450));
      // Officers type Arabic-Indic digits often enough that the register holds both.
      if (d.chance(0.06)) {
        civilRecordNumber = civilRecordNumber.replace(/\d/g, (c) => '٠١٢٣٤٥٦٧٨٩'[Number(c)]);
      }
    }
  }

  const maritalStatus =
    gender === 'FEMALE'
      ? d.weighted([['WIDOWED', 35], ['MARRIED', 45], ['DIVORCED', 10], ['SINGLE', 10]])
      : d.weighted([['MARRIED', 82], ['SINGLE', 12], ['DIVORCED', 3], ['WIDOWED', 3]]);
  const actual = d.weighted(HOUSEHOLD_SIZE) + (residentStatus === 'REFUGEE' ? 1 : 0);
  const total = actual + (d.chance(0.3) ? d.int(1, 3) : 0);
  const separateWhatsapp = d.chance(0.2);

  return {
    residence: 'RESIDENT',
    residentStatus,
    flags,
    person: { index, firstName, middleName, lastName, motherName, gender, phone, resident: true },
    personal: {
      firstName,
      middleName: middleName ?? '',
      lastName,
      ...(motherName ? { motherName } : {}),
      gender,
      ...(d.chance(0.45)
        ? {
            bloodType: d.weighted([
              ['O_POSITIVE', 38], ['A_POSITIVE', 32], ['B_POSITIVE', 12], ['AB_POSITIVE', 5],
              ['O_NEGATIVE', 6], ['A_NEGATIVE', 4], ['B_NEGATIVE', 2], ['AB_NEGATIVE', 1],
            ]),
          }
        : {}),
      isLebanese,
      nationality,
      civilRecordNumber,
      residentStatus,
      ...(foreign && d.chance(0.55)
        ? { identityDocType: 'PASSPORT', identityDocNumber: `N${String(tenant.index * 1_000_000 + index).padStart(7, '0')}` }
        : {}),
      ...(foreign && d.chance(0.35) ? { residencyNumber: String(d.int(100_000, 9_999_999)) } : {}),
    },
    contact: {
      phone,
      whatsappSameAsPhone: !separateWhatsapp,
      ...(separateWhatsapp ? { whatsapp: phoneNumber(tenant, 2, index + 1) } : {}),
      maritalStatus,
      actualHouseholdMembers: actual,
      totalRegisteredMembers: total,
    },
  };
}

function namesFor(
  tenant: SeedTenantProfile,
  gender: 'MALE' | 'FEMALE',
  foreign: boolean,
  palestinian = false,
): { first: readonly string[]; family: readonly string[] } {
  if (foreign) {
    return {
      first: gender === 'MALE' ? MALE_SYRIAN : FEMALE_SYRIAN,
      family: palestinian ? FAMILY_PALESTINIAN : FAMILY_SYRIAN,
    };
  }
  return tenant.region === 'south'
    ? { first: gender === 'MALE' ? MALE_SOUTH : FEMALE_SOUTH, family: FAMILY_SOUTH }
    : { first: gender === 'MALE' ? MALE_BEKAA : FEMALE_BEKAA, family: FAMILY_BEKAA };
}

/**
 * A first/father/family name no one else on this register has. Keeping full
 * names distinct is what keeps the duplicate scan quiet for everyone except the
 * cases seeded on purpose.
 */
function uniqueName(
  d: Dice,
  tenant: SeedTenantProfile,
  gender: 'MALE' | 'FEMALE',
  foreign: boolean,
  used: Set<string>,
  withMiddle: boolean,
  palestinian = false,
): { firstName: string; middleName: string | null; lastName: string } {
  const own = namesFor(tenant, gender, foreign, palestinian);
  const fathers = namesFor(tenant, 'MALE', foreign, palestinian).first;
  for (let attempt = 0; ; attempt += 1) {
    const firstName = d.pick(own.first);
    const middleName = withMiddle ? d.pick(fathers) : null;
    const lastName = d.pick(own.family);
    const key = `${fold(firstName)}|${fold(middleName ?? '')}|${fold(lastName)}`;
    if (!used.has(key) || attempt > 50) {
      used.add(key);
      return { firstName, middleName, lastName };
    }
  }
}

function drawCards(
  d: Dice,
  tenant: SeedTenantProfile,
  book: ParcelBook,
  draft: PersonDraft,
  index: number,
): CardDraft[] {
  const family = draft.person.lastName;
  const neighborhood = (): Record<string, unknown> =>
    d.chance(0.85) ? { neighborhood: d.pick(NEIGHBOURHOODS[tenant.region]) } : {};
  const ownPhone = draft.person.phone;

  const landlordFor = (parcel: string, phoneOptional: boolean): Record<string, unknown> => {
    // A family member who owns the flat and shares the tenant's line.
    if (index % 409 === 100) return { landlordName: `${d.pick(namesFor(tenant, 'MALE', false).first)} ${family}`, landlordPhone: ownPhone };
    const onFile = book.owners.filter((o) => o.parcel === parcel && o.phone !== `+961${ownPhone}`);
    if (onFile.length > 0 && d.chance(0.7)) {
      const owner = d.pick(onFile);
      return { landlordName: owner.fullName, landlordPhone: owner.phone };
    }
    if (book.owners.length > 0 && d.chance(0.2)) {
      const owner = d.pick(book.owners);
      if (owner.phone !== `+961${ownPhone}`) return { landlordName: owner.fullName, landlordPhone: owner.phone };
    }
    const name = `${d.pick(namesFor(tenant, 'MALE', false).first)} ${d.pick(namesFor(tenant, 'MALE', false).family)}`;
    return phoneOptional && d.chance(0.4)
      ? { landlordName: name }
      : { landlordName: name, landlordPhone: book.landlordPhone(tenant) };
  };

  const apartment = (occupancy: 'OWNER' | 'TENANT' | 'FREE_OCCUPANT', count: number): CardDraft => {
    const building = book.building(d, family);
    const floors = new Set<string>();
    const units = Array.from({ length: count }, (_, u) => {
      let floor = String(d.int(0, 6));
      while (floors.has(floor)) floor = String(Number(floor) + 1);
      floors.add(floor);
      return {
        unitType: 'APARTMENT',
        floor: d.chance(0.08) && floor === '0' ? 'أرضي' : floor,
        ...(d.chance(0.3) ? { side: d.pick(SIDES) } : {}),
        unitArea: d.step(80, 220, 5),
        ...(occupancy === 'OWNER' && d.chance(0.55)
          ? {
              unitStatus:
                u === 0 && draft.residence === 'RESIDENT'
                  ? 'OWNER_OCCUPIED'
                  : d.weighted([['RENTED', 5], ['VACANT', 3], ['FREE_OCCUPIED', 1], ['UNDER_CONSTRUCTION', 1]]),
            }
          : {}),
      };
    });
    return {
      unestablished: [],
      card: {
        occupancyType: occupancy,
        propertyType: 'BUILDING',
        propertyNumber: building.parcel,
        ...neighborhood(),
        ...(building.name ? { buildingName: building.name } : {}),
        units,
        ...(occupancy === 'OWNER' ? {} : landlordFor(building.parcel, occupancy === 'FREE_OCCUPANT')),
      },
    };
  };

  const house = (occupancy: 'OWNER' | 'TENANT' | 'FREE_OCCUPANT', ownerStatus?: string): CardDraft => {
    const parcel = book.number(d);
    const areaUnknown = d.chance(0.01);
    return {
      unestablished: areaUnknown
        ? [{ field: 'unitArea', reason: 'لم يُقَس المنزل بعد — تُستكمل المساحة في زيارة لاحقة.' }]
        : [],
      card: {
        occupancyType: occupancy,
        propertyType: 'HOUSE',
        propertyNumber: parcel,
        ...neighborhood(),
        ...(areaUnknown ? {} : { unitArea: d.step(90, 320, 5) }),
        ...(d.chance(0.2) ? { side: d.pick(SIDES) } : {}),
        ...(d.chance(0.15) ? { buildingName: `منزل ${family}` } : {}),
        ...(d.chance(0.05) ? { sharedRights: [d.pick(['حق مرور', 'بئر مشترك', 'سطح مشترك'])] } : {}),
        ...(occupancy === 'OWNER' && ownerStatus ? { unitStatus: ownerStatus } : {}),
        ...(occupancy === 'OWNER' ? {} : landlordFor(parcel, occupancy === 'FREE_OCCUPANT')),
      },
    };
  };

  const land = (occupancy: 'OWNER' | 'TENANT' | 'FREE_OCCUPANT'): CardDraft => {
    const parcel = book.number(d);
    return {
      unestablished: [],
      card: {
        occupancyType: occupancy,
        propertyType: 'LAND',
        propertyNumber: parcel,
        ...neighborhood(),
        landType: d.chance(0.9) ? 'AGRICULTURAL' : 'INDUSTRIAL',
        unitArea: d.step(300, 25_000, 50),
        ...(occupancy === 'OWNER'
          ? { shares: d.weighted([[2400, 5], [1200, 2], [800, 1], [600, 1], [400, 1]]) }
          : landlordFor(parcel, occupancy === 'FREE_OCCUPANT')),
      },
    };
  };

  const business = (occupancy: 'OWNER' | 'TENANT' | 'FREE_OCCUPANT'): CardDraft => {
    const building = book.building(d, family);
    const unitType = d.weighted([['SHOP', 6], ['OFFICE', 2], ['WAREHOUSE', 2], ['CLINIC', 1], ['GARAGE', 1]]);
    const area: Record<string, [number, number]> = {
      SHOP: [18, 90], OFFICE: [30, 140], WAREHOUSE: [60, 400], CLINIC: [35, 95], GARAGE: [18, 45],
    };
    return {
      unestablished: [],
      card: {
        occupancyType: occupancy,
        propertyType: 'BUILDING',
        propertyNumber: building.parcel,
        ...neighborhood(),
        ...(building.name ? { buildingName: building.name } : {}),
        units: [
          {
            unitType,
            floor: '0',
            unitArea: d.step(area[unitType][0], area[unitType][1], 1),
            ...(occupancy === 'OWNER' && d.chance(0.5)
              ? { unitStatus: d.weighted([['OWNER_OCCUPIED', 4], ['RENTED', 4], ['VACANT', 2]]) }
              : {}),
          },
        ],
        ...(occupancy === 'OWNER' ? {} : landlordFor(building.parcel, occupancy === 'FREE_OCCUPANT')),
      },
    };
  };

  const tent = (occupancy: 'OWNER' | 'TENANT'): CardDraft => {
    const parcel = book.number(d);
    return {
      unestablished: [],
      card: {
        occupancyType: occupancy,
        propertyType: 'TENT',
        propertyNumber: parcel,
        ...neighborhood(),
        tentLocation: d.pick([
          `تجمّع خيم قرب ${d.pick(NEIGHBOURHOODS[tenant.region])} — قطاع ${d.pick(['أ', 'ب', 'ج', 'د'])}`,
          `أرض آل ${d.pick(namesFor(tenant, 'MALE', false).family)} — خيمة رقم ${d.int(1, 80)}`,
          `مخيم عشوائي على طريق ${d.pick(NEIGHBOURHOODS[tenant.region])}`,
        ]),
        ...(occupancy === 'OWNER' ? {} : landlordFor(parcel, false)),
      },
    };
  };

  const cards: CardDraft[] = [];

  // Options are thunks: only the chosen card may draw numbers or claim a flat
  // in a building, or the unchosen ones would shift everything after them.
  type Option = readonly [() => CardDraft, number];
  const choose = (options: readonly Option[]): CardDraft => d.weighted(options)();

  if (draft.residence === 'NON_RESIDENT_OWNER') {
    // An owner who lives elsewhere never "occupies" what they own, and may
    // only hold land or non-dwelling units as a tenant (admin-citizen.schema).
    cards.push(
      choose([
        [() => house('OWNER', d.pick(['SEASONAL', 'VACANT', 'RENTED'])), 4],
        [() => land('OWNER'), 3],
        [() => business('TENANT'), 1],
      ]),
    );
    if (d.chance(0.35)) cards.push(land('OWNER'));
  } else {
    switch (draft.residentStatus) {
      case 'REFUGEE':
        cards.push(
          choose([
            [() => tent('OWNER'), 35],
            [() => tent('TENANT'), 15],
            [() => apartment('TENANT', 1), 35],
            [() => house('TENANT'), 15],
          ]),
        );
        break;
      case 'DISPLACED':
        cards.push(
          choose([
            [() => apartment('TENANT', 1), 40],
            [() => house('TENANT'), 20],
            [() => house('FREE_OCCUPANT'), 30],
            [() => apartment('FREE_OCCUPANT', 1), 10],
          ]),
        );
        break;
      default:
        cards.push(
          choose([
            [() => house('OWNER', d.chance(0.7) ? 'OWNER_OCCUPIED' : undefined), 50],
            [() => apartment('OWNER', d.chance(0.6) ? 1 : d.int(2, 4)), 20],
            [() => apartment('TENANT', 1), 15],
            [() => house('TENANT'), 7],
            [() => house('FREE_OCCUPANT'), 8],
          ]),
        );
    }
    if (draft.residentStatus === 'VILLAGE_RESIDENT' && d.chance(0.22)) cards.push(land('OWNER'));
    if (draft.residentStatus === 'VILLAGE_RESIDENT' && d.chance(0.08)) cards.push(business('OWNER'));
    if (d.chance(0.04)) cards.push(business('TENANT'));
  }

  // The family-landlord case in landlordFor needs a card that has a landlord.
  if (index % 409 === 100 && cards.every((c) => c.card.occupancyType === 'OWNER')) {
    cards.push(draft.residence === 'RESIDENT' ? apartment('TENANT', 1) : business('TENANT'));
  }

  // A number the owner does not know yet, on 2% of first cards.
  if (d.chance(0.02)) {
    const first = cards[0];
    delete first.card.propertyNumber;
    first.unestablished.push({
      field: 'propertyNumber',
      reason: 'لا يعرف صاحب العلاقة رقم العقار — يُستكمل من الدوائر العقارية.',
    });
  }

  return cards;
}

// ─────────────────────  Reviews and field re-checks  ─────────────────────

const RETURN_REASONS: Record<string, string> = {
  MOTHER_NAME: 'اسم الوالدة ناقص — يرجى استكماله من إخراج القيد.',
  PHONE: 'رقم الهاتف لا يجيب — يرجى التأكد منه مع صاحب العلاقة.',
  HOUSEHOLD: 'عدد أفراد الأسرة لا يطابق ما ورد في الزيارة الميدانية.',
  PROPERTY: 'رقم العقار غير مؤكَّد — يرجى مطابقته مع سند الملكية.',
  AREA: 'المساحة المدخلة تبدو غير منطقية — يرجى إعادة القياس.',
  OCCUPANCY_ROLE: 'صفة الإشغال غير واضحة — مالك أم مستأجر؟',
  LANDLORD: 'بيانات المالك ناقصة — يرجى إضافة رقم هاتفه.',
  DUPLICATE: 'يبدو أن هذا الشخص مسجَّل مسبقاً — يرجى التحقق.',
  OTHER: 'يرجى مراجعة الملف واستكمال البيانات الناقصة.',
};

function returnFieldsFor(flags: readonly FieldFlag[], d: Dice): string[] {
  const fromFlags = new Set<string>();
  for (const flag of flags) {
    if (flag.path === 'personal.motherName') fromFlags.add('MOTHER_NAME');
    else if (flag.path === 'personal.possibleDuplicate') fromFlags.add('DUPLICATE');
    else if (flag.path.endsWith('.propertyNumber')) fromFlags.add('PROPERTY');
    else if (flag.path.endsWith('.unitArea')) fromFlags.add('AREA');
    else fromFlags.add('OTHER');
  }
  if (fromFlags.size > 0) return [...fromFlags];
  return [d.pick(['PHONE', 'HOUSEHOLD', 'AREA', 'OCCUPANCY_ROLE', 'LANDLORD', 'OTHER'])];
}

function addReviewsAndChecks(
  tenant: SeedTenantProfile,
  staff: SeedStaff,
  filed: readonly Filed[],
  register: Register,
): void {
  const reviewers: ReadonlyArray<readonly [string, number]> = [
    [staff.auditor, 55],
    [staff.officer, 35],
    [staff.admin, 10],
  ];
  const checkers = [...staff.inspectors];

  filed.forEach((f, regIndex) => {
    const d = new Dice(randomSource(tenant.slug, 'review', f.citizenId));
    // Nobody reviews their own filing (record-review.service).
    let reviewer = d.weighted(reviewers);
    if (reviewer === f.createdById) reviewer = staff.auditor;

    const outcome =
      f.status === 'REQUIRES_REVIEW'
        ? d.weighted<'RETURNED' | 'APPROVED' | 'NONE'>([['RETURNED', 35], ['APPROVED', 15], ['NONE', 50]])
        : d.weighted<'APPROVED' | 'RETURNED' | 'CORRECTED' | 'NONE'>([
            ['APPROVED', 58], ['RETURNED', 4], ['CORRECTED', 5], ['NONE', 33],
          ]);

    let approvedAt: Date | null = null;

    if (outcome === 'RETURNED' || outcome === 'CORRECTED') {
      const returnedAt = laterThan(d, f.updatedAt, 2, 72);
      if (!returnedAt) return;
      const fields = returnFieldsFor(f.flags, d);
      const corrected = outcome === 'CORRECTED' ? laterThan(d, returnedAt, 4, 48) : null;
      register.recordReviews.push({
        id: seedId(tenant.slug, 'review-return', f.registrationId),
        registrationId: f.registrationId,
        outcome: 'RETURNED',
        reason: RETURN_REASONS[fields[0]] ?? RETURN_REASONS.OTHER,
        fields,
        reviewedById: reviewer,
        resolvedAt: corrected,
        resolvedById: corrected ? f.createdById : null,
        createdAt: returnedAt,
      });
      if (corrected) {
        // The correction is an edit: the filing's updatedAt moves with it, and
        // the approval comes after it, or the record would read as CHANGED.
        register.registrations[regIndex].updatedAt = corrected;
        register.users[regIndex].updatedAt = corrected;
        approvedAt = laterThan(d, corrected, 2, 48);
      }
    } else if (outcome === 'APPROVED') {
      approvedAt = laterThan(d, f.updatedAt, 2, 72);
    }

    if (approvedAt) {
      register.recordReviews.push({
        id: seedId(tenant.slug, 'review-approve', f.registrationId),
        registrationId: f.registrationId,
        outcome: 'APPROVED',
        reason: null,
        fields: [],
        reviewedById: reviewer,
        resolvedAt: null,
        resolvedById: null,
        createdAt: approvedAt,
      });

      // A sample of approved filings is re-checked on the ground by another
      // officer (record-review.service: never the one who filed it).
      if (d.chance(0.08)) {
        const sampledAt = laterThan(d, approvedAt, 1, 24);
        if (!sampledAt) return;
        const others = checkers.filter((id) => id !== f.createdById);
        const assignee = d.pick(others.length > 0 ? others : checkers);
        const checkedAt = d.chance(0.6) ? laterThan(d, sampledAt, 4, 48) : null;
        const differs = checkedAt !== null && d.chance(0.25);
        register.qualityChecks.push({
          id: seedId(tenant.slug, 'quality-check', f.registrationId),
          registrationId: f.registrationId,
          originalOfficerId: f.createdById,
          sampledById: staff.auditor,
          assignedToId: assignee,
          status: checkedAt ? 'DONE' : 'OPEN',
          result: checkedAt ? (differs ? 'DIFFERS' : 'MATCHES') : null,
          differences: differs ? [d.pick(['HOUSEHOLD', 'PHONE', 'AREA', 'OCCUPANCY_ROLE', 'PERSON_NOT_THERE'])] : [],
          notes: differs ? 'وُجد اختلاف أثناء الزيارة الميدانية — تمت الإشارة إليه للمراجعة.' : null,
          checkedById: checkedAt ? assignee : null,
          checkedAt,
          createdAt: sampledAt,
          updatedAt: checkedAt ?? sampledAt,
        });
      }
    }
  });
}

// ───────────────────────────────  Billing  ───────────────────────────────

function systemSettingsFor(tenant: SeedTenantProfile): Row {
  const south = tenant.region === 'south';
  return {
    id: seedId(tenant.slug, 'system-settings'),
    singleton: true,
    nameAr: `بلدية ${tenant.nameAr}`,
    governorate: south ? 'الجنوب' : 'البقاع',
    district: south ? 'صور' : 'زحلة',
    town: tenant.nameAr,
    cashOfficeHours: 'من الإثنين إلى الجمعة، 8:00 – 14:00',
    cashOfficeAddress: 'مبنى البلدية — الطابق الأرضي',
    baseCurrency: 'LBP',
    secondaryCurrency: 'USD',
    exchangeRate: 89_500,
    exchangeRateUpdatedAt: new Date(Date.UTC(2026, 8, 1)),
    defaultFeeFrequency: 'ANNUALLY',
    defaultDueDays: 30,
    priceDisplay: 'compact',
    updatedAt: new Date(Date.UTC(2026, 8, 1)),
  };
}

/**
 * Two flat charges on everyone, issued part-way through the census, the way
 * `FeesService.issue` writes them: one invoice per citizen on file at issue,
 * periodKey from the frequency, and a FLAT assessment. Payments go through
 * the ledger's rules: a transaction per movement, `paidAmount` as their sum,
 * PAID only when fully covered. OVERDUE is never stored — the app derives it
 * from UNPAID and a past due date.
 */
function addBilling(
  tenant: SeedTenantProfile,
  staff: SeedStaff,
  filed: readonly Filed[],
  register: Register,
): void {
  const scale = tenant.region === 'south' ? 1 : 2;
  const notices = [
    {
      id: seedId(tenant.slug, 'notice', 'cleaning-2026'),
      title: 'رسم النظافة وجمع النفايات لعام 2026',
      amount: 1_800_000 * scale,
      frequency: 'ANNUALLY',
      periodKey: '2026',
      // Past due by SEED_NOW, so the unpaid ones read as OVERDUE.
      dueDate: new Date(Date.UTC(2026, 8, 24)),
      createdAt: new Date(Date.UTC(2026, 8, 14, 7)),
      paidShare: 0.45,
      pendingShare: 0.04,
      partialShare: 0.02,
    },
    {
      id: seedId(tenant.slug, 'notice', 'sewage-2026'),
      title: 'رسم صيانة شبكة الصرف الصحي',
      amount: 900_000 * scale,
      frequency: 'ONCE',
      periodKey: 'ONCE',
      dueDate: new Date(Date.UTC(2026, 11, 31)),
      createdAt: new Date(Date.UTC(2026, 8, 22, 7)),
      paidShare: 0.12,
      pendingShare: 0.01,
      partialShare: 0,
    },
  ];

  for (const notice of notices) {
    register.feeNotices.push({
      id: notice.id,
      title: notice.title,
      amount: notice.amount,
      currency: 'LBP',
      frequency: notice.frequency,
      targetType: 'ALL_CITIZENS',
      dueDate: notice.dueDate,
      instructions: 'يُدفع في صندوق البلدية نقداً، أو لدى الجابي، أو عبر ويش موني.',
      issuedById: staff.accountant,
      createdAt: notice.createdAt,
      isActive: true,
      basis: 'FLAT',
      bearer: 'OCCUPANT',
    });

    for (const f of filed) {
      // Issuing tops up whoever is on file, so someone registered after the
      // notice gets their invoice when they are registered.
      const issuedAt = new Date(Math.max(notice.createdAt.getTime(), f.submittedAt.getTime() + HOUR));
      if (issuedAt.getTime() > SEED_NOW.getTime()) continue;
      const d = new Dice(randomSource(tenant.slug, 'invoice', notice.id, f.citizenId));
      const invoiceId = seedId(tenant.slug, 'invoice', notice.id, f.citizenId);
      const outcome = d.weighted<'PAID' | 'PENDING' | 'PARTIAL' | 'UNPAID'>([
        ['PAID', notice.paidShare],
        ['PENDING', notice.pendingShare],
        ['PARTIAL', notice.partialShare],
        ['UNPAID', 1 - notice.paidShare - notice.pendingShare - notice.partialShare],
      ]);

      const invoice: Row = {
        id: invoiceId,
        citizenId: f.citizenId,
        feeNoticeId: notice.id,
        title: notice.title,
        amount: notice.amount,
        currency: 'LBP',
        dueDate: notice.dueDate,
        paymentStatus: 'UNPAID',
        paymentMethod: null,
        whishTransactionRef: null,
        paidAt: null,
        paidAmount: 0,
        collectedById: null,
        isSeen: false,
        assessment: {
          basis: 'FLAT',
          rate: notice.amount,
          unitCount: 0,
          totalArea: 0,
          excludedUnitCount: 0,
          lines: [],
        },
        periodKey: notice.periodKey,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      };

      if (outcome === 'PENDING') {
        // A citizen declared a Whish payment; the clerk has not confirmed it.
        const declaredAt = laterThan(d, issuedAt, 2, 24 * 10);
        if (declaredAt) {
          Object.assign(invoice, {
            paymentStatus: 'PENDING_REVIEW',
            paymentMethod: 'WHISH_MONEY',
            whishTransactionRef: `WM${d.int(10_000_000, 99_999_999)}`,
            updatedAt: declaredAt,
          });
        }
      } else if (outcome === 'PAID' || outcome === 'PARTIAL') {
        const occurredAt = laterThan(d, issuedAt, 2, 24 * 12);
        if (occurredAt) {
          const method = d.weighted<'CASH' | 'COLLECTOR' | 'WHISH_MONEY'>([
            ['CASH', 50], ['COLLECTOR', 35], ['WHISH_MONEY', 15],
          ]);
          const amount = outcome === 'PAID' ? notice.amount : notice.amount / 2;
          const externalRef = method === 'WHISH_MONEY' ? `WM${d.int(10_000_000, 99_999_999)}` : null;
          const collectedById = method === 'COLLECTOR' ? staff.collector : null;
          register.transactions.push({
            id: seedId(tenant.slug, 'transaction', invoiceId),
            paymentId: invoiceId,
            amount,
            method,
            externalRef,
            collectedById,
            recordedById: method === 'COLLECTOR' ? staff.collector : staff.accountant,
            occurredAt,
          });
          Object.assign(invoice, {
            paidAmount: amount,
            paymentStatus: outcome === 'PAID' ? 'PAID' : 'UNPAID',
            paidAt: outcome === 'PAID' ? occurredAt : null,
            paymentMethod: method,
            whishTransactionRef: externalRef,
            collectedById,
            updatedAt: occurredAt,
          });
        }
      }

      register.invoices.push(invoice);
    }
  }
}
