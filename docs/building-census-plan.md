# Building Census, Zone/Building Numbering & War Damage — Implementation Plan

> **Status:** **Phase 1 complete** (P1-T1 … P1-T7, 2026-09-09). Phase 2 not started.
> **Created:** 2026-09-09 · **Branch to use:** `feat/building-census` (off `develop`)
> **Owner:** Hashem Nasrallah
>
> Phase 1 was implemented on `update-form` rather than a new branch — nothing is
> committed yet, so the changeset can still be moved wherever it belongs.

---

## 0. How to use this document

This file is written so a **fresh Claude session with no prior context** can pick up the work.

If you are that session, do this first:

1. Read this whole file.
2. Read [schema.prisma](../apps/backend/src/infrastructure/prisma/tenant/schema.prisma) — the tenant data model.
3. Read [property.schema.ts](../packages/shared-schemas/src/property.schema.ts) and
   [field-flag.schema.ts](../packages/shared-schemas/src/field-flag.schema.ts) — the validation spine.
4. Check §6 "Progress log" to see what is already done. **Phase 1 is complete** —
   §6 lists every file it touched and where Phase 2 should start.
5. Read the **P1-T7 caveat** at the end of §5's Phase 1 table before building any
   per-unit «غير مؤكَّد» control, and the **database-state note** in §1 before
   assuming there is data to migrate.
6. The user will tell you which **Phase** and **Task ID** to continue from (e.g. "continue from P2-T3").

**Conventions used below:** `P1-T2` = Phase 1, Task 2. Every task has an acceptance
criterion. Do not start a later phase before the earlier one's acceptance criteria pass.

---

## 1. Repository facts a new session needs

| Thing | Value |
|---|---|
| Monorepo | pnpm workspaces — `apps/backend`, `apps/frontend`, `packages/shared-schemas` |
| Backend | NestJS + Prisma. Layers: `application/features/<name>/`, `presentation/controllers/` |
| Frontend | Next.js App Router, route shape `app/[tenant]/[locale]/[adminPath]/(protected)/…` |
| Validation | Zod, shared between both apps, in `packages/shared-schemas/src/` |
| Multi-tenancy | **Schema-per-tenant** in Postgres (`tenant_<slug>`), plus a separate registry schema |
| Tenant schema file | `apps/backend/src/infrastructure/prisma/tenant/schema.prisma` |
| Migrations | `.../tenant/migrations/NNNN_name/migration.sql` — **hand-written, idempotent SQL** (`DO $$ … IF NOT EXISTS`), not `prisma migrate dev` output |
| Latest migration on disk | `0030_building_census` (applied to staging, **not** to production) → next number is `0031` |
| Apply migrations | `pnpm db:deploy:local` / `:staging` / `:production`; dry run via `pnpm db:status:*` |
| Typecheck | `pnpm typecheck` · Lint: `pnpm lint` |
| Language | **Arabic-first, RTL.** Enum values are stable English machine strings; Arabic display labels live in `packages/shared-schemas/src/labels.ts` |
| Offline-first | Field officers submit from phones with no signal — IndexedDB queue + `clientSubmissionId` idempotency + `apps/frontend/public/sw.js` |
| Map | Mapbox GL. Main component `apps/frontend/components/admin/fullscreen-map.tsx` |
| Cadastre assets | Served at `/t/:tenantSlug/cadastre/assets/:assetName` — `cadastre.geojson`, `parcels.geojson`, `parcel-polygons.geojson`, `city-boundary.geojson` |

### Critical pre-existing facts (verified 2026-09-09)

Struck-through items were true when the plan was written and were **changed by
Phase 1**. They are kept rather than deleted so a later session reading old code
comments or old branches recognises what it is looking at.

- **`parcel-polygons.geojson` already exists.** Produced by
  `apps/backend/src/infrastructure/cadastre/parcel-geometry.ts` (custom half-edge
  face-tracing) and uploaded by the cadastre import. Consumed by
  `zone-editor-map.tsx:122`; `fullscreen-map.tsx` does **not** load it.
  ~~Polygons are not in the database.~~ → **P1-T4 put them there** (`Parcel.boundary`).
  The "1,702 polygons" figure in the original plan was stale: the current tracer
  produces **1,806 faces covering 1,800 of albazourieh's 1,825 parcels** (98.6%);
  25 stay point-only. The committed asset had been left at an older 1,798 and was
  regenerated in Phase 1.
- **`turf.polygonize` crashes on this cadastre input.** Never reach for it. Use the
  existing `parcel-geometry.ts`.
- ~~**`Parcel` has `latitude`/`longitude`/`pointCount` only** — no geometry column.~~
  → `Parcel.boundary Json?` added in 0030. Holds a bare GeoJSON geometry:
  `Polygon`, or `MultiPolygon` for the **6 parcels** the survey drew as several
  disconnected pieces.
- ~~**A building has no existence today.**~~ → `buildings`, `units`,
  `unit_occupancies` and `damage_assessments` exist as of 0030. `PropertyEntry`
  and `BuildingUnit` are unchanged apart from a nullable link each, and **remain
  authoritative for billing until P2-T8**.
- ~~**`FLAG_PATH` matches `personal.x`, `contact.x`, `properties.N.x` only.**~~
  → P1-T7 added `properties.N.units.M.<field>`.
- **`floor` is `String`** on `BuildingUnit` — `"الأرضي"`, `"ground"`, `"0"`, `"G"` all
  coexist, and it stays that way deliberately. `Unit.floor` is an `Int`, and
  `parseFloorLabel` in `packages/shared-schemas/src/numbering.ts` is the one-way
  door between them.

### Database state (verified against both projects, 2026-09-09)

This is the fact that decides how much the backfill actually matters, and it is
not what the plan assumed when it was written:

| | production (`thbgwfbcqdougbjvgvyw`) | staging (`lzgbjcwtzqyrbeoolvdz`) |
|---|---|---|
| citizens | **0** | 5 (test records) |
| registrations / property cards | **0 / 0** | 5 / 5 |
| `building_units` | **0** | 5 |
| parcels | 1,825 | 1,825 |

**Production holds municipality staff accounts and the imported cadastre, and no
citizen data at all — there is nothing to backfill there.** The staging records
are disposable test data (the user has confirmed they can be deleted).

Two consequences worth carrying forward:

1. `backfill-buildings.ts` is not a migration risk on production today. It will
   matter when real surveying starts, and it is idempotent, so it can simply be
   re-run then.
2. The census tables will be populated by **field officers using the Phase 3 UI**,
   not by the backfill. Phase 2 and 3 should be built for that path first; the
   backfill is a compatibility bridge for cards filed before the UI existed, and
   the only cards that will ever exist are the ones staff enter from now on.

---

## 2. Locked decisions

These were debated and approved. Do not re-litigate them; if you think one is wrong,
raise it with the user before changing course.

| # | Decision | Why |
|---|---|---|
| D1 | `Building` is a **first-class table anchored to a parcel**, independent of any `Registration` | You cannot colour, count, or filter what has no row. Creating the shell before surveying is the whole point. |
| D2 | Occupancy is a **join table `UnitOccupancy`**, never scalar `ownerCitizenId`/`occupantCitizenId` columns | Two nullable FKs cannot express co-owners, owner-abroad + tenant, or tenancy history. Lebanese inheritance makes multi-owner the normal case. |
| D3 | Damage is an **append-only `DamageAssessment` log**, not an overwritten enum | A building damaged Oct 2024 and repaired 2026 needs history, an observer, and a source. |
| D4 | Damage levels use the **UN-Habitat 5-level scale verbatim** | Already the vocabulary of Beirut Municipality, Bourj Hammoud, UNDP and Balamand-CREEMO. Keeps data aggregatable with national reconstruction datasets. The habitability split (`UNSAFE_EVACUATE` vs `RESTRICTED_USE`) is what aid distribution turns on. |
| D5 | **`UNDER_CONSTRUCTION` is NOT a damage level** | It is a lifecycle state and already exists in `UnitStatus`. Mixing it in would erase damage history. |
| D6 | **No `WAR_DAMAGE` case type.** A `Case` is a *failed visit*; damage is a *fact about a structure* | Otherwise "resolve" is ambiguous — revisited, or repaired? A `Case` may reference a `DamageAssessment`. |
| D7 | Building code = **`ZONE-PARCEL-SUFFIX`**, delimited, anchored on رقم العقار | The deed already prints the parcel number; the cadastre validates it; the citizen recognises it. Delimiters remove the `A1B2` ambiguity. |
| D8 | Unit code = **floor-derived `floor×100 + seq`** (`0304` = floor 3, unit 4) | Self-describing — a collector reads the floor off the code without opening the app. |
| D9 | The **UUID is the identity; the code is a derived display attribute** | UPRN's lesson: identifiers are permanent, addresses change. Store `codeSuffix` durably, recompute `code`. |
| D10 | Survey status is a **state machine on the Unit**, rolled up to the Building | "Never attempted" vs "three visits, no answer" is the actual dispatch decision. |
| D11 | Building/parcel colour shows the **worst** status among its units, not the majority | Consistent with the existing precedent in `unitStatusField`: an unknown unit is billed, not exempted. An unsurveyed flat must not hide behind 11 surveyed ones. |
| D12 | Blanket reason **auto-fills per-field reasons as an overridable default** — it does not replace them | A single reason on 30 fields leaves the reviewer with nothing actionable. |
| D13 | `Zone` membership stays derived from `parcelNumber`; **no `zoneId` column on `Building`** | Two sources of truth would drift on the first zone reassignment. |
| D14 | Store both `officialCode` (ours) and `postedNumber` (what's painted on the door) | If the register says `0304` and the door says `12`, the collector trusts the door. |
| D15 | Do not reuse `PropertyType`/`UnitType` for structures — add `StructureType` and **map it explicitly** (§3.6) | Three overlapping vocabularies would be a permanent maintenance trap. |

---

## 3. Target data model

### 3.1 New enums (`packages/shared-schemas/src/enums.ts`)

Follow the existing file's style: `export const X = [...] as const;` +
`arabicEnum(X, 'رسالة')` + `export type X = z.infer<…>`. Arabic labels go in `labels.ts`.

```ts
/** What physically stands on a parcel. See §3.6 for the mapping to PropertyType/UnitType. */
export const STRUCTURE_TYPE = [
  'RESIDENTIAL_BUILDING',   // مبنى سكني — multi-unit
  'INDEPENDENT_HOUSE',      // منزل مستقل / فيلا
  'COMMERCIAL_CENTER',      // مجمع تجاري / مركز محلات
  'WAREHOUSE_HANGAR',       // مستودع / هنغار
  'MIXED_USE',              // سكني-تجاري
  'TENT_SHELTER',           // خيمة / مأوى — see D-open-2
] as const;

/** Per-unit survey progress. Building-level status is a rollup (§3.3). */
export const SURVEY_STATUS = [
  'NOT_SURVEYED',        // غير ممسوحة — never attempted
  'VISITED_NO_ANSWER',   // زيارة بلا رد
  'PARTIAL',             // بيانات ناقصة
  'COMPLETE',            // مكتملة
  'REFUSED',             // رفض إعطاء البيانات
  'INACCESSIBLE',        // يتعذر الوصول
  'VACANT_CONFIRMED',    // شاغرة مؤكدة
  'DEMOLISHED',          // مهدومة
] as const;

/** UN-Habitat rapid building-level damage assessment scale. Do not alter — see D4. */
export const DAMAGE_LEVEL = [
  'NOT_AFFECTED',      // غير متأثر
  'SAFE_MINOR_DAMAGE', // أضرار طفيفة — آمن
  'RESTRICTED_USE',    // استخدام مقيد
  'UNSAFE_EVACUATE',   // غير آمن — إخلاء
  'TOTAL_COLLAPSE',    // انهيار كلي
  'UNCLASSIFIED',      // غير مصنّف
] as const;

/** Where a damage reading came from. Affects how much to trust it. */
export const DAMAGE_SOURCE = ['FIELD_VISIT', 'SATELLITE', 'SELF_REPORTED', 'OFFICIAL_REPORT'] as const;

/** Why a visit did not become a registration. NOTE: no WAR_DAMAGE — see D6. */
export const CASE_TYPE = [
  'UNIT_UNREACHABLE',   // مقفل / لم يتم الرد
  'ACCESS_REFUSED',     // رفض إعطاء بيانات
  'VACANT_UNCONFIRMED', // شاغر قيد التحقق
  'OWNERSHIP_DISPUTE',  // نزاع ملكية
  'GENERAL_NOTE',       // ملاحظة عامة
] as const;

/** A person's relationship to a unit. Mirrors OccupancyType, kept separate so a
 *  unit-level role can exist without a Registration behind it. */
export const OCCUPANCY_ROLE = ['OWNER', 'TENANT', 'FREE_OCCUPANT'] as const;
```

Extend `CASE_STATUS` from `['OPEN','RESOLVED']` to
`['OPEN', 'SCHEDULED', 'RESOLVED']` (`SCHEDULED` = a revisit date is set).

### 3.2 `Building` (new)

```prisma
/// One physical structure standing on a parcel. Exists independently of any
/// citizen or registration: the municipality creates the shell first, then
/// surveys the units inside it. This is what makes an unsurveyed apartment a
/// row that can be counted, coloured and filtered rather than an absence.
model Building {
  id String @id @default(uuid()) @db.Uuid

  /// رقم العقار this building stands on. A string, not an FK, for the same
  /// reason Zone.parcelNumbers is: `cadastre:import` rebuilds the parcel table
  /// wholesale, and a routine survey correction must not cascade buildings away.
  parcelNumber String

  /// The durable half of the code — just the per-parcel suffix, e.g. "A".
  /// Assigned in order of first creation on the parcel. Letters I and O are
  /// skipped (they read as 1 and 0). This never changes once assigned.
  codeSuffix String

  /// Denormalised display code, `ZONE-PARCEL-SUFFIX` e.g. "A-1042-B".
  /// DERIVED — recomputed whenever the parcel's zone changes. Never treat as
  /// identity; the UUID above is the identity. See D9.
  code String @unique

  /// What residents call it — "بناية النور". Free text, optional.
  name String?

  /// What is actually painted on the building. May disagree with `code`; when
  /// it does, the collector trusts this one, so both get printed on notices.
  postedNumber String?

  structureType StructureType

  /// The entrance, not the centroid — this is the dot a collector navigates to.
  /// Nullable: a building may be created from a desk before anyone stands at it.
  latitude  Float?
  longitude Float?

  floorsCount Int @default(1)

  /// Maintained by trigger (see migration 0030). The map styles off these
  /// without an N+1 query.
  unitsTotal    Int @default(0)
  unitsSurveyed Int @default(0)

  notes String?

  createdById String? @db.Uuid
  createdBy   User?   @relation("BuildingCreatedBy", fields: [createdById], references: [id])

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  units             Unit[]
  cases             Case[]
  damageAssessments DamageAssessment[]
  propertyEntries   PropertyEntry[]

  @@unique([parcelNumber, codeSuffix])
  @@index([parcelNumber])
  @@index([latitude, longitude])
  @@map("buildings")
}
```

### 3.3 `Unit` (new — the canonical unit)

> **Naming note:** this is a *new* table called `units`. The existing
> `BuildingUnit`/`building_units` table stays for now and gains an FK to it
> (§3.7). Do not rename `BuildingUnit` in Phase 1 — that breaks billing.

```prisma
/// One canonical unit inside a building — شقة, محل, عيادة.
///
/// The unit exists whether or not anyone has been surveyed in it. That is the
/// entire point: a flat nobody answered is a row with survey_status =
/// NOT_SURVEYED and no occupancy, which the map can colour and the cases page
/// can filter. Before this table it was nothing at all.
model Unit {
  id         String   @id @default(uuid()) @db.Uuid
  buildingId String   @db.Uuid
  building   Building @relation(fields: [buildingId], references: [id], onDelete: Cascade)

  /// Signed. Basement negative, ground 0, first floor 1. NOT a string — see D8
  /// and the `floor` normalisation in P1-T5.
  floor Int

  /// Sequence within the floor, 1-based. `floor*100 + seq` is `unitCode`.
  sequence Int

  /// Derived display code, floor-based: floor 3 unit 4 -> "0304", basement 1
  /// unit 2 -> "B102". Self-describing to a collector on foot.
  unitCode String

  /// What is actually on the door, if different.
  postedNumber String?

  unitType UnitType

  /// Orientation — يمين / يسار / أمامي. Free text, matches existing `side`.
  side String?

  unitArea Decimal? @db.Decimal(12, 2)

  /// حالة الوحدة — reuses the existing enum. Null still means "nobody was
  /// asked", and is still billed. See isUnoccupied() in enums.ts.
  unitStatus UnitStatus?

  surveyStatus SurveyStatus @default(NOT_SURVEYED)

  notes String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  occupancies       UnitOccupancy[]
  cases             Case[]
  damageAssessments DamageAssessment[]
  buildingUnits     BuildingUnit[]

  @@unique([buildingId, floor, sequence])
  @@index([buildingId])
  @@index([surveyStatus])
  @@map("units")
}
```

### 3.4 `UnitOccupancy` (new — D2)

```prisma
/// Who is in a unit, in what capacity, and when. A join table rather than two
/// FK columns on the unit, because a flat routinely has an owner abroad, a
/// tenant living in it, and two co-heirs on the deed — and because a previous
/// tenant is information the municipality needs, not history to overwrite.
model UnitOccupancy {
  id     String @id @default(uuid()) @db.Uuid
  unitId String @db.Uuid
  unit   Unit   @relation(fields: [unitId], references: [id], onDelete: Cascade)

  citizenId String @db.Uuid
  citizen   User   @relation("UnitOccupant", fields: [citizenId], references: [id], onDelete: Cascade)

  role OccupancyRole

  /// أسهم out of 2400, OWNER rows only — mirrors PropertyEntry.shares.
  shares Int?

  /// Null `toDate` = current. Historical rows keep their dates.
  fromDate DateTime  @default(now())
  toDate   DateTime?

  /// The registration this occupancy was established by, when there is one.
  /// Null for an occupancy recorded directly on the unit matrix before the
  /// citizen's full file exists.
  registrationId String?       @db.Uuid
  registration   Registration? @relation(fields: [registrationId], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([unitId])
  @@index([citizenId])
  @@index([unitId, toDate])
  @@map("unit_occupancies")
}
```

### 3.5 `DamageAssessment` (new — D3/D4)

```prisma
/// One observation of a structure's condition at a point in time. Append-only:
/// the current level is the latest row, and a building repaired in 2026 keeps
/// the row that says it was unsafe in 2024.
///
/// Attaches to a Building, or to a Unit for the "top three floors gone, ground
/// floor shop still trading" case. Exactly one of the two is set.
model DamageAssessment {
  id String @id @default(uuid()) @db.Uuid

  buildingId String?   @db.Uuid
  building   Building? @relation(fields: [buildingId], references: [id], onDelete: Cascade)

  unitId String? @db.Uuid
  unit   Unit?   @relation(fields: [unitId], references: [id], onDelete: Cascade)

  level  DamageLevel
  source DamageSource @default(FIELD_VISIT)

  /// Free text — what was actually seen. "الطابق الرابع مهدوم، الدرج غير سالك".
  observations String?

  assessedAt DateTime @default(now())

  assessedById String? @db.Uuid
  assessedBy   User?   @relation("DamageAssessedBy", fields: [assessedById], references: [id])

  createdAt DateTime @default(now())

  cases Case[]

  @@index([buildingId, assessedAt])
  @@index([unitId, assessedAt])
  @@index([level])
  @@map("damage_assessments")
}
```

### 3.6 `StructureType` ↔ existing enums (D15)

The three vocabularies must not drift. Write this map in `enums.ts` next to the enum
and use it everywhere; do not hand-code the correspondence at call sites.

| `StructureType` | Legacy `PropertyType` | Default `UnitType` for generated units |
|---|---|---|
| `RESIDENTIAL_BUILDING` | `BUILDING` | `APARTMENT` |
| `INDEPENDENT_HOUSE` | `HOUSE` | `INDEPENDENT_HOUSE` |
| `COMMERCIAL_CENTER` | `BUILDING` | `SHOP` |
| `WAREHOUSE_HANGAR` | `BUILDING` | `WAREHOUSE` |
| `MIXED_USE` | `BUILDING` | `APARTMENT` |
| `TENT_SHELTER` | `TENT` | `INDEPENDENT_HOUSE` |

**`LAND` has no building** and never gets one — a land card stays a bare
`PropertyEntry`. `TENT_SHELTER` exists so a tent settlement can be mapped and
revisited like anything else; see open question **Q2** before implementing it.

### 3.7 Modifications to existing models

```prisma
model PropertyEntry {
  // … existing fields unchanged …
  /// Optional link to the canonical structure. Nullable through the whole
  /// transition; see §5 Phase 2 for the backfill and the authority rule.
  buildingId String?   @db.Uuid
  building   Building? @relation(fields: [buildingId], references: [id], onDelete: SetNull)
  @@index([buildingId])
}

model BuildingUnit {
  // … existing fields unchanged …
  /// Link from the per-registration unit row to the canonical unit.
  unitId String? @db.Uuid
  unit   Unit?   @relation(fields: [unitId], references: [id], onDelete: SetNull)
  @@index([unitId])
}

model Case {
  // … existing fields unchanged …
  caseType CaseType @default(GENERAL_NOTE)

  buildingId String?   @db.Uuid
  building   Building? @relation(fields: [buildingId], references: [id], onDelete: SetNull)

  unitId String? @db.Uuid
  unit   Unit?   @relation(fields: [unitId], references: [id], onDelete: SetNull)

  /// A case may point at the damage reading that prompted it — but it does not
  /// own it, and resolving the case says nothing about the damage. See D6.
  damageAssessmentId String?           @db.Uuid
  damageAssessment   DamageAssessment? @relation(fields: [damageAssessmentId], references: [id], onDelete: SetNull)

  scheduledRevisitAt DateTime?

  @@index([caseType])
  @@index([buildingId])
  @@index([unitId])
}

model Parcel {
  // … existing fields unchanged …
  /// Parcel outline as GeoJSON, copied from the `parcel-polygons.geojson` the
  /// cadastre import already derives. Stored here so the server can answer
  /// "is this pin inside this parcel?" without shipping 1,702 polygons to it.
  /// Null for the ~6% of parcels face-tracing could not close.
  boundary Json?
}

model Registration {
  // … existing fields unchanged …
  /// «سبب عام لنقص البيانات» — one reason the officer states once, used to fill
  /// each individual field flag's reason when they did not write a specific
  /// one. It does NOT replace per-field flags — see D12.
  blanketFlagReason String?
}

model User {
  // … add the back-relations …
  unitOccupancies    UnitOccupancy[]    @relation("UnitOccupant")
  damageAssessments  DamageAssessment[] @relation("DamageAssessedBy")
  buildingsCreated   Building[]         @relation("BuildingCreatedBy")
}
```

---

## 4. Numbering specification

### 4.1 Building code

```
<ZONE>-<PARCEL>-<SUFFIX>
   A  -  1042  -   B
```

- **ZONE** — `Zone.code` for the zone whose `parcelNumbers` contains this parcel.
  If the parcel is in no zone, use `X`. **Derived at render time, never stored
  as an FK** (D13).
- **PARCEL** — `Parcel.parcelNumber` verbatim.
- **SUFFIX** — `Building.codeSuffix`. Allocated per parcel in creation order:
  `A, B, C, … H, J, K, … N, P, Q, …` — **`I` and `O` are skipped.** After `Z`,
  continue `AA, AB, …`. Most parcels only ever have `A`.

**Suffix allocation order for a fresh parcel survey:** start at the building whose
entrance is nearest the parcel's street frontage, then proceed **clockwise**.
Write this into the field officers' handbook — the rule matters less than it being
fixed, so two surveyors produce the same answer.

**Recompute rule:** `code` is regenerated when (a) the building is created,
(b) the parcel is added to or removed from a zone, or (c) a zone's `code` changes.
`codeSuffix` and the UUID never change. Any job that rewrites codes must do so in a
single transaction because of the `@unique` constraint.

### 4.2 Unit code

`unitCode = pad(floor × 100 + sequence, 4)` for floor ≥ 0; `"B" + pad(|floor| × 100 + sequence, 3)` for basements.

| floor | sequence | unitCode |
|---|---|---|
| 0 (ground) | 1 | `0001` |
| 1 | 2 | `0102` |
| 3 | 4 | `0304` |
| 12 | 1 | `1201` |
| −1 (basement) | 2 | `B102` |

### 4.3 Full reference

`A-1042-B-0304` = zone A, parcel 1042, building B, third floor, fourth unit.
Print `postedNumber` alongside it on any notice where it differs (D14).

### 4.4 Offline allocation

Field phones create buildings offline. Two officers in the same parcel will both
want suffix `A`. Rule:

1. Client mints a **UUID** and a **provisional suffix** it computes from what it has
   cached. It shows the code with a "مؤقت" badge.
2. On sync the server re-allocates the real suffix inside a transaction that takes a
   row lock on the parcel, and returns the authoritative `code`.
3. The client replaces the provisional code and, if it changed, surfaces a one-line
   notice so the officer does not keep quoting the old one.
4. The reallocation writes an `AuditLogEntry`.

**Never let a provisional code reach a printed receipt.** See §7 Q4.

---

## 5. Phases

### Phase 1 — Foundation (no UI) — ✅ **complete 2026-09-09**

Goal: the tables exist, are populated from existing data, and the map has geometry
to draw into. Nothing user-visible changes.

| ID | Task | Acceptance | Result |
|---|---|---|---|
| P1-T1 | Add the six new enums + `CASE_STATUS` extension to `enums.ts`; Arabic labels in `labels.ts`; export the `StructureType` map from §3.6 | `pnpm typecheck` passes; every enum has a label | ✅ `typecheck` clean. Every enum has ar **and** en labels, each `satisfies Record<T, string>` so a missing one is a compile error. Also added `SURVEYED_STATUS` + `isSurveyed()` — the trigger in 0030 needs a definition of "surveyed" and it must not be a second opinion. |
| P1-T2 | Add `Building`, `Unit`, `UnitOccupancy`, `DamageAssessment` to `schema.prisma`; add the §3.7 modifications | `pnpm db:generate` succeeds | ✅ `pnpm db:generate` succeeds; `prisma validate` clean. |
| P1-T3 | Write `migrations/0030_building_census/migration.sql` — idempotent, following the `0027_cases` style. Include the `unitsTotal`/`unitsSurveyed` maintenance trigger and the `Parcel.boundary` column | `pnpm db:status:local` clean after `pnpm db:deploy:local` | ✅ Applied to staging; `db:status:local` reports "already up to date". Trigger verified in a rolled-back transaction across insert / status change / delete / **cross-building move** (both sides recount). Added a `CHECK` that a `DamageAssessment` names exactly one of building/unit — Prisma cannot express it. |
| P1-T4 | Persist parcel polygons: extend the cadastre import to write `parcel-polygons.geojson`'s features into `Parcel.boundary` | Row count with non-null `boundary` ≈ 1,702 for albazourieh | ✅ **1,800 / 1,825** after a real `cadastre:import` from `bazoreyye.kmz`. (The 1,702 in the plan was stale.) All 1,800 verified: closed rings, ≥4 points, each parcel's own point inside its outline's bbox. |
| P1-T5 | **Floor normalisation.** Add `Unit.floor Int`; write `parseFloorLabel(s: string): number \| null` in shared-schemas handling `الأرضي/ground/G/0`, `ط1`, `-1`, `قبو/basement`. Keep the legacy `BuildingUnit.floor` string untouched | Unit-tested against the distinct `floor` values actually in the DB (query them first) | ✅ 53 tests. The DB was queried first and holds only `"0"`, `"1"`, `"2"` — which proves nothing, so the suite covers the shapes a free-text RTL input actually produces instead. Legacy column untouched. |
| P1-T6 | **Backfill script** `apps/backend/src/scripts/backfill-buildings.ts` … Idempotent, `--dry-run` first | Re-running produces zero new rows; a spot-check of 10 parcels matches by hand | ✅ Run against staging: 5 cards → 2 buildings, 7 units, 7 occupancies, matching a by-hand derivation row for row. Re-run: **0 created**. Only 2 parcels exist in the data, not 10 — see the database-state note in §1. |
| P1-T7 | Fix `FLAG_PATH` at `field-flag.schema.ts:79` to accept `properties.N.units.M.<field>`; teach `withoutFlagged` to walk the `units` array | New unit tests in `apps/backend/src/application/features/citizens/field-flags.spec.ts` | ✅ 11 new tests; all 27 pre-existing ones still pass. **See the caveat below — the schema now accepts these flags but the write path cannot yet store them.** |

> **P1-T6 authority rule (in the script's header):** until Phase 2 completes,
> **`PropertyEntry`/`BuildingUnit` remain authoritative for billing.** `Building`/`Unit`
> are a read-model. Nothing in `fees` may read the new tables in Phase 1. **P2-T8 flips
> this, deliberately and in its own commit.**

#### ⚠️ P1-T7 leaves one thing unfinished, and Phase 2 must close it

A per-unit flag now **validates**. It cannot yet be **persisted**.

`citizens.service.ts:940` maps each unit straight onto `BuildingUnit`, whose
`floor`, `unitType` and `unitArea` columns are `NOT NULL`. A flag blanks the field
it excuses, so a submission carrying `properties.0.units.3.unitArea` passes
validation and then fails at the insert.

Nothing reaches that path today — the only per-unit control in `property-card.tsx`
flags the whole `units` array, and P1 ships no UI — so this is latent, not broken.
But **P3-T3/P3-T6 must not ship a per-unit flag control until it is closed.**

Two ways to close it, to be decided in Phase 2:

- Make those three columns nullable (a migration, and `assessment.ts` reads
  `unitArea` for `PER_AREA` billing, so the fee path needs a decision about what a
  unit with no recorded area is worth); or
- Write the unit into `Unit` instead, where `unitArea` is already nullable, and
  let `BuildingUnit` keep only what it can hold. This is the direction P2-T8 is
  going anyway.

The second is probably right, but it is a Phase 2 call, not a Phase 1 one.

### Phase 2 — Backend services & API

| ID | Task | Acceptance |
|---|---|---|
| P2-T1 | `packages/shared-schemas/src/building.schema.ts` — `createBuildingSchema`, `updateBuildingSchema`, `unitBlueprintSchema` (floors × units-per-floor, or explicit list), `createDamageAssessmentSchema`, `upsertOccupancySchema`. Export from `index.ts` | Schema unit tests |
| P2-T2 | `application/features/buildings/buildings.service.ts` — `list(filter)`, `get(id)`, `create(input)` (with §4.4 suffix allocation in a locked transaction), `update`, `generateUnits(buildingId, blueprint)`, `recomputeCodesForZone(zoneId)` | Service tests incl. concurrent-create allocating distinct suffixes |
| P2-T3 | `application/features/buildings/damage.service.ts` — `record(assessment)`, `currentLevel(buildingId)`, `history(buildingId)` | Latest-row-wins verified |
| P2-T4 | `presentation/controllers/buildings.controller.ts` under `/t/:tenantSlug/buildings`, RBAC-guarded like `zones.controller.ts` | Endpoints reachable; unauthorised roles rejected |
| P2-T5 | Extend `cases.service.ts` + controller: filter by `caseType`, `buildingId`, `unitId`; `SCHEDULED` status; auto-resolve when a `UnitOccupancy` appears on the flagged unit | Existing case tests still pass |
| P2-T6 | New `GET /dashboard/map/buildings` in `reporting.service.ts` — one payload of building pins: `{id, code, name, lat, lng, structureType, surveyRollup, worstDamageLevel, unitsTotal, unitsSurveyed}`. **Rollup uses worst-case (D11)** | Single query, no N+1; snapshot test |
| P2-T7 | **Blanket reason.** Add `blanketFlagReason` to the submission envelope in `admin-citizen.schema.ts`. In `unexcusedIssues`, an issue with no explicit flag is auto-flagged with the blanket reason **only if** its path is flaggable and not in `NON_FLAGGABLE_FIELDS`. Raise `fieldFlagsSchema.max(40)` to 120 for blanket submissions | Submitting name + phone only, with one reason, yields `REQUIRES_REVIEW` with per-field flags each carrying that reason |
| P2-T8 | Switch billing to read `Unit`/`UnitOccupancy` where a link exists, falling back to `PropertyEntry`. **Flip the authority rule from P1-T6 here** and say so in the commit | `fees` tests pass against both linked and unlinked records |

### Phase 3 — Frontend

| ID | Task | Acceptance |
|---|---|---|
| P3-T1 | `lib/api-client.ts` — types + fetchers for buildings, units, occupancies, damage; extend `CaseSummary` | Typecheck |
| P3-T2 | `components/admin/building-editor-dialog.tsx` — zone/parcel picker (auto-fills centroid), auto code preview, name, `postedNumber`, structure type, blueprint generator, mini-map pin picker **rendering `Parcel.boundary`** and refusing a pin outside it | Create a 3-floor / 6-unit building end to end |
| P3-T3 | `components/admin/building-unit-matrix-drawer.tsx` — floor-by-floor grid; per-unit badge (`مسجلة (اسم)` / `شاغرة` / `إعادة زيارة` / `غير ممسوحة`); actions: register occupant, log case, mark vacant, record damage | All four actions work from the matrix |
| P3-T4 | `app/[tenant]/[locale]/[adminPath]/(protected)/buildings/page.tsx` — census ledger, KPI tiles (total, survey %, damaged, unsurveyed units), filters (zone, parcel, survey status, damage level, code/name search) | Filters compose; RTL correct |
| P3-T5 | `fullscreen-map.tsx` — load `parcel-polygons.geojson` (it exists; copy the pattern from `zone-editor-map.tsx:122`); add a building-pins layer. **Three visual channels: icon = structure type, fill = survey rollup, ring = damage level.** Cluster to a parcel dot below the building zoom, showing the parcel's worst status | Multi-building parcels show multiple distinct pins; clicking one opens the matrix drawer |
| P3-T6 | `citizen-form.tsx` — building/unit picker in the property step (locked when launched from the matrix); "حفظ سريع / بيانات ناقصة" one-reason control with presets | Register into a specific unit; quick-save with one reason |
| P3-T7 | `cases/page.tsx` — tabs (All / إعادة زيارة / رفض ونزاعات / ملاحظات), zone+parcel+building filters, quick `OPEN → SCHEDULED → RESOLVED` updater | Tabs filter correctly |
| P3-T8 | Offline: extend the IndexedDB queue for building/unit/case creation; provisional-code badge + post-sync reconciliation notice (§4.4) | Airplane-mode create → reconnect → code reconciled |

### Phase 4 — Field readiness

| ID | Task | Acceptance |
|---|---|---|
| P4-T1 | `unit_visits` table + visit logging from the matrix (`unitId, officerId, visitedAt, outcome`) | "3 attempts" visible on the unit |
| P4-T2 | Damage history panel on the building drawer | Repaired building shows both rows |
| P4-T3 | CSV export for the census ledger, reusing `lib/csv.ts` injection-safe helpers | Export opens clean in Excel with Arabic |
| P4-T4 | Store the council decision (§7 Q1) in `SystemSettings`; print `code` + `postedNumber` on notices | Notice renders both |

---

## 6. Progress log

_Update this table as tasks complete. A fresh session reads it to know where to start._

| Date | Task IDs | Notes |
|---|---|---|
| 2026-09-09 | — | Plan written and approved. No code changes yet. |
| 2026-09-09 | Q1–Q5 | All five open questions answered — see §7. Q2 (tents stay bare `PropertyEntry` cards) is what unblocked P1-T6's scope. |
| 2026-09-09 | **P1-T1 … P1-T7** | **Phase 1 complete.** `pnpm typecheck` clean, `pnpm lint` clean (0 errors; 6 pre-existing warnings), 378 backend tests pass with 64 new ones. Migration `0030_building_census` applied to staging. Details below. |

### What Phase 1 actually changed

**New files**

| File | What it is |
|---|---|
| `packages/shared-schemas/src/numbering.ts` | `parseFloorLabel`, `formatUnitCode`, `buildingSuffixAt`, `nextBuildingSuffix`, `formatBuildingCode`, `formatFullUnitReference`. Pure, no I/O — the backfill, the Phase 2 service and the Phase 3 browser form all need them and none can import each other's runtime. |
| `apps/backend/.../migrations/0030_building_census/migration.sql` | 6 enums, `SCHEDULED` on `CaseStatus`, 4 tables, the links on 4 existing tables, `Parcel.boundary`, `Registration.blanketFlagReason`, and the unit-count trigger. |
| `apps/backend/src/scripts/backfill-buildings.ts` | P1-T6. Dry run by default; `--apply` writes. |
| `apps/backend/src/scripts/backfill-parcel-boundaries.ts` | **Not in the plan.** See "one addition" below. |
| `apps/backend/src/application/features/buildings/numbering.spec.ts` | 53 tests. The directory is where P2-T2's service will live. |

**Changed** — `enums.ts`, `labels.ts` (ar + en), `case.schema.ts`, `field-flag.schema.ts`,
`property.schema.ts`, `index.ts`, `schema.prisma`, `parcel-geometry.ts`,
`parcel-repository.interface.ts`, `parcel.repository.ts`, `cadastre-import.service.ts`,
`import-parcels.ts`, `field-flags.spec.ts`, `apps/backend/package.json`.

**Two changes outside the plan's scope, both flagged rather than quietly folded in:**

1. **`scripts/db/deploy.mjs`** — `pnpm db:deploy:*` was dead on this machine.
   `spawnSync('pnpm.cmd', args)` throws `EINVAL` on Node ≥ 20.12, which hardened
   `.cmd` execution (CVE-2024-27980); the deploy failed with "Registry migration
   could not start" before touching any database. Fixed by passing one command
   string with `shell: true` and **no** args array — which is also what avoids
   the DEP0190 warning the original comment was written to dodge. Without this
   P1-T3's acceptance criterion could not be run at all.

2. **`backfill-parcel-boundaries.ts`** — P1-T4 makes `cadastre:import` write
   outlines as it rebuilds the parcel table, which serves every municipality
   imported from now on and does nothing for the ones already on file: their rows
   predate the column, and re-importing means finding the survey office's original
   KMZ again. The polygons are not lost — they are in `parcel-polygons.geojson` —
   so this reads that asset and writes them onto the rows. Without it
   `Parcel.boundary` would be null everywhere and P3-T2's "refuse a pin outside
   the parcel" would have nothing to check against.

**Also regenerated:** `apps/frontend/public/tenants/albazourieh/parcel-polygons.geojson`
and `city-boundary.geojson`. The committed copies held 1,798 features from an older
tracer; the current one produces 1,806. Verified the Phase 1 edits are **byte-identical**
to the pre-change code on the same input (both assets), so the difference is
pre-existing drift, not something Phase 1 introduced. Leaving it would have had the
browser and the server disagreeing about parcel outlines — exactly the failure P3-T2
turns on.

### Where Phase 2 should start

`P2-T1`. The numbering primitives it would have written already exist in
`numbering.ts` and are tested; `building.schema.ts` still needs the Zod request
shapes. Two things to read first: the **P1-T7 caveat** in §5, and the
**database-state note** in §1 — the census will be filled by field officers
through the Phase 3 UI, not by the backfill.

---

## 7. Open questions — resolved 2026-09-09

All five were answered before Phase 1 began. Kept in full rather than deleted:
each one is a decision with a reason, and the reason is what a later session
needs when someone proposes the opposite.

| # | Question | Answer |
|---|---|---|
| **Q1** | Has the council issued a **قرار مجلس بلدي** adopting this numbering? | **Not yet, and it does not block anything.** Naming public roads and squares needs a council decree (*Decreto-Law 118/1977*), but internal cadastral indexing and parcel-linked building numbering is an administrative and fiscal survey power (*أعمال المسح والتخمين البلدي*) already within municipal executive competence. Treat `ZONE-PARCEL-SUFFIX` as the municipality's internal cadastral survey identifier (الرمز الإحصائي والمسحي للعقار والمبنى). **P4-T4:** let the municipality optionally record `councilDecisionRef` (تاريخ ورقم قرار المجلس البلدي) in `SystemSettings`; with none entered, notices and exports cite the municipal survey authority. |
| **Q2** | Do tents get `Building`/`Unit` rows, or stay bare `PropertyEntry` cards? | **They stay bare `PropertyEntry` cards, and are not backfilled.** Tents (خيم ومآوٍ مؤقتة) have no permanent cadastral footprint, no fixed entrance coordinate and no floor matrix, and they shift across agricultural plots by season. Dummy single-unit shells for each would corrupt building-density statistics, the structural inventory and the war-damage metrics. `TENT_SHELTER` is kept in `StructureType` for the one case that is different: an inspector deliberately mapping a whole settlement or shelter cluster as one entity on a parcel. |
| **Q3** | Is this municipality covered by **NavLeb**? | **No.** NavLeb's 2013 rollout concentrated on Greater Beirut and parts of Mount Lebanon (Metn, Baabda, Keserwan). Albazourieh — البازورية, Tyre District, South Lebanon — was never surveyed or plaqued, and nor were most southern, northern and Bekaa towns. The cadastre-anchored code is therefore the sole uncontested municipal standard. A future Mount Lebanon tenant that *does* have NavLeb plaques records that number in `postedNumber`, which preserves both references without conflict. |
| **Q4** | Is the building code going on **printed receipts** in this release? | **No — deferred to P4-T4.** Receipts (`وصل جباية رسمي`, `payment-receipt.tsx`) currently print the deed parcel number and the citizen reference. Printing building codes now would risk putting a *provisional* offline code (`A-1042-A مؤقت`) into a citizen's hands before the server reconciled it, which compromises the paper's legal standing. P4-T4 adds it once Phase 2 authority and Phase 3 reconciliation are in place, guarded: `if (isProvisional) fall back to parcelNumber`. |
| **Q5** | Confirm the suffix direction rule. | **Confirmed.** Suffix `A` is the structure closest to the primary street frontage / main entrance; `B, C, D…` (skipping `I` and `O`) follow a **clockwise** perimeter sweep of the parcel. Matches Lebanese and UN-Habitat/Cadastre field survey practice, and — the actual requirement — makes two surveyors mapping the same parcel independently produce identical codes. |

---

## 8. Explicitly rejected

Recorded so they are not re-proposed:

- ❌ `ownerCitizenId` / `occupantCitizenId` scalar FKs on the unit → use `UnitOccupancy` (D2).
- ❌ `warDamageStatus` as a mutable enum on `Building` → use `DamageAssessment` (D3).
- ❌ `UNDER_CONSTRUCTION` as a damage level (D5).
- ❌ `WAR_DAMAGE` as a `CaseType` (D6).
- ❌ `zoneId` column on `Building` (D13).
- ❌ Concatenated codes like `A1B2` — ambiguous without delimiters (D7).
- ❌ Rewriting `citizen-form.tsx` from scratch — it would destroy `flaggedFields`,
  `clientSubmissionId` idempotency, the `Case` bridge, and the offline queue. The
  missing piece was a table, not a UI.
- ❌ `turf.polygonize` for cadastre geometry — crashes on this input.
- ❌ Blanket reason *replacing* per-field flags (D12).

---

## 9. Research basis

**Identifier vs address (the core lesson).** UK [UPRN](https://www.geoplace.co.uk/addresses-streets/location-data/the-uprn):
a permanent opaque identifier that stays with the property even when the address changes.
Netherlands [BAG](https://www.voseno.com/blog/understanding-bag-dutch-address-system)
([catalogue](https://geonovum.github.io/bag-IMBAG/)) separates *pand* (building),
*verblijfsobject* (unit) and *nummeraanduiding* (address label) as three linked objects
— which is why D1/D2/D9 are shaped the way they are.

**Numbering schemes.** Sequential odd/even; **metric** (number = metres from street
start) and **decametric**, from the World Bank
[*Street Addressing and the Management of Cities*](https://openknowledge.worldbank.org/server/api/core/bitstreams/4f9d3d73-301d-53b5-8573-493bb2850c55/content)
([summary](https://web.mit.edu/urbanupgrading/upgrading/issues-tools/tools/street-addressing.html));
[block-and-lot parcel identifiers](https://medium.com/parcels-and-land-records/types-of-parcel-identifier-systems-4d458bce7581)
incl. [NYC BBL](https://en.wikipedia.org/wiki/Borough,_Block_and_Lot). Skipping `I`/`O`
and floor-based unit numbering follow institutional numbering standards such as
[Georgia Tech's](https://facilities.gatech.edu/sites/default/files/2023-01/RoomNumbering.pdf).

**Lebanon.** No unified national addressing; [NavLeb's standard was approved in 2013](https://www.beirut.com/en/44330/finally-official-street-addresses-exist-in-lebanon/)
and rolled out municipality-by-municipality (~40 towns). What every municipality does have
is the cadastre — [cadastral zones are the 4th administrative level](https://www.opendatalebanon.org/job/lebanon-cadastral-name-and-pcodes/),
and [Beirut Urban Lab's basemap](https://beiruturbanlab.com/en/Details/666) shows the
building-footprint + lot-number structure. Naming streets and public buildings is a
municipal council competence per the [دليلك للعمل البلدي](https://nclw.gov.lb/wp-content/uploads/2023/05/2023_NCLW_%D8%AF%D9%84%D9%8A%D9%84%D9%83-%D9%84%D9%84%D8%B9%D9%85%D9%84-%D8%A7%D9%84%D8%A8%D9%84%D8%AF%D9%8A.pdf)
(hence Q1). The regional formal precedent for a naming-and-numbering programme is the
[Palestinian MoLG manual](https://www.molg.pna.ps/uploads/files/dalel_867ab37a01824c039cfead69200a7c77.pdf).

**Damage scale (D4).** UN-Habitat rapid building-level assessments:
[Beirut Municipality](https://unhabitat.org/beirut-port-explosions-response-beirut-municipality-rapid-building-level-damage-assessment)
(total collapse / unsafe–evacuate / restricted use / safe–minor damage / unclassified),
[Bourj Hammoud](https://unhabitat.org/beirut-port-explosions-response-bourj-hammoud-municipality-rapid-building-level-damage-assessment),
and the national [Building Destruction and Debris Quantities Assessment](https://unhabitat.org/BDDQA-Lebanon).
