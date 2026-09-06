import type {
  BloodType,
  DocumentType,
  Gender,
  IdentityDocType,
  LandType,
  MaritalStatus,
  OccupancyType,
  PropertyType,
  ResidentStatus,
  StaffRole,
  UnitStatus,
  UnitType,
} from './enums';
import type { FeeBasis, FeeBearer, FeeTargetCategory } from './fee.schema';

/** Arabic display labels. Keep UI copy here, not inside the schemas. */
export const ar = {
  gender: { MALE: 'ذكر', FEMALE: 'أنثى' } satisfies Record<Gender, string>,

  bloodType: {
    A_POSITIVE: 'A+',
    A_NEGATIVE: 'A-',
    B_POSITIVE: 'B+',
    B_NEGATIVE: 'B-',
    AB_POSITIVE: 'AB+',
    AB_NEGATIVE: 'AB-',
    O_POSITIVE: 'O+',
    O_NEGATIVE: 'O-',
  } satisfies Record<BloodType, string>,

  /** How often a fee recurs. */
  feeFrequency: {
    ONCE: 'مرة واحدة',
    MONTHLY: 'شهري',
    HALF_YEARLY: 'نصف سنوي',
    ANNUALLY: 'سنوي',
  },

  /** Who a fee is issued to. */
  feeTargetType: {
    ALL_CITIZENS: 'جميع المواطنين',
    BUILDING_CATEGORY: 'فئة عقارية',
    INDIVIDUAL_CITIZEN: 'مواطن محدّد',
  },

  /** The property categories a fee may target, in the registry's own terms. */
  feeTargetCategory: {
    BUILDING: 'مبانٍ',
    HOUSE: 'منازل',
    LAND: 'أراضٍ',
    TENT: 'خيم',
    APARTMENT: 'شقق سكنية',
    INDEPENDENT_HOUSE: 'منازل مستقلة',
    CLINIC: 'عيادات',
    OFFICE: 'مكاتب',
    SHOP: 'محلات تجارية',
    WAREHOUSE: 'مستودعات',
  } satisfies Record<FeeTargetCategory, string>,

  /** What the notice's amount is multiplied by. See `FEE_BASIS`. */
  feeBasis: {
    FLAT: 'مبلغ ثابت لكل مواطن',
    PER_UNIT: 'المبلغ × عدد الوحدات',
    PER_AREA: 'المبلغ × إجمالي المساحة (م²)',
  } satisfies Record<FeeBasis, string>,

  /** Who the fee is levied on. See `FEE_BEARER`. */
  feeBearer: {
    OCCUPANT: 'الشاغل',
    OWNER: 'المالك',
  } satisfies Record<FeeBearer, string>,

  /**
   * The one line that says what choosing a bearer actually does.
   *
   * Kept beside the label rather than inlined in the dialog because it is the
   * sentence a clerk reads before changing what a few hundred residents owe,
   * and it should read identically wherever that choice is offered.
   */
  feeBearerHint: {
    OCCUPANT:
      'يُحتسب على من يشغل الوحدة فعلياً — المالك عن سكنه، والمستأجر عن مأجوره. لا تُحتسب الوحدات المؤجَّرة على مالكها لأن مستأجرها مكلَّف بها، ولا الوحدات الشاغرة أو قيد الإنجاز. مناسب لرسم النظافة والقيمة التأجيرية.',
    OWNER:
      'يُحتسب على صاحب العقار عن كل ما يملكه — مشغولاً كان أو مؤجَّراً أو شاغراً أو قيد الإنجاز — ولا يُحتسب على المستأجرين. مناسب للرسوم التأسيسية كالأرصفة والمجاري.',
  } satisfies Record<FeeBearer, string>,

  /** Where a payment stands. `PENDING_REVIEW` is a claim, not a receipt. */
  paymentStatus: {
    UNPAID: 'مطلوب',
    PENDING_REVIEW: 'قيد المراجعة',
    PAID: 'مدفوع',
    OVERDUE: 'متأخّر',
  },

  paymentMethod: {
    CASH: 'نقداً في البلدية',
    WHISH_MONEY: 'تحويل Whish Money',
    COLLECTOR: 'عبر المحصّل',
  },

  /** Staff roles as the municipality names them, not as the enum spells them. */
  staffRole: {
    SUPER_ADMIN: 'مدير النظام',
    AUDITOR: 'مدقّق',
    FIELD_INSPECTOR: 'مفتّش ميداني',
    COLLECTOR: 'جابي',
    ACCOUNTANT: 'محاسب',
    ADMINISTRATIVE_OFFICER: 'موظف إداري',
  } satisfies Record<StaffRole, string>,

  residentStatus: {
    REFUGEE: 'لاجئ',
    DISPLACED: 'نازح',
    VILLAGE_RESIDENT: 'من سكان الضيعة',
  } satisfies Record<ResidentStatus, string>,

  identityDocType: {
    NATIONAL_ID: 'هوية',
    FAMILY_RECORD: 'إخراج قيد',
    DRIVER_LICENSE: 'دفتر سواقة',
    PASSPORT: 'جواز سفر',
  } satisfies Record<IdentityDocType, string>,

  /** Label of the number field that appears once a document type is chosen. */
  identityDocNumberLabel: {
    NATIONAL_ID: 'رقم الهوية',
    FAMILY_RECORD: 'رقم القيد',
    DRIVER_LICENSE: 'رقم الرخصة',
    PASSPORT: 'رقم الجواز',
  } satisfies Record<IdentityDocType, string>,

  maritalStatus: {
    SINGLE: 'أعزب',
    MARRIED: 'متزوج',
    DIVORCED: 'مطلّق',
    WIDOWED: 'أرمل',
  } satisfies Record<MaritalStatus, string>,

  /**
   * Never the bare word «شاغل».
   *
   * It differs from «شاغر» — the unit status below — by a single dot, and both
   * appear on the same property card. The parenthetical is what a clerk
   * glancing at a phone in a stairwell actually reads, and it is the half that
   * cannot be confused with anything.
   */
  occupancyType: {
    OWNER: 'مالك',
    TENANT: 'مستأجر',
    FREE_OCCUPANT: 'شاغل بتسامح (بدون بدل)',
  } satisfies Record<OccupancyType, string>,

  /** حالة الوحدة — about the unit, not the person. See `UNIT_STATUS`. */
  unitStatus: {
    OWNER_OCCUPIED: 'مشغولة من المالك',
    RENTED: 'مؤجرة',
    VACANT: 'شاغرة (غير مأهولة)',
    UNDER_CONSTRUCTION: 'قيد الإنجاز',
  } satisfies Record<UnitStatus, string>,

  propertyType: {
    BUILDING: 'مبنى',
    HOUSE: 'منزل',
    LAND: 'أرض',
    TENT: 'خيمة',
  } satisfies Record<PropertyType, string>,

  unitType: {
    APARTMENT: 'شقة',
    INDEPENDENT_HOUSE: 'منزل مستقل',
    CLINIC: 'عيادة',
    OFFICE: 'مكتب',
    SHOP: 'محل تجاري',
    WAREHOUSE: 'مستودع',
  } satisfies Record<UnitType, string>,

  landType: {
    AGRICULTURAL: 'زراعي',
    INDUSTRIAL: 'صناعي',
  } satisfies Record<LandType, string>,

  documentType: {
    IDENTITY: 'وثيقة الإثبات',
    OWNERSHIP_PROOF: 'سند الملكية',
    RENTAL_CONTRACT: 'عقد الإيجار',
    RESIDENCY_PROOF: 'إثبات الإقامة',
    EXTRA_PHOTO: 'صورة إضافية',
  } satisfies Record<DocumentType, string>,

  /**
   * Where a filed record stands. `REQUIRES_REVIEW` is not a rejection — the
   * citizen is registered and billable; named fields on the record were simply
   * never established, and the reasons are stored with it.
   */
  citizenRecordStatus: {
    PENDING: 'قيد الانتظار',
    REQUIRES_REVIEW: 'يتطلب مراجعة',
  },

  /**
   * Field names as the «غير مؤكَّد» list shows them, keyed by the last segment
   * of a flag path — `properties.2.landlordPhone` reads out as رقم هاتف المالك.
   *
   * Separate from the labels the inputs themselves render because those vary
   * with context (نوع الوثيقة renames رقم الوثيقة; اسم المبنى becomes
   * اسم المبنى/المنزل for a house) and a review list has none of that context
   * to hand. One stable name per field is what someone scanning a queue needs.
   */
  citizenField: {
    firstName: 'الاسم الأول',
    middleName: 'اسم الأب',
    lastName: 'الشهرة',
    gender: 'الجنس',
    bloodType: 'فئة الدم',
    identityDocType: 'نوع وثيقة الإثبات',
    identityDocNumber: 'رقم وثيقة الإثبات',
    civilRecordNumber: 'رقم السجل',
    nationality: 'الجنسية',
    isLebanese: 'الجنسية اللبنانية',
    residencyNumber: 'رقم الإقامة',
    residentStatus: 'صفة الإقامة',
    maritalStatus: 'الحالة الاجتماعية',
    phone: 'رقم الهاتف',
    whatsapp: 'رقم الواتساب',
    whatsappSameAsPhone: 'واتساب نفس رقم الهاتف',
    totalRegisteredMembers: 'إجمالي المسجلين في القيد',
    actualHouseholdMembers: 'عدد أفراد الأسرة المقيمين في المنزل (دون المتزوجين)',
    marriedChildrenCount: 'عدد الأبناء المتزوجين المستقلين',
    occupancyType: 'نوع الإشغال',
    landlordName: 'اسم المالك',
    landlordPhone: 'رقم هاتف المالك',
    unitStatus: 'حالة الوحدة',
    propertyType: 'نوع العقار',
    neighborhood: 'الحي',
    propertyNumber: 'رقم العقار',
    buildingName: 'اسم المبنى',
    side: 'الجهة',
    landType: 'نوع الأرض',
    tentLocation: 'موقع الخيمة',
    unitArea: 'المساحة',
    sharedRights: 'حقوق مشتركة',
    units: 'وحدات المبنى',
  } as Record<string, string>,
} as const;

export const en = {
  gender: { MALE: 'Male', FEMALE: 'Female' } satisfies Record<Gender, string>,

  bloodType: {
    A_POSITIVE: 'A+',
    A_NEGATIVE: 'A-',
    B_POSITIVE: 'B+',
    B_NEGATIVE: 'B-',
    AB_POSITIVE: 'AB+',
    AB_NEGATIVE: 'AB-',
    O_POSITIVE: 'O+',
    O_NEGATIVE: 'O-',
  } satisfies Record<BloodType, string>,

  feeFrequency: {
    ONCE: 'Once',
    MONTHLY: 'Monthly',
    HALF_YEARLY: 'Semi-Annually',
    ANNUALLY: 'Annually',
  },

  feeTargetType: {
    ALL_CITIZENS: 'All Citizens',
    BUILDING_CATEGORY: 'Property Category',
    INDIVIDUAL_CITIZEN: 'Individual Citizen',
  },

  feeTargetCategory: {
    BUILDING: 'Buildings',
    HOUSE: 'Houses',
    LAND: 'Land',
    TENT: 'Tents',
    APARTMENT: 'Apartments',
    INDEPENDENT_HOUSE: 'Independent Houses',
    CLINIC: 'Clinics',
    OFFICE: 'Offices',
    SHOP: 'Commercial Shops',
    WAREHOUSE: 'Warehouses',
  } satisfies Record<FeeTargetCategory, string>,

  feeBasis: {
    FLAT: 'Flat amount per citizen',
    PER_UNIT: 'Rate × number of units',
    PER_AREA: 'Rate × total area (m²)',
  } satisfies Record<FeeBasis, string>,

  feeBearer: {
    OCCUPANT: 'The occupant',
    OWNER: 'The owner',
  } satisfies Record<FeeBearer, string>,

  feeBearerHint: {
    OCCUPANT:
      'Charged to whoever actually occupies the unit — an owner for what they live in, a tenant for what they rent. A landlord is not charged for units they have let, because the tenant is billed for them; vacant and under-construction units are charged to nobody. Suits waste and rental-value fees.',
    OWNER:
      'Charged to the deed holder for everything they own — occupied, let, vacant or still being built — and not to tenants at all. Suits foundational fees such as pavements and sewerage.',
  } satisfies Record<FeeBearer, string>,

  paymentStatus: {
    UNPAID: 'Unpaid',
    PENDING_REVIEW: 'Pending Review',
    PAID: 'Paid',
    OVERDUE: 'Overdue',
  },

  paymentMethod: {
    CASH: 'Cash at Municipality',
    WHISH_MONEY: 'Whish Money Transfer',
    COLLECTOR: 'Via Collector',
  },

  staffRole: {
    SUPER_ADMIN: 'System Administrator',
    AUDITOR: 'Auditor',
    FIELD_INSPECTOR: 'Field Inspector',
    COLLECTOR: 'Collector',
    ACCOUNTANT: 'Accountant',
    ADMINISTRATIVE_OFFICER: 'Administrative Officer',
  } satisfies Record<StaffRole, string>,

  residentStatus: {
    REFUGEE: 'Refugee',
    DISPLACED: 'Displaced',
    VILLAGE_RESIDENT: 'Village Resident',
  } satisfies Record<ResidentStatus, string>,

  identityDocType: {
    NATIONAL_ID: 'National ID',
    FAMILY_RECORD: 'Family Record',
    DRIVER_LICENSE: 'Driver License',
    PASSPORT: 'Passport',
  } satisfies Record<IdentityDocType, string>,

  identityDocNumberLabel: {
    NATIONAL_ID: 'National ID Number',
    FAMILY_RECORD: 'Family Record Number',
    DRIVER_LICENSE: 'Driver License Number',
    PASSPORT: 'Passport Number',
  } satisfies Record<IdentityDocType, string>,

  maritalStatus: {
    SINGLE: 'Single',
    MARRIED: 'Married',
    DIVORCED: 'Divorced',
    WIDOWED: 'Widowed',
  } satisfies Record<MaritalStatus, string>,

  occupancyType: {
    OWNER: 'Owner',
    TENANT: 'Tenant',
    FREE_OCCUPANT: 'Free occupant (no rent)',
  } satisfies Record<OccupancyType, string>,

  unitStatus: {
    OWNER_OCCUPIED: 'Owner-occupied',
    RENTED: 'Rented out',
    VACANT: 'Vacant',
    UNDER_CONSTRUCTION: 'Under construction',
  } satisfies Record<UnitStatus, string>,

  propertyType: {
    BUILDING: 'Building',
    HOUSE: 'House',
    LAND: 'Land',
    TENT: 'Tent',
  } satisfies Record<PropertyType, string>,

  unitType: {
    APARTMENT: 'Apartment',
    INDEPENDENT_HOUSE: 'Independent House',
    CLINIC: 'Clinic',
    OFFICE: 'Office',
    SHOP: 'Commercial Shop',
    WAREHOUSE: 'Warehouse',
  } satisfies Record<UnitType, string>,

  landType: {
    AGRICULTURAL: 'Agricultural',
    INDUSTRIAL: 'Industrial',
  } satisfies Record<LandType, string>,

  documentType: {
    IDENTITY: 'Identity Document',
    OWNERSHIP_PROOF: 'Proof of Ownership',
    RENTAL_CONTRACT: 'Rental Agreement',
    RESIDENCY_PROOF: 'Residency Verification',
    EXTRA_PHOTO: 'Additional Photograph',
  } satisfies Record<DocumentType, string>,

  citizenRecordStatus: {
    PENDING: 'Pending',
    REQUIRES_REVIEW: 'Requires Review',
  },

  citizenField: {
    firstName: 'First Name',
    middleName: "Father's Name",
    lastName: 'Last Name',
    gender: 'Gender',
    bloodType: 'Blood Type',
    identityDocType: 'ID Document Type',
    identityDocNumber: 'ID Document Number',
    civilRecordNumber: 'Civil Record (Sijil) No.',
    nationality: 'Nationality',
    isLebanese: 'Lebanese Nationality',
    residencyNumber: 'Residency Permit No.',
    residentStatus: 'Residency Status',
    maritalStatus: 'Marital Status',
    phone: 'Phone Number',
    whatsapp: 'WhatsApp Number',
    whatsappSameAsPhone: 'WhatsApp Same As Phone',
    totalRegisteredMembers: 'Total Registered (Civil Record)',
    actualHouseholdMembers: 'Family Members Living in House (excl. married)',
    marriedChildrenCount: 'Married Children Count',
    occupancyType: 'Occupancy Type',
    landlordName: 'Landlord Name',
    landlordPhone: 'Landlord Phone',
    unitStatus: 'Unit Status',
    propertyType: 'Property Type',
    neighborhood: 'Neighborhood',
    propertyNumber: 'Property Number',
    buildingName: 'Building Name',
    side: 'Side / Orientation',
    landType: 'Land Type',
    tentLocation: 'Tent Location',
    unitArea: 'Area',
    sharedRights: 'Shared Rights',
    units: 'Building Units',
  } as Record<string, string>,
} as const;

export function getLabels(locale: string = 'ar') {
  return locale === 'en' ? en : ar;
}
