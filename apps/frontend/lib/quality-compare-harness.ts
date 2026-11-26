/*
  What the nets under the comparison «الإجراء» share (PAGE-13): two citizens filed twice, the editable copy of
  each file, two structures on one parcel, and the findings that set them against each other. Not a test file,
  and no application code imports it; each net mounts the screen itself (no module of `lib` imports a
  component).
*/
import type { BuildingDetail, CitizenFormData, CitizenProfile } from '@/lib/api-client';
import type { QualityFinding } from '@/lib/quality-api';

export const ALI = 'a0000000-0000-4000-8000-00000000000a';
export const HASSAN = 'b0000000-0000-4000-8000-00000000000b';
export const EAST = 'c0000000-0000-4000-8000-00000000000c';
export const WEST = 'd0000000-0000-4000-8000-00000000000d';
const ENTRY = '3f1a0c6e-8b24-4d7a-9c15-2e6b0a91d4f7';
const BUILDING = 'b71d9e02-5c43-4a18-8f6d-1029ac3e5b84';

const profile = (over: Record<string, unknown>): CitizenProfile =>
  ({
    motherName: 'فاطمة سعد',
    phone: '+96170123456',
    whatsapp: '+961 70 123 456',
    civilRecordNumber: '48',
    residence: 'RESIDENT',
    gender: 'MALE',
    nationality: 'لبنانية',
    residentStatus: 'VILLAGE_RESIDENT',
    maritalStatus: 'MARRIED',
    actualHouseholdMembers: 4,
    totalRegisteredMembers: 6,
    registrations: [{ properties: [{}, {}] }],
    registeredAt: '2026-01-10T09:00:00Z',
    isActive: true,
    hasNoPhone: false,
    ...over,
  }) as unknown as CitizenProfile;

/** Registered first. */
export const FIRST = profile({ id: ALI, fullName: 'محمد أحمد خليل', referenceNumber: 'C-1' });
/** The second file: a phone typed with spaces, no mother's name, deactivated, a household not recorded. */
export const SECOND = profile({
  id: HASSAN,
  fullName: 'محمد احمد خليل',
  referenceNumber: 'C-2',
  motherName: null,
  phone: '+961 70 123 456',
  whatsapp: null,
  actualHouseholdMembers: null,
  totalRegisteredMembers: null,
  registrations: [{ properties: [] }],
  isActive: false,
});
/** Somebody living elsewhere, who has no phone: neither is asked for a mother's name or offered a number. */
export const ABROAD = profile({
  id: HASSAN,
  fullName: 'سامي نون',
  referenceNumber: 'C-3',
  residence: 'NON_RESIDENT_OWNER',
  motherName: null,
  phone: null,
  hasNoPhone: true,
});

/** The editable copy of a file, as `GET /citizens/:id/form` sends it. */
export const file = (id: string, over: Partial<CitizenFormData> = {}): CitizenFormData => ({
  id,
  registrationId: 'registration-1',
  referenceNumber: 'C-1',
  status: 'PENDING',
  residence: 'RESIDENT',
  version: 'filing-1:v7',
  personal: {
    firstName: 'محمد',
    middleName: 'أحمد',
    lastName: 'خليل',
    motherName: 'فاطمة سعد',
    gender: 'MALE',
    nationality: 'لبنانية',
    isLebanese: true,
    civilRecordNumber: '48',
    residentStatus: 'VILLAGE_RESIDENT',
    bloodType: '',
    residencePlace: '',
  },
  contact: {
    phone: '+96170123456',
    whatsapp: '+96170123456',
    whatsappSameAsPhone: true,
    maritalStatus: 'MARRIED',
    totalRegisteredMembers: 6,
    actualHouseholdMembers: 4,
    localContactName: '',
    localContactPhone: '',
  },
  properties: [
    {
      id: ENTRY,
      occupancyType: 'OWNER',
      propertyType: 'BUILDING',
      neighborhood: 'الحي الشرقي',
      propertyNumber: '498',
      buildingName: 'مبنى الزهراء',
      buildingId: BUILDING,
      unitArea: 120,
      shares: null,
      sharedRights: [],
      landlordName: null,
      landlordPhone: null,
      landlordCitizenId: null,
      landlordLink: null,
      units: [],
    },
  ],
  flags: [],
  notes: null,
  ...over,
});

const building = (over: Record<string, unknown>): BuildingDetail =>
  ({
    name: 'مبنى الزهراء',
    postedNumber: '12',
    parcelNumber: '498',
    zoneName: 'الحي الشرقي',
    zoneCode: 'E',
    structureType: 'BUILDING',
    lifecycleStatus: 'OCCUPIED',
    floorsCount: 3,
    basementsCount: 1,
    unitsTotal: 9,
    unitsSurveyed: 4,
    latitude: 33.123456,
    longitude: 35.654321,
    createdAt: '2026-02-01T09:00:00Z',
    notes: null,
    ...over,
  }) as unknown as BuildingDetail;

export const EAST_BUILDING = building({ id: EAST, code: 'X-498-A' });
export const WEST_BUILDING = building({
  id: WEST,
  code: 'X-498-B',
  name: null,
  zoneName: null,
  basementsCount: null,
  latitude: null,
  longitude: null,
});

const finding = (over: Partial<QualityFinding> & Pick<QualityFinding, 'kind' | 'subjects'>): QualityFinding => ({
  subjectKey: 'pair',
  severity: 'HIGH',
  detail: 'Two records to compare — they look alike',
  officers: [],
  at: null,
  dismissable: true,
  dismissal: null,
  ...over,
});

export const TWO_CITIZENS = finding({
  kind: 'DUPLICATE_CITIZEN',
  subjects: [
    { kind: 'citizen', id: ALI, label: 'محمد أحمد خليل', secondary: 'C-1' },
    { kind: 'citizen', id: HASSAN, label: 'محمد احمد خليل', secondary: 'C-2' },
  ],
});
export const TWO_BUILDINGS = finding({
  kind: 'NEAR_DUPLICATE_BUILDINGS',
  severity: 'MEDIUM',
  subjects: [
    { kind: 'building', id: EAST, label: 'X-498-A', secondary: '498' },
    { kind: 'building', id: WEST, label: 'X-498-B', secondary: '498' },
  ],
});
/** One record only: nothing to set against it. */
export const ONE_RECORD = finding({
  kind: 'BUILDING_WITHOUT_PIN',
  subjects: [{ kind: 'building', id: EAST, label: 'X-498-A', secondary: null }],
});
