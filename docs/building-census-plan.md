# Building Census, Zone/Building Numbering & War Damage — Implementation Plan

> **Status:** **All five phases complete** (P1-T1 … P5-T3, 2026-09-10).
> The handful of things deliberately not covered are listed under "What is not
> covered" in §6 and §10 — none of them block field use.
> **Created:** 2026-09-09 · **Branch to use:** `feat/building-census` (off `develop`)
> **Owner:** Hashem Nasrallah
>
> Phase 1 was implemented on `update-form` rather than a new branch — nothing is
> committed yet, so the changeset can still be moved wherever it belongs.
>
> **Phase 5 (2026-09-10)** closed the gap Phases 1–4 left: the census could be
> *pointed at* from a registration and nothing ever *acted* on the link. See §10.
> It also added the building lifecycle and the duplicate-structure guard.
> **Subdivision and deed modelling (رقم القسم, مفرز/غير مفرز) is deliberately
> deferred — see §10.5, which is the first thing to read before touching unit
> identity.**

---

## 0. How to use this document

This file is written so a **fresh Claude session with no prior context** can pick up the work.

If you are that session, do this first:

1. Read this whole file.
2. Read [schema.prisma](../apps/backend/src/infrastructure/prisma/tenant/schema.prisma) — the tenant data model.
3. Read [property.schema.ts](../packages/shared-schemas/src/property.schema.ts) and
   [field-flag.schema.ts](../packages/shared-schemas/src/field-flag.schema.ts) — the validation spine.
4. Check §6 "Progress log" to see what is already done. **Every task P1-T1 …
   P5-T4 is complete** — §6 lists every file each phase touched, the decisions
   taken inside them, and what is deliberately not covered. **§10 is Phase 5**
   and is the most recent work; read §10.5 before touching unit identity, and
   §10.8 for what is still open.
5. Read the **database-state note** in §1 before assuming there is data to
   migrate, and the **three decisions inside P2-T8** in §5 before touching
   anything under `features/fees`.
6. The user will tell you which **Phase** and **Task ID** to continue from (e.g. "continue from P3-T2").

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
| Latest migration on disk | `0033_building_lifecycle` (applied to staging; **0032 and 0033 not applied to production**) → next number is `0034` |
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
| D16 | The registration form **writes into the census**, through one shared service, after the registration commits | The link columns existed from 0030 and nothing acted on them. Two doors (form, matrix) must record the same four facts identically, and a census failure must never cost a municipality a registration. See §10.1. |
| D17 | Lifecycle is a **third axis on `Building`**, not a `StructureType` value and not a `DamageLevel` | What a thing *is*, what has *happened to it*, and where it is in its *own life* are independent. Folding any pair together is D5 restated. A shell under construction is excluded from the survey denominator; it is not damaged, and it is not a kind of building. See §10.2. |
| D18 | A second structure on an occupied parcel requires an **explicit acknowledgement**, refused server-side | §4.4's lock solves the opposite problem — it *guarantees* two officers surveying one block from opposite ends get different suffixes, silently. Q5's clockwise sweep is a handbook convention, not a check. See §10.3. |
| D19 | **A building's entrance is placed by a person or not at all** — the parcel centroid is never used as a default pin | The centroid is the middle of the *plot*, where no building stands; offered to every structure on a parcel it produced *byte-identical* coordinates that no clustering rule can separate; and it was stored in the same column as a surveyed fact, so a guess became indistinguishable from one. A building may still be saved with no pin — it then has no dot of its own and its residents draw on the parcel. See §10.4 and §10.6. |
| D20 | **رقم القسم and مفرز/غير مفرز are deferred, not rejected** | They are real and legally superior to both `unitCode` and `postedNumber`, and adding them touches ownership, billing and conflict detection at once. Deferred deliberately rather than half-done. See §10.5. |
| D21 | The staff map keeps **two layers with two grouping rules**: the census layer is one pin per *building*, the registration layer one dot per *parcel* | They answer different questions. P5-T5 made the second match the first and drew a dot on top of every building pin; P5-T7 reverted it. Before changing a marker's grouping, check which layer already answers the question. See §10.6. |
| D22 | **Every raw query writes its schema into its SQL.** Never rely on `search_path`, and never on `current_schema()` | The app reaches Postgres through a transaction pooler, where session settings are not guaranteed to follow a statement. It produced a real 42P01 on a table that exists, once, unreproducibly. Enforced by `raw-sql-is-schema-qualified.spec.ts`. See §10.7. |
| D23 | **Verification builds use their own `distDir`** (`pnpm build:check`) | `next build` and `next dev` share `.next`; building while the dev server runs corrupts it and produces runtime 500s that point at nothing. The frontend twin of the `nest build` EBUSY note in §6. See §10.7. |

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
| P1-T7 | Fix `FLAG_PATH` at `field-flag.schema.ts:79` to accept `properties.N.units.M.<field>`; teach `withoutFlagged` to walk the `units` array | New unit tests in `apps/backend/src/application/features/citizens/field-flags.spec.ts` | ✅ 11 new tests; all 27 pre-existing ones still pass. The write path could not store such a flag when Phase 1 shipped; **migration 0031 closed that in Phase 2** — see below. |

> **P1-T6 authority rule (in the script's header):** until Phase 2 completes,
> **`PropertyEntry`/`BuildingUnit` remain authoritative for billing.** `Building`/`Unit`
> are a read-model. Nothing in `fees` may read the new tables in Phase 1. **P2-T8 flips
> this, deliberately and in its own commit.**

#### ✅ P1-T7's unfinished half — closed by migration 0031

A per-unit flag now validates **and** persists. `P3-T3`/`P3-T6` may ship the
per-unit «غير مؤكَّد» control.

*The gap, as it stood after Phase 1:* `citizens.service.ts` maps each unit
straight onto `BuildingUnit`, whose `floor`, `unitType` and `unitArea` were
`NOT NULL`. A flag blanks the field it excuses, so a submission carrying
`properties.0.units.3.unitArea` passed validation and then failed at the INSERT.
Nothing reached it — the only per-unit control in `property-card.tsx` flags the
whole `units` array — so it was latent rather than broken.

*How it was closed:* **migration `0031_unit_fields_flaggable` makes those three
columns nullable.** The plan leaned toward the other option — write the unit into
`Unit` instead, where `unitArea` is already nullable — and that turned out to be
the wrong one. It makes the *legacy* row the lossy one: the card would describe a
flat whose area lives on a table that, until P2-T8, billing did not read, so a
flat with no area would bill as though it had one.

Nullable columns say the true thing where the code already reads it.
`BillableUnit` has carried `unitArea: number | null` since per-unit billing was
written, and `assessCitizen` already refuses to price a PER_AREA notice against a
unit with no recorded area — it returns the citizen as unassessable, by name,
with a reason the municipality can act on. The `NOT NULL` was what stopped the
honest value from ever reaching that.

**What did not change:** `buildingUnitSchema` still requires all three of an
ordinary submission. The only way to store a null is an `UNESTABLISHED` flag
naming that exact unit field, with a written reason, on a record that lands at
«يتطلب مراجعة». The column is nullable; the form is not.

### Phase 2 — Backend services & API — ✅ **complete 2026-09-09**

| ID | Task | Acceptance | Result |
|---|---|---|---|
| P2-T1 | `building.schema.ts` — create/update, `unitBlueprintSchema`, `createDamageAssessmentSchema`, `upsertOccupancySchema` | Schema unit tests | ✅ Also `upsertUnitSchema`/`updateUnitSchema`, `endOccupancySchema` and `buildingFilterSchema` — the controller needed request shapes for the matrix and the ledger, and a hand-rolled `@Query` parse beside a Zod one is how the two drift. 27 tests. |
| P2-T2 | `buildings.service.ts` — `list`, `get`, `create` (§4.4 locked suffix allocation), `update`, `generateUnits`, code recompute | Service tests incl. **concurrent-create allocating distinct suffixes** | ✅ **6 simultaneous creates on one parcel → A,B,C,D,E,F**, against a real Postgres. Serialised by a transaction-scoped advisory lock keyed on `current_schema() || parcel` — namespaced because tenant schemas share a database. |
| P2-T3 | `damage.service.ts` — `record`, `currentLevel`, `history` | Latest-row-wins verified | ✅ Verified with a 2024 `UNSAFE_EVACUATE` and a 2026 `SAFE_MINOR_DAMAGE`: current reads the repair, history keeps both. Ordered by `assessedAt`, not `createdAt` — an assessment typed up a week late describes the visit, not the paperwork. |
| P2-T4 | `buildings.controller.ts` under `/t/:tenantSlug/buildings`, RBAC-guarded | Endpoints reachable; unauthorised roles rejected | ✅ Reads open to all six staff roles; writes to the four field/administrative ones (matching `CasesController`, not `ZonesController` — creating a building and logging a case are the same afternoon's work); delete SUPER_ADMIN only. |
| P2-T5 | Cases: filter by `caseType`/`buildingId`/`unitId`; `SCHEDULED`; auto-resolve on occupancy | Existing case tests still pass | ✅ Auto-resolve lives in `recordOccupancy` — the moment the thing the case was waiting on happened. Only cases pinned to that exact `unitId`; a case carrying free-text «الطابق الثاني» is **not** resolved, because nothing can tell which of that floor's four flats was meant. |
| P2-T6 | `GET /dashboard/map/buildings` with worst-case rollup (D11) | Single query, no N+1; snapshot test | ✅ Three queries total whatever the municipality's size — buildings, a `groupBy` over unit statuses, one `DISTINCT ON` for current damage. Verified: 2 of 3 units surveyed still reports `NOT_SURVEYED`. |
| P2-T7 | Blanket reason auto-filling unexcused issues, ceiling raised to 120 | Name + phone only, one reason → `REQUIRES_REVIEW` with per-field flags each carrying it | ✅ 9 tests. See the note below on what "name + phone only" can actually mean. |
| P2-T8 | Billing reads `Unit`/`UnitOccupancy` where linked, falls back to `PropertyEntry` | `fees` tests pass against **both** linked and unlinked records | ✅ Both halves tested. **The authority rule from P1-T6 is now flipped.** |

> **The authority rule, as of P2-T8:** where a `BuildingUnit` is linked to a
> canonical `Unit`, the `Unit` wins — **field by field**, not row by row. Where
> there is no link, `PropertyEntry`/`BuildingUnit` still decide, and that is
> permanent rather than transitional: a منزل, an أرض and a خيمة never get a
> `Unit`, and neither does a building on a parcel nobody has surveyed.

#### Three decisions inside P2-T8 worth knowing before touching billing

1. **Per field, not per row.** A generated matrix row has no مساحة; the card it
   was linked to may. Taking the whole canonical row would discard a
   measurement the register already holds and make the citizen unassessable
   under a PER_AREA notice.
2. **Occupancy still comes from the card, never from `UnitOccupancy`.** That
   table records every party to a flat at once — an owner abroad and the tenant
   living in it are two rows on one unit, which is why it is a join table (D2).
   Reading a role from it would require already knowing which of the two is
   being billed, and the answer is on the card the line came from.
3. **A مبنى card with no unit rows is answered from `UnitOccupancy`.** This one
   went through two wrong shapes before the right one, and all three are
   recorded because the wrong ones are tempting.

   **First attempt — relax the guard when the building has a matrix. Reverted.**
   The flats *are* known, so why refuse? Because the assessment does not need
   "does this building have units", it needs **which of them does this citizen
   hold**, and a matrix of twelve flats says nothing about whether this person
   holds one or twelve. Worse, `billableUnits` does not *skip* a BUILDING card
   that is not `isUnsurveyed` — it returns a single unit built from the card's
   own null fields, so the relaxation would bill an entire block as one flat and
   a `PER_UNIT` rate would multiply by it without a murmur.

   **Second attempt — refuse, and defer.** Correct but incomplete: the
   municipality got a named, actionable refusal instead of a quiet wrong number,
   and the citizen went unbilled.

   **What is implemented — `heldThroughOccupancy`.** The question is
   per-citizen, so it is answered by the only per-citizen table:
   `UnitOccupancy`. A BUILDING card that itemises nothing now bills exactly the
   flats this citizen is currently recorded in — no more, and never inferred
   from the building's own count. Three things keep it honest:

   - **The role comes from the occupancy row here, and only here.** That is not
     a contradiction of (2) above but its complement: a *card's* unit rows carry
     no role of their own, so they take the card's. These rows do carry one, and
     they are selected by citizen, so an owner abroad and the tenant living in
     their flat are two rows on one unit and each person gets their own.
   - **Card rows win when both exist.** A card that itemises its flats is the
     citizen's own statement; the occupancies describe the same flats from the
     municipality's side. Counting both would bill a landlord twice.
   - **BUILDING cards only.** A منزل keeps its single unit on the card, so "no
     unit rows" is its normal shape, not a gap.

   An empty occupancy list still refuses, and correctly: the census may know the
   building well and know nothing about this citizen's place in it. Target
   selection was widened to match, deliberately as a *superset* — reproducing
   the rule in SQL would be a second copy that drifts, and over-selecting is
   free while under-selecting is a resident silently never billed.

   > **Proved against a real database**, in
   > `fees/billing-census.integration.spec.ts`. Half of this change exists only
   > as a Prisma `select`, and a join that names the wrong relation or filters
   > the wrong way produces a bill that is quietly wrong while every unit test
   > still passes. The spec goes through `issue()` rather than the assessment in
   > isolation, so it also covers `resolveTargets` — a citizen assessed
   > correctly but never *selected* is the silent under-billing the superset
   > exists to prevent, and it now fails here instead of in production. Eight
   > cases: the linked unit outranking a stale card line, the per-field
   > fallback, flats held only through occupancy, a moved-out tenant ignored,
   > the bearer decision taken per occupancy role, the landlord double-count
   > refused, an unsurveyed building refused *with its reason*, and a محل
   > reachable only through the matrix still being billed.

#### P2-T7: what "name + phone only" can actually mean

The acceptance criterion is met, with one correction to its wording. `isLebanese`
is in `NON_FLAGGABLE_FIELDS` alongside `firstName`/`lastName`, so **no** flag —
blanket or explicit — can excuse it, and a submission of literally name + phone
fails on it. The true minimum is name + `isLebanese` + phone, and from there one
reason fills in every remaining gap. That is the design working, not a gap in it:
the three discriminators decide which fields the record even has, so there is
nothing to flag against without them.

Two limits on what the blanket reason may cover, both load-bearing:

- **Only flaggable paths** — it cannot supply a surname or a discriminator.
- **Only fields that are actually empty.** A value that was entered and is
  *invalid* — a malformed phone, an area of `"abc"` — is a typo to correct, not
  missing data to excuse. Auto-flagging it would blank what the officer typed and
  hide the mistake behind a reason that does not describe it, leaving a household
  unreachable under a note saying nobody was home. Those still fail.

An officer's own reason on a field always wins; the blanket one is a default.

### Phase 3 — Frontend

| ID | Task | Acceptance | Result |
|---|---|---|---|
| P3-T1 | `lib/api-client.ts` — types + fetchers for buildings, units, occupancies, damage; extend `CaseSummary` | Typecheck | ✅ All eleven endpoints, `CaseSummary` extended with the census links and `SCHEDULED`. Also `getZoneParcelIndex` — the editor's code preview needs a parcel→sector answer and no endpoint gives one. |
| P3-T2 | `components/admin/building-editor-dialog.tsx` — zone/parcel picker (auto-fills centroid), auto code preview, name, `postedNumber`, structure type, blueprint generator, mini-map pin picker **rendering `Parcel.boundary`** and refusing a pin outside it | Create a 3-floor / 6-unit building end to end | ✅ Pin refused outside the parcel via `pointInGeometry`; a parcel with no traced outline is treated as unverifiable rather than rejected. A 3-floor / 6-unit building is the form's own defaults. Mapbox loads inside the picker's effect, so the page first-loads at 254 kB without it. |
| P3-T3 | `components/admin/building-unit-matrix-drawer.tsx` — floor-by-floor grid; per-unit badge (`مسجلة (اسم)` / `شاغرة` / `إعادة زيارة` / `غير ممسوحة`); actions: register occupant, log case, mark vacant, record damage | All four actions work from the matrix | ✅ All four, plus building-level damage, the condition log and ending a tenancy. `casesResolved` is surfaced in the toast. |
| P3-T4 | `app/[tenant]/[locale]/[adminPath]/(protected)/buildings/page.tsx` — census ledger, KPI tiles (total, survey %, damaged, unsurveyed units), filters (zone, parcel, survey status, damage level, code/name search) | Filters compose; RTL correct | ✅ Filters compose and are server-side; tiles are aggregated over the filtered predicate, not the page. **Exposed three defects in P2-T2's `list` — see below.** RTL: logical properties only; `dir="ltr"` on codes, coordinates and numbers. |
| P3-T5 | `fullscreen-map.tsx` — load `parcel-polygons.geojson` (it exists; copy the pattern from `zone-editor-map.tsx:122`); add a building-pins layer. **Three visual channels: icon = structure type, fill = survey rollup, ring = damage level.** Cluster to a parcel dot below the building zoom, showing the parcel's worst status | Multi-building parcels show multiple distinct pins; clicking one opens the matrix drawer |  ✅ Three layers over one source, so a building can read *surveyed* and *unsafe* at once. Icons drawn on a canvas, not font glyphs — a missing glyph renders nothing, silently. The parcel aggregate below zoom 16.5 takes the **worst** status (D11) and zooms in rather than opening. Clicking a pin opens the same matrix drawer the ledger opens. |
| P3-T6 | `citizen-form.tsx` — building/unit picker in the property step (locked when launched from the matrix); "حفظ سريع / بيانات ناقصة" one-reason control with presets | Register into a specific unit; quick-save with one reason |  ✅ Needed the census link threaded through six layers — the columns existed since 0030 and **nothing could set them**. `getCitizenForm` returning it is the half that would have been forgotten: without it, editing a phone number silently unlinks the building. 7 tests. Quick save sends `blanketFlagReason`, create-only. |
| P3-T7 | `cases/page.tsx` — tabs (All / إعادة زيارة / رفض ونزاعات / ملاحظات), zone+parcel+building filters, quick `OPEN → SCHEDULED → RESOLVED` updater | Tabs filter correctly |  ✅ Tabs group the types an officer does the same thing about, not one per enum value. Filtering is client-side so the conversion strip keeps meaning «the register's rate». Status is a cycle `OPEN → SCHEDULED → RESOLVED`, labelled by where the tap goes. |
| P3-T8 | Offline: extend the IndexedDB queue for building/unit/case creation; provisional-code badge + post-sync reconciliation notice (§4.4) | Airplane-mode create → reconnect → code reconciled |  ⚠️ Implemented, **not exercised end to end** — see the note in §6. `DB_VERSION` → 2 with a second store; buildings drain **before** registrations, because a queued registration may name a queued building. A reconciled code is *kept* until a person dismisses it. |

### Phase 4 — Field readiness

| ID | Task | Acceptance | Result |
|---|---|---|---|
| P4-T1 | `unit_visits` table + visit logging from the matrix (`unitId, officerId, visitedAt, outcome`) | "3 attempts" visible on the unit | ✅ Migration `0032`. `outcome` reuses `SurveyStatus` rather than declaring a fourth vocabulary (D15), minus `NOT_SURVEYED` — which means nobody went. One action records the visit *and* moves the unit. `officerId` is `SetNull`: a visit stays true after the officer leaves. 5 tests, including the three-attempt count and deleting the officer. |
| P4-T2 | Damage history panel on the building drawer | Repaired building shows both rows | ✅ Newest badged «الحالي», and every row names whether it describes the building or one unit — without that, "top floors gone, ground-floor shop trading" reads as a contradiction. |
| P4-T3 | CSV export for the census ledger, reusing `lib/csv.ts` injection-safe helpers | Export opens clean in Excel with Arabic | ✅ The injection-safe helper did not exist in `lib/csv.ts` and was added (`escapeCell` has no formula guard). Exports the filtered set by paging the ledger's own endpoint. **Verified by executing `buildCsv`** — BOM, `'`-prefixing of `=`/`@`/`-`, doubled quotes, quoted comma cells. |
| P4-T4 | Store the council decision (§7 Q1) in `SystemSettings`; print `code` + `postedNumber` on notices | Notice renders both | ✅ `councilDecisionRef` through schema, service, settings UI and receipt. The footer cites the decision where one exists and the municipal survey authority where none does. Needed `buildingCode`/`postedNumber` on the citizen profile — there was nothing to print. |

---

## 6. Progress log

_Update this table as tasks complete. A fresh session reads it to know where to start._

| Date | Task IDs | Notes |
|---|---|---|
| 2026-09-09 | — | Plan written and approved. No code changes yet. |
| 2026-09-09 | Q1–Q5 | All five open questions answered — see §7. Q2 (tents stay bare `PropertyEntry` cards) is what unblocked P1-T6's scope. |
| 2026-09-09 | **P1-T1 … P1-T7** | **Phase 1 complete.** `pnpm typecheck` clean, `pnpm lint` clean (0 errors; 6 pre-existing warnings), 378 backend tests pass with 64 new ones. Migration `0030_building_census` applied to staging. Details below. |
| 2026-09-09 | **P2-T1 … P2-T8** | **Phase 2 complete.** `pnpm typecheck` clean, `pnpm lint` clean (0 errors; 6 pre-existing warnings). **The whole suite is green with a database attached: 27 suites, 477 tests, 0 failures** — 427 unit tests plus 50 across the four integration suites, run together. Migration `0031_unit_fields_flaggable` applied to staging. Details below. |
| 2026-09-09 | **P3-T1 … P3-T4** | **Phase 3 frontend half done.** `pnpm typecheck` clean, `pnpm lint` clean (0 errors; the same 6 pre-existing warnings), `next build` clean. **The whole suite is green with a database attached: 27 suites, 485 tests, 0 failures** — the 8 new ones cover the ledger's `list`, which had no coverage at all and turned out to carry three defects. No migration. Details below. |
| 2026-09-09 | **P3-T5 … P4-T4** | **Phases 3 and 4 complete.** `pnpm typecheck` clean, `pnpm lint` clean (0 errors; the same 6 pre-existing warnings), `next build` clean. **The whole suite is green with a database attached: 28 suites, 497 tests, 0 failures** — 12 new, covering unit visits and the census link on a property card. Migration `0032_unit_visits` applied to staging. Details below. |
| 2026-09-10 | **P5-T1 … P5-T5** | **Phase 5 complete — see §10.** Closes the gap Phases 1–4 left: the census could be *pointed at* from a registration and nothing acted on the link, which was a silent under-billing path as well as a blank matrix. Also adds `Building.lifecycleStatus` (migration `0033`, applied to staging), the duplicate-structure guard, and — P5-T5 — **one map marker per censused structure instead of one per parcel**, with the parcel-centroid pin guess removed entirely. `pnpm typecheck` clean, `pnpm lint` clean (0 errors; the same 6 pre-existing warnings), `next build` clean. **29 suites, 526 tests, 0 failures with a database attached.** Subdivision/deed modelling (رقم القسم, مفرز) deliberately deferred — §10.5. |
| 2026-09-10 | **P5-T6** | **Hardening, from a real dev-server log — see §10.7.** Three faults: a genuine 42P01 on staging traced to raw SQL depending on `search_path` behind the transaction pooler (every raw query is now schema-qualified, including the §4.4 advisory-lock key, with a guard test that reads the table list from `schema.prisma`); the dashboard cache never invalidating on `building.changed`, which froze the map's markers for the whole TTL after P5-T5 moved them onto building pins; and `next build` sharing `.next` with a running `next dev` (`pnpm build:check` now isolates it). **30 suites, 0 failures with a database attached.** |
| 2026-09-10 | **P5-T7** | **Reverted P5-T5 — see §10.6.** The staff map already has a census layer drawing a pin per building at its own entrance, so splitting the *registration* markers per structure put a second dot on top of each of them. Registration markers are one per رقم العقار again, at the parcel's point, with every household on the plot under them; `computeSpatialData` reverted with it. Also gave the integration suites' schema build **and teardown** a realistic timeout — a 60s budget for replaying thirty-odd migrations over a remote link was failing whole suites on a slow connection while every test in them passed. |
| 2026-09-09 | — | **`pnpm --filter @mechanization/backend build` cannot be run while `pnpm dev` is up**, and this is environmental rather than a code fault. `nest build` copies the Prisma query-engine `.node` binaries into `dist/`, and a backend already serving from `dist/presentation/main` holds them open — Windows refuses the overwrite with `EBUSY`. `scripts/start.mjs`'s `cleanupStaleProcesses()` exists for exactly this and says so. To verify a build independently, emit somewhere else: `pnpm exec tsc -p tsconfig.json --outDir <tmp>` from `apps/backend`, which compiles and emits the whole backend without touching `dist/`. `pnpm typecheck` covers the same ground for correctness. |

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

### What Phase 2 actually changed

**New files**

| File | What it is |
|---|---|
| `packages/shared-schemas/src/building.schema.ts` | P2-T1. Create/update, unit blueprints, per-unit upsert, damage, occupancy, and the ledger's filter. |
| `apps/backend/.../buildings/building.types.ts` | The census's row shapes. A types module rather than a repository port — see its header for why the service reads Prisma directly. |
| `apps/backend/.../buildings/buildings.service.ts` | P2-T2 + P2-T6. Suffix allocation under an advisory lock, the unit matrix, occupancy, code recomputation, map pins, and the `rollupOf` worst-status ladder. |
| `apps/backend/.../buildings/damage.service.ts` | P2-T3. Append-only, plus the `damageSeverity` ladder the rollup uses. |
| `apps/backend/.../controllers/buildings.controller.ts` | P2-T4. |
| `apps/backend/.../buildings/buildings.spec.ts` | 27 tests — the rollup and damage ladders, and every schema. |
| `apps/backend/.../buildings/buildings.integration.spec.ts` | 18 tests against a real Postgres. Gated on `TEST_DATABASE_URL`, like the ledger and backup suites. |
| `apps/backend/.../citizens/blanket-reason.spec.ts` | 9 tests. P2-T7's acceptance case and its two limits. |
| `apps/backend/.../migrations/0031_unit_fields_flaggable/` | Closes P1-T7's unfinished half. |

**Changed** — `case.schema.ts`, `admin-citizen.schema.ts`, `index.ts`,
`schema.prisma`, `case-repository.interface.ts`, `case.repository.ts`,
`cases.service.ts`, `cases.controller.ts`, `zones.service.ts`,
`dashboard.controller.ts`, `billable-unit.ts`, `fees.service.ts`,
`registration.service.ts`, `registration-repository.interface.ts`,
`registration.repository.ts`, `citizens.service.ts`, `reporting.service.ts`,
`staff.service.ts`, `backup.service.ts`, both modules, `assessment.spec.ts`.

**Three changes outside the task list, all flagged rather than folded in quietly:**

1. **`ZonesService` now calls `recomputeCodesForParcels` on every write.** P2-T2
   asked only for the method. Without a caller it is dead code and the bug it
   exists for stays live: a building's code is `ZONE-PARCEL-SUFFIX` and the zone
   half is resolved from `Zone.parcelNumbers` rather than stored (D13), so
   renaming a sector silently orphans every code printed on a notice under the
   old one. Called on the **union** of the parcels before and after an edit — a
   parcel moved *out* needs rebuilding too, and is no longer in the list to find
   it by. Failures are logged, not thrown: the zone edit has already committed
   and is correct, and reporting a successful save as a failure invites the
   admin to make it twice.

2. **`payment-ledger.integration.spec.ts` got a suite-level timeout.** Running
   the database-backed suites turned up two failures in it, both
   `Exceeded timeout of 5000 ms` — jest's default is a budget for a local
   socket, and **there is no local Postgres in this project**: `TARGETS.local`
   points at hosted staging, so a reversal test doing four round trips overran
   it. Pre-existing and nothing to do with Phase 2 — the same spec's `beforeAll`
   already carried a 60s timeout and its `it`s did not, and the backup suite
   sets 60s on every test for exactly this reason. Fixed with one
   `jest.setTimeout(60_000)`, matching what `buildings.integration.spec.ts`
   does.

   > **If the DB-backed suites ever fail together again, read this first.**
   > They did, during Phase 2, and the cause was not what it looked like. Every
   > suite passed alone; two passed together; all three "failed to run". It was
   > timeout pressure, not a defect and not a connection cap — the buildings
   > suite took **239s in the failing run and 70s in the passing one**, against
   > the same hosted database. Two things were inflating it: source files being
   > edited while jest was running, and the ledger timeout above still being
   > unfixed. With both settled, all three pass together (42/42).
   >
   > **Both standing risks noted here have since been closed.**
   >
   > *Connection pooling.* All three specs now build their client through
   > `tenantTestClient`, which pins `connection_limit=5`. They previously used
   > `TEST_DATABASE_URL` raw — the direct, session-mode string, carrying no
   > limit — so Prisma fell back to `num_cpus * 2 + 1`, seventeen session
   > connections per suite against hosted staging.
   >
   > **Not 1**, which is the obvious number and would have quietly gutted the
   > suite: half the reason these specs need a real Postgres is to prove that
   > simultaneous writers are serialised *by the database* (the advisory lock
   > behind suffix allocation, the row lock behind the ledger). Prisma queues
   > transactions when its pool is exhausted, so a pool of one serialises them
   > in the client and every such test passes without ever contending. Five
   > leaves the largest of them — six concurrent creates — genuinely fighting
   > over the lock.
   >
   > *And one that is neither of the above.* A later full run had the ledger and
   > backup suites fail with `Can't reach database server` and `Connection
   > terminated unexpectedly`, the ledger taking **201s against its usual ~41s**.
   > That is the hosted pooler dropping connections, not a defect: the same two
   > suites passed on an immediate retry, unchanged. `TEST_DATABASE_URL` is the
   > *session* pooler (`…pooler.supabase.com:5432`), which is shared with
   > everything else pointed at staging and is entitled to refuse. If these
   > suites fail with a connectivity error rather than an assertion, re-run
   > before changing anything — and note the durations, because a suite that is
   > five times slower than usual is reporting the network, not the code.
   >
   > *Per-test cleanup.* `buildings.integration.spec.ts` no longer wipes seven
   > tables before each test; the three assertions that needed a clean table are
   > scoped to the rows their own test created, which is the better assertion
   > anyway — a test that passes only while it is alone in the file is one
   > refactor from lying. Worth recording honestly: the predicted speed-up did
   > **not** materialise (72s before and after). `deleteMany` against near-empty
   > tables is cheap, and the suite's cost is round-trip latency in the tests'
   > own work. The change was worth making for independence, not for time.

3. **`backup.service.ts` gained the census tables and `case`.** Their absence
   was not a missing feature, it was silent data loss:
   `unit_occupancies.citizenId` cascades from `users`, and a restore deletes and
   rewrites every user — so it destroyed every record of who lives where and
   then did not put it back. `case` has had the same hole since 0027 and is
   fixed here rather than separately, because a case now points at a building, a
   unit and a damage assessment and cannot be ordered correctly except alongside
   them. Verified with the existing backup round-trip suite against a real
   database.

### What Phase 3 changed so far (P3-T1 … P3-T4)

**New files**

| File | What it is |
|---|---|
| `apps/frontend/components/admin/building-editor-dialog.tsx` | P3-T2. Parcel field → debounced lookup of the outline, the sector, the taken suffixes and the cadastre; live code preview badged «مؤقت»; structure type, name, `postedNumber`, floors, notes; a satellite pin picker drawing the parcel outline; and the blueprint generator in both its shapes. |
| `apps/frontend/components/admin/building-unit-matrix-drawer.tsx` | P3-T3. Floors top-down, a cell per unit with its badge, and the four actions on the selected one — plus building-level damage, the condition log, and ending a tenancy. |
| `apps/frontend/app/[tenant]/[locale]/[adminPath]/(protected)/buildings/page.tsx` | P3-T4. The ledger: four KPI tiles, five composing filters, a server-paginated table, and the two dialogs above. |

**Changed** — `apps/frontend/lib/api-client.ts` (P3-T1), `lib/map-geometry.ts`,
`components/admin/nav.ts`, and on the backend `buildings.service.ts`,
`building.types.ts`, `buildings.integration.spec.ts`.

#### P3-T1 — what the client speaks

Every census shape, with `Date`s typed as the ISO strings JSON actually
delivers, plus fetchers for all eleven endpoints. `CaseSummary` gained
`caseType`, `buildingId`/`buildingCode`, `unitId`/`unitCode`,
`damageAssessmentId` and `scheduledRevisitAt`; its `status` widened to include
`SCHEDULED`; and `getCases` now takes the three census filters. One addition
beyond the task: **`getZoneParcelIndex`**, built from the sector list plus one
read per sector and cached five minutes. There is no parcel→sector endpoint to
ask (D13), and the zone half of `ZONE-PARCEL-SUFFIX` is the only part of a code
the editor cannot derive from what it already has.

#### P3-T2 — the pin is refused, not warned about

`pointInGeometry` in `lib/map-geometry.ts` is even-odd ray casting, planar
rather than geodesic: over a parcel a few hundred metres across the difference
is far below the survey's own precision, and this runs on every drag of a
marker. It handles a `Polygon`'s holes and a `MultiPolygon`'s several pieces —
six of this cadastre's parcels were surveyed as disconnected fragments.

Three decisions inside it worth keeping:

- **A parcel with no traced outline is "unverifiable", not "outside".** About
  1.4% of parcels here are faces the tracer could not close. Refusing every
  building on them would make them permanently uncensusable over a gap in the
  geometry, so the map says so plainly and the check stands down.
- **The auto-filled entrance is a bounding-box centre, tested before it is
  offered.** A true area centroid falls outside an L-shaped parcel, and a pin
  the form's own check then refuses is worse than no pin at all.
- **A pin belongs to the parcel it was placed on** (`pinParcelRef`). Correct the
  parcel from 1042 to 1043 and the dot left behind is the neighbour's entrance —
  it is replaced, not kept.

Mapbox is imported inside the picker's effect rather than at the top of the
module. The dialog therefore renders on the server and `/buildings` first-loads
at 254 kB with the map bundle fetched only by someone who opened the form.

**Acceptance met:** a 3-floor / 6-unit building is `fromFloor 0, toFloor 2,
unitsPerFloor 2` — the form's own defaults, and the count is stated before it
is committed. The shell is created first and the matrix generated second, on
purpose: a mistyped blueprint must not cost the officer the building, and
`generateUnits` is idempotent per floor so it can simply be run again.

#### P3-T3 — the grid is the point

A list of units sorted by code says nothing a table could not; a floor-by-floor
elevation says *where the gaps are*, which is the shape of the next visit.
Occupancy outranks survey status on a cell badge because the occupant's name is
the most useful thing the cell can carry, and «غير ممسوحة» is left untinted
rather than amber — on a freshly generated matrix every cell is that, and a wall
of amber says nothing.

Two side effects are deliberate and narrow:

- **Marking vacant** sets `surveyStatus: VACANT_CONFIRMED` *and*
  `unitStatus: VACANT`. They answer different questions and the officer answered
  both.
- **Logging an `UNIT_UNREACHABLE` case** lifts a `NOT_SURVEYED` unit to
  `VISITED_NO_ANSWER`, and only from that one state. A unit already carrying a
  finding — vacant, demolished, refused — keeps it; a contradiction is for a
  person to resolve, not for a side effect to overwrite. This mirrors the rule
  `recordOccupancy` already applies server-side.

`casesResolved` is surfaced in the toast rather than absorbed, for the reason
§5 gives: silently closing someone else's dispatch item is how a case list stops
being believed.

#### P3-T4 — and the three backend gaps it exposed

The ledger is server-paginated with five composing filters and four tiles. The
tiles are computed by the server over the whole filtered predicate, not the page
— a tile that quietly described the first twenty-five rows would read as a
statement about the municipality and be one about the pagination.

Building it turned up **three defects in P2-T2's `list`, all fixed here and all
flagged rather than folded in quietly.** Each one blocked P3-T4's stated
acceptance, so none of them could be left for later:

1. **The sector filter did nothing.** `buildingFilterSchema` has accepted
   `zoneId` since P2-T1, but `BuildingListFilter` carries `parcelNumbers` and
   `buildWhere` never read `zoneId` — and TypeScript let the extra property
   through, because the controller passes a variable rather than an object
   literal. «القطاعات» was a select that returned the unfiltered census.
   `buildWhere` now expands the sector into its parcels (D13 leaves no column to
   filter on) and **ANDs** the clause rather than assigning it, so a sector and
   an explicit parcel narrow each other instead of one silently winning. A
   sector owning no parcels matches nothing, which is the true answer.

2. **The damage filter was applied to the page after it came back.** So it
   filtered *within* the page: a hundred-row page holding four unsafe buildings
   showed four rows beneath a total in the thousands, and page two showed four
   different ones beneath the same number. It is now resolved into the `WHERE`,
   so `total`, the rows and the tiles describe one set.

   > **This is the one a test caught rather than a reading.** The first version
   > of the fix removed the post-page filter and added the summary count without
   > adding the predicate — `damageLevel` then matched *everything*, silently,
   > and both typecheck and the whole unit suite stayed green. It failed on
   > `filters on the current damage level, and narrows total with it` the first
   > time that spec ran.

3. **The ledger had no damage column and no sector column to show.** `list` now
   returns `zoneCode`, `zoneName` and `damageLevel` per row (`BuildingLedgerRow`)
   and a `CensusSummary` beside them, resolved once per page by `zonesOfParcels`
   — one read of the sector table rather than one per row, since
   `Zone.parcelNumbers` is an array column that cannot be joined.

**`buildingIdsAtCurrentLevel` is composed from `currentDamageLevels`, not
written again.** It was a hand-written `DISTINCT ON` first, and that was the
wrong instinct: "the current level" is a query that already exists and is
already proved against a real Postgres, and a second copy of it would agree with
the first until somebody changed one — after which the one that lied is the one
a damage figure is read off. The cost is one extra round trip to collect the
candidates, bounded by the number of buildings anyone has *assessed* rather than
by the census.

**One more thing worth stating, because the natural reading is the other one:**
a survey-status filter selects buildings with **at least one** unit in that
state, not buildings entirely in it — one unanswered flat is what sends an
officer back and must not hide behind eleven surveyed ones (D11). The page says
so under the table whenever that filter is on.

#### Also changed, and why

- **`components/admin/nav.ts`** gained «سجل المباني» between the map and the
  sectors — the census is what the map draws pins from and what a sector is
  ultimately a count of. Open to all six staff roles, matching
  `BuildingsController`'s read set: a collector needs a building's code to find
  a door as much as an inspector needs it to survey one. Without this the page
  existed at a URL nothing linked to, and `canAccessPath` would have treated it
  as a 404-shaped unknown rather than a section.
- **Two text filters are debounced (350 ms)** — the ledger's parcel box and the
  editor's parcel field. A select fires once per decision; a text field fires per
  keystroke, and «1042» typed at speed is four lookups of which three are about
  parcels 1, 10 and 104. In the editor those three would each briefly paint a
  code and a boundary for the wrong plot.

#### What is not covered

There is **no test runner in `apps/frontend`** — no jest, no vitest, no spec
files anywhere under it. So `pointInGeometry`, `geometryBounds` and
`geometryCenter` ship with no unit tests, and they are pure functions that
deserve them. Standing up a frontend test setup is its own task and was not
folded into this one; the eight new backend tests cover the ledger's server
half, and the three components were verified by `tsc`, `eslint` and a production
build only.

### What P3-T5 … P4-T4 changed

**New files**

| File | What it is |
|---|---|
| `apps/frontend/components/admin/building-map-layer.ts` | P3-T5's three channels, the parcel rollup, and the six structure icons — pure functions of the pins, kept out of `fullscreen-map.tsx`'s 1,900 lines. |
| `apps/frontend/components/admin/building-unit-picker.tsx` | P3-T6. Ties one property card to a censused structure, and lets the officer tick which of its flats this citizen holds. |
| `apps/frontend/components/admin/quick-save-dialog.tsx` | P3-T6's «حفظ سريع / بيانات ناقصة» — five presets and the three limits stated where the decision is made. |
| `apps/frontend/components/admin/building-queue-notice.tsx` | P3-T8's provisional-code strip and the post-sync reconciliation notice. |
| `apps/backend/.../migrations/0032_unit_visits/` | P4-T1's table and P4-T4's `councilDecisionRef`. Applied to staging. |
| `apps/backend/.../citizens/census-link.spec.ts` | 7 tests on the field most likely to be lost silently — see P3-T6 below. |

**Changed** — frontend: `fullscreen-map.tsx`, `citizen-form.tsx`, `citizen-editor.tsx`,
`property-card.tsx`, `building-unit-matrix-drawer.tsx`, `building-editor-dialog.tsx`,
`payment-receipt.tsx`, `settings/profile-section.tsx`, `cases/page.tsx`,
`buildings/page.tsx`, `map/page.tsx`, `citizens/new/page.tsx`, `citizens/[citizenId]/page.tsx`,
`fees/page.tsx`, `fees/payments/[paymentId]/settle/page.tsx`, `lib/api-client.ts`,
`lib/csv.ts`, `lib/offline-db.ts`, `lib/offline-sync.ts`, `lib/settings-i18n.ts`.
Backend: `schema.prisma`, `buildings.service.ts`, `building.types.ts`,
`buildings.controller.ts`, `citizens.service.ts`, `reporting.service.ts`,
`fees.service.ts`, `backup.service.ts`, `registration.repository.ts`,
`property-entry.entity.ts`, `buildings.integration.spec.ts`. Shared:
`property.schema.ts`, `admin-citizen.schema.ts`, `building.schema.ts`, `fee.schema.ts`.

#### P3-T5 — why three layers rather than one styled dot

The plan asks for icon, fill and ring as separate channels, and they are three
Mapbox layers over one source rather than one cleverly styled layer. That is
what makes them independent: a building can be **fully surveyed and unsafe to
enter**, and a reader has to see both facts at once. Collapsing them into a
single paint expression would force a precedence between two things that do not
have one.

Four decisions inside it:

- **The icons are drawn on a canvas at runtime**, not glyphs in a `text-field`.
  `icon-image` needs an image, and the tempting alternative — a box-drawing
  character in Mapbox's hosted font — renders *nothing at all* where the glyph
  is missing, silently. A purely visual channel is the one that can least afford
  that failure mode, so the browser that will display the icon also draws it.
- **No ring means nobody has assessed it**, and that is not the same statement
  as `NOT_AFFECTED`. Unassessed draws `rgba(0,0,0,0)`; a grey ring would be
  indistinguishable from `UNCLASSIFIED`, which means somebody looked and could
  not classify it.
- **The parcel aggregate takes the worst status, not the majority** — D11 one
  level up. A parcel with one unsurveyed block and two finished ones is a parcel
  somebody has to go back to. Clicking it zooms past the split point rather than
  opening anything: the only reason it is one dot is that its entrances overlap
  at that zoom, and the officer's next question is which of them they meant.
- **The layer is off by default and fetched on demand.** The map is opened far
  more often to find a citizen than to read the census, and this is a second
  full request beside the registered parcels.

`BUILDING_ZOOM` is 16.5 rather than a round number: it is the zoom at which two
entrances on one parcel stop overlapping at this cadastre's plot sizes.

#### P3-T6 — the link the whole census turns on, and where it is lost

Registering "into a specific unit" needed a column path that did not exist. The
tables have carried `PropertyEntry.buildingId` and `BuildingUnit.unitId` since
migration 0030 (§3.7), and P2-T8 flipped billing to prefer the canonical `Unit`
where linked — but **nothing could set the link**. The backfill wrote it for
cards filed before the UI existed, and every card filed since arrived with it
null. So the field was threaded through all six layers: `property.schema.ts` →
`admin-citizen.schema.ts` → the `PropertyEntry` entity → the repository → the
citizens service → back out through `getCitizenForm`.

**The last of those is the one that would have been forgotten.** Without
`buildingId` travelling *back* to the edit form, an officer correcting a phone
number would re-submit the card with no link, and the connection a colleague
made from the matrix would be gone — taking `Unit`'s authority over the row with
it, which is what a bill is computed from. A destructive edit that looks like a
successful save.

**Where a link is refused, and why it is a removal rather than an error.**
`branchFieldsOnly` keeps only the fields a card's نوع العقار declares, so
`buildingId` is listed for BUILDING and HOUSE and silently dropped on أرض and
خيمة — land has nothing standing on it, and a tent stays a bare card (Q2). A
client that sent one is confused rather than malicious, so the right answer is a
card with no link, not a rejected registration.

> **`census-link.spec.ts` exists because that drop is silent.** A key
> `branchFieldsOnly` does not list produces no error and no complaint — just a
> registration that arrives with no link and a census that quietly never learns
> who lives in the building. Seven tests: the link surviving on both types that
> can carry one, `unitId` surviving on each unit line, the removal on the two
> types that cannot, absence when no link was picked, and a refusal of the
> printed *code* in the id's place (D9 — the UUID is the identity).

**The picker never picks flats on the citizen's behalf.** Nothing is ticked by
default, and that is P2-T8's first wrong attempt stated as a UI rule: a
twelve-flat matrix says nothing about whether this person holds one of them or
twelve. A unit that already has a current occupant gets an amber dot rather than
being disabled — co-ownership and an owner abroad with a tenant in the flat are
both ordinary (D2).

**Quick save** sends `blanketFlagReason`, which the server has accepted since
P2-T7 and nothing sent. Offered on **create only**: a blanket reason on an edit
would excuse gaps in a record that has already been reviewed once, which is a
different and much worse claim. The dialog states the three limits — it cannot
supply a name or a discriminator, and it cannot excuse a value that was entered
and is wrong — because an officer about to use it needs to know what it will not
cover, and a quick save that still fails closes the dialog so they can read the
complaint.

#### P3-T7 — tabs as a work queue, not a copy of the enum

Each tab groups the case types an officer does the *same thing* about: a locked
door and a flat somebody thinks is empty are both «إعادة زيارة»; a refusal and
an ownership dispute both need a person with authority. One tab per `CaseType`
would have been a second rendering of the enum with no decision in it.

Filtering is client-side, deliberately. `GET /cases` has no pagination, and the
conversion strip above the table is computed over *every* resolved case ever —
narrowing the request would quietly change what that number claims from "the
register's conversion rate" to "this tab's", in the same words.

The status control is a **cycle**, `OPEN → SCHEDULED → RESOLVED → OPEN`, not
three buttons: it is one control in a table row, and that is the order a case
actually travels. The label always names where the tap *goes*, never where the
case is.

#### P3-T8 — the queue, and the code that changes underneath an officer

`DB_VERSION` goes to **2**. The file's own note says to bump it only for
something IndexedDB has to know about — a new object store is exactly that — and
the upgrade is written as "create what is missing" rather than switching on
`oldVersion`, so a device that has never opened the app and one carrying thirty
queued registrations take the same tested path.

**Buildings drain before registrations**, and that ordering is the whole reason
they are two stores rather than one. A queued registration may carry the
`buildingId` of a building that is also still queued; the id only becomes a row
when that building lands.

§4.4's reconciliation is the part worth reading. A delivered building whose code
did **not** change is simply removed — there is nothing to tell anyone. One whose
code *did* change is **kept**, marked `reconciled`, until a person dismisses it:
an officer who wrote `A-1042-A` on a form in somebody's stairwell has to be told
it became `A-1042-B`, and a notice that vanished with the tab would not tell
them. Only *creations* queue; an edit needs the row it is editing, and queueing
one would be a patch against a version the device cannot see.

> **Not verified end to end here.** The airplane-mode → reconnect → reconciled
> path is implemented and typechecks, but it needs two officers on one parcel
> and a real disconnection to exercise; it has not been run. The server half it
> depends on — suffix re-allocation under an advisory lock, and `reconciled` in
> the create response — *is* covered, by the six-simultaneous-creates test from
> P2-T2.

#### P4-T1 — `outcome` reuses `SurveyStatus`, and one action records two facts

A fourth vocabulary beside `SurveyStatus` is the trap D15 names, and every state
a *visit* can produce is already in it. The single value that is not a visit
outcome is `NOT_SURVEYED` — it means nobody went — and the schema refuses it.

Logging a visit **sets** the unit's status to the outcome. Two facts, one action,
because an officer who has just stood at a door knows both, and asking them to
say it twice is how a unit ends up reading «مكتملة» with no visit behind it. The
status is *set*, not merged, which is the difference from `recordOccupancy`'s
narrow lift: that is a side effect of another action, this is an officer stating
a finding directly, and a finding replaces the previous one.

`officerId` is `SetNull`, not cascade. A visit is a thing that happened and stays
true after the officer leaves the municipality — cascading it away would delete
the evidence that a door was tried, which is exactly what a resident disputing a
notice asks to see. Five tests cover this, including deleting the officer.

The cell shows the **count**, not the status, because D10's distinction is
invisible in the status: three fruitless visits and one both read
`VISITED_NO_ANSWER`. `get()` returns at most ten visit rows per unit but an
uncapped `_count` — the count is the number that matters and a forty-flat
building must not carry four hundred rows.

#### P4-T2 — the panel says which part of the structure each row is about

The newest row is badged «الحالي» and every row names its target — «المبنى
بكامله» or the unit code. Without that, "top three floors gone, ground floor shop
still trading" reads as a contradiction rather than as two facts about one
building. The repaired-building case was already covered by P2-T3's
`keeps the repair without losing the collapse`.

#### P4-T3 — the export

`csvCell` and `buildCsv` are new in `lib/csv.ts`; the existing `escapeCell`
quotes only when it must and has **no formula-injection guard**, which is fine
for a template of the system's own column headers and not fine for an export of
text people typed. The new one is deliberately identical to `csvCell` in
`reporting.service.ts` — two copies rather than a shared module, because they
live in packages with no dependency between them, and a third would be the
moment to move it into shared-schemas.

It exports **what the filters currently select** — not the page, not the whole
register — by paging the same endpoint the table reads, so the two cannot
disagree about what matches. `EXPORT_CEILING` is 10,000: roughly five times the
largest honest answer for a municipality with 1,825 parcels, so a run that hits
it is reporting a data problem rather than a big town.

> **Verified by running it.** There is no frontend test runner, so `buildCsv`
> was compiled and executed directly: the output starts with a UTF-8 BOM (Excel
> reads Arabic rather than `Ø§Ù„Ø­ÙŠ`), `=cmd|calc`, `@SUM(A1)` and a leading
> `-5` are all prefixed with `'`, embedded quotes are doubled, and a cell
> containing a comma is quoted.

#### P4-T4 — the notice says where its code comes from

`councilDecisionRef` is optional, and §7 Q1 is why: internal cadastral indexing
and parcel-linked building numbering is an administrative and fiscal survey
power the municipality already holds, so the codes are valid without a decree.
The receipt footer says something either way — with a decision on file it cites
the decision, without one it cites the municipal survey authority — and prints
nothing at all when the card carries no code.

The notice prints the building code **and** the posted number, never one (D14):
where the register says `A-1042-B` and the door says `12`, the collector in the
street trusts the paint, and a notice with only our code sends them looking for
a building nobody calls by that name.

#### Two things outside the task list, both flagged

1. **`unitVisit` was added to `backup.service.ts`'s `TABLE_ORDER`.** The same
   silent data loss Phase 2 found and fixed for the census block:
   `unit_visits.officerId` references a `users` row, and a restore deletes and
   rewrites every user. Left out, a restore would erase the municipality's
   record of every door that was tried.

2. **The citizen profile now carries `buildingCode` / `buildingPostedNumber` and
   each unit line's `unitCode`.** P4-T4 asks for them on a notice and the
   receipt reads the profile; without this there was nothing to print. Added to
   the existing `select` rather than as a second query.

#### What is not covered

- **Still no test runner in `apps/frontend`.** The three new components, the map
  layer module and the offline queue ship verified by `tsc`, `eslint` and a
  production build only. `buildCsv` was executed directly (above) because its
  acceptance criterion is about bytes; the rest were not.
- **The offline round trip has not been exercised** — see the note under P3-T8.
- **`logVisit` has no unit-level test**, only integration ones. That is the right
  place for it: the count, the status change and the `SetNull` on the officer are
  all claims about the database.

### The API surface, as it now stands

Everything the census offers, wrapped by `lib/api-client.ts`:

| What the UI needs | Endpoint |
|---|---|
| Census ledger, filters composed | `GET /t/:slug/buildings` |
| One building + its unit matrix + occupants | `GET /t/:slug/buildings/:id` |
| Damage history + current level | `GET /t/:slug/buildings/:id/damage` |
| Create / edit a building | `POST`, `PATCH /t/:slug/buildings/:id` |
| Fill a matrix from a blueprint | `POST /t/:slug/buildings/:id/units/generate` |
| Add / correct one unit | `POST /t/:slug/buildings/:id/units`, `PATCH /t/:slug/buildings/units/:unitId` |
| Register an occupant (auto-closes cases) | `POST /t/:slug/buildings/occupancies` |
| End a tenancy | `PATCH /t/:slug/buildings/occupancies/:id/end` |
| Record damage | `POST /t/:slug/buildings/damage` |
| Log a visit (moves the unit too) | `POST /t/:slug/buildings/visits` |
| A unit's attempts | `GET /t/:slug/buildings/units/:unitId/visits` |
| Map pins with rollups | `GET /t/:slug/dashboard/map/buildings` |
| Cases by type / building / unit | `GET /t/:slug/cases?caseType=&buildingId=&unitId=` |

Three things the frontend must respect, all already enforced server-side:

- **`create` returns `{ building, reconciled, deduplicated }`.** `reconciled: true`
  means the provisional suffix the phone was showing is not the one it got —
  P3-T8's post-sync notice reads that, and an officer who is not told will keep
  quoting a code that no longer exists.
- **`recordOccupancy` returns `casesResolved`.** Silently closing someone else's
  case is how a dispatch list stops being believed.
- **A per-unit «غير مؤكَّد» control is now safe to ship** (migration 0031).

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

---

## 10. Phase 5 — closing the loop (2026-09-10)

Phases 1–4 built the census and taught the registration form to *point at* it.
What none of them built is anything that **acts on the link when a registration
arrives**. This phase is that, plus the two structural gaps the same
investigation surfaced.

| ID | Task | Result |
|---|---|---|
| P5-T1 | `CensusSyncService` — a registration completes the census: occupancy, survey status, visit, case resolution, building name | ✅ 16 integration tests. Called from both `CitizensService.create` and `.update`. |
| P5-T2 | `Building.lifecycleStatus` — the third axis, excluded from the survey denominator | ✅ Migration `0033`, applied to staging. Ledger filter, map channel, CSV column, 3 tests. |
| P5-T3 | Duplicate-structure guard on `create`, refused server-side with the candidates attached | ✅ 6 tests, including the ordering against offline deduplication. |
| P5-T4 | The stacked-pin fix: no centroid default for the second structure on a parcel | ✅ Editor. See §10.4. |
| P5-T5 | Split the registration markers per censused structure | ↩︎ **Reverted by P5-T7** — the census layer already draws a pin per building, so this duplicated it. See §10.6. |
| P5-T6 | Raw SQL schema-qualified (a real 42P01 on staging), census cache invalidation, and build isolation | ✅ Guard test over every backend source; `build:check`. See §10.7. |
| P5-T7 | Registration markers back to **one dot per رقم العقار**; `computeSpatialData` reverted with it | ✅ 2 integration tests asserting the aggregation. See §10.6. |

**Verification:** `pnpm typecheck` clean, `pnpm lint` clean (0 errors; the same 6
pre-existing warnings), `pnpm build:check` clean. **30 suites, 647 tests, 0
failures with a database attached** — up from 497, with all five integration
suites run.

> Run the DB-backed suites **one at a time**. They drop and rebuild fixed schema
> names (`tenant_census_spec`, `tenant_ledger_spec`, …) on a shared database, so
> two concurrent `jest` invocations — or a run started while another is still
> going — will stomp on each other and produce failures that belong to neither.

### 10.1 P5-T1 — the write path that was never built

**The symptom.** An officer taps «تسجيل أسرة في هذه الوحدة» on flat 001, fills
the form, saves. Afterwards: the matrix still shows the flat empty, the unit
still reads «غير ممسوحة», `unitsSurveyed` is still 0, the map pin is still
coloured unvisited, and the حالة that sent them there is still open.

**The cause.** `registration.repository.ts` wrote `buildingId` and `unitId` onto
the rows and stopped. `unitOccupancy.create` existed in exactly two places in the
backend — `BuildingsService.recordOccupancy` (the matrix's own form) and
`backfill-buildings.ts`. The registration path called neither.

**It was a billing fault, not a display one.** P2-T8's `heldThroughOccupancy`
bills a مبنى card carrying no unit rows *from `UnitOccupancy`* — the only
per-citizen table that can answer which flats a person holds. Registration never
wrote to it, so that path resolved to an empty list and the citizen went unbilled
with no complaint anywhere.

**What P3-T6's ✅ actually proved.** `census-link.spec.ts` asserts the link
survives `branchFieldsOnly` on its way through the submission schema. That was
the right test at the wrong altitude: the fields arrived, were stored, and
nothing read them. Everything downstream of validation was untested.

**Design decisions worth keeping:**

- **After the transaction, never inside it.** A census hiccup must not cost a
  municipality a registration. `syncQuietly` logs and returns `null`; the API
  response carries it so the form can say «تم الحفظ دون الربط بسجل المباني».
- **Reads committed rows rather than taking them as an argument.** The caller's
  draft has been through domain construction and flag-stripping; the stored row
  is the only version worth acting on. It also means create and edit — which
  build their property rows quite differently — pass nothing but an id.
- **Idempotent.** Every write is an upsert or a narrowed `updateMany`, so a
  replayed offline submission produces the same census as the first delivery.
- **A visit is logged only when the occupancy is *new*.** Correcting a phone
  number a week later is not a second doorstep, and a «٣ محاولات» count that
  rises when somebody opens a form is a count nobody can dispatch against.
- **`endUnclaimed` is scoped to this `registrationId`.** Unticking a flat ends
  the spell (D2 — ended, never deleted). An occupancy recorded from the matrix
  carries no `registrationId` and is never touched — without that scope, saving
  one household's card would evict everyone a stairwell survey had recorded.
- **The narrow status lift is copied deliberately.** Only `NOT_SURVEYED`,
  `VISITED_NO_ANSWER` and `PARTIAL` are lifted to `COMPLETE`, exactly as
  `recordOccupancy` does. `DEMOLISHED` and `VACANT_CONFIRMED` are findings that
  contradict this one, and a contradiction is for a person to resolve.
- **A منزل attaches to a single-unit structure; a مبنى never guesses.** A house
  card has no units array to tick, so without the inference it could never record
  its occupant. A مبنى is excluded even with one unit — P2-T8 went down that road
  and reverted, and the reason has not changed.

**Building names.** `PropertyEntry.buildingName` and `Building.name` were
unrelated free-text columns with nothing comparing them; two tenants of one block
produced «بناية النور» and «بنايه النور». Now: linked to a *named* building the
card mirrors it read-only; linked to an *unnamed* one the field stays open and
whatever the officer types is promoted onto the building server-side. The lock is
one-directional on purpose — the officer in the stairwell is the person who
learns the name, and locking an empty field would make it unrecordable.

**Prefill.** `registerHref` carried two UUIDs and nothing else, and
`BuildingUnitPicker` returns `null` without a رقم العقار — so the control
*vanished* and the only sign the flat had been chosen was a hidden `buildingId`.
`CitizenEditor` now fetches the building and seeds the first card (parcel, name,
property type via `STRUCTURE_TYPE_MAP`, and the tapped unit's type/floor/side/
area). `occupancyType` is deliberately left blank: whether they own or rent is
what the officer is at the door to find out.

### 10.2 P5-T2 — `BuildingLifecycle`

Modelled on the Dutch BAG's *pand* lifecycle, keeping only what a surveyor can
establish by looking: `PERMITTED`, `UNDER_CONSTRUCTION`, `IN_USE`, `DERELICT`,
`DEMOLISHED`, `NOT_REALISED` (BAG's `niet gerealiseerd pand`).

Before it, an officer in front of a half-built shell had two options and both
corrupt the register: invent a `RESIDENTIAL_BUILDING` whose fictional flats then
sit at `NOT_SURVEYED` for ever and hold the coverage percentage down, or record
nothing and leave the parcel looking unvisited.

- `OCCUPIABLE_LIFECYCLE = ['IN_USE', 'DERELICT']` is the census denominator.
  **`DERELICT` is in deliberately** — an abandoned block with a displaced family
  in it is exactly what a war-damage census exists to find.
- The building *count* stays over the whole filtered set; the units the exclusion
  removed are reported as `unitsOutOfScope` and shown on the tile, so a coverage
  percentage that improved because somebody marked a block demolished is
  explainable on the screen showing it.
- `mapPins` returns `surveyRollup: null` for a non-occupiable structure. Its
  units really are `NOT_SURVEYED`, and that is the one colour meaning "send an
  officer"; the map draws it faint through `lifecycleOpacityExpression` instead.
- Default `IN_USE` is not a guess about legacy rows — the UI had no way to
  express anything else, so it is what every existing row means.

### 10.3 P5-T3 — the duplicate guard

§4.4's advisory lock solves the *opposite* problem: it guarantees two officers
surveying one block from the street and the alley receive *different* suffixes,
quietly, with nothing to notice. The census then holds one structure twice and no
constraint can catch it. Q5's clockwise sweep is a convention in a handbook.

`createBuildingSchema.acknowledgedDuplicates` is the moment of noticing. On a
parcel that already carries a structure the server refuses without it, and
answers the refusal with the candidates — code, name, posted number, unit count
and **distance from the proposed pin** — so the dialog can show them without a
second request, which matters most on the offline phone least able to make one.

- `distanceMetres` is **null**, never 0, when either side has no pin. "We cannot
  tell" and "they are in the same place" are opposite findings, and the second
  would talk an officer out of recording a building that really exists.
- **Deduplication is checked before the prompt.** A phone re-delivering a
  creation it already made must not be told the parcel is occupied by the very
  building it made. Pinned by a test.
- `ConflictError` gained an optional `details`, and the exception filter now
  serialises it for both error types. `ApiRequestError.fieldErrors` guards with
  `Array.isArray` — it used to call `.map` unconditionally and would have turned
  a conflict into a `TypeError` inside the catch block meant to display it.

### 10.4 P5-T4 — one dot per building

Two independent causes, and the obvious one was not the main one:

1. **The editor auto-filled every building on a parcel with the same centroid**,
   so they shared byte-identical coordinates. `BUILDING_ZOOM = 16.5` was tuned
   for entrances that *nearly* overlap and cannot separate points that are equal.
   P5-T5 went further and removed the default
   altogether — see §10.6, which is the change that actually moved the dots an
   officer looks at.
2. **Citizen markers came from `PropertyEntry.latitude`, which is the parcel
   centroid** (copied from the cadastre lookup in `RegistrationService.submit`).
   Three cards on one parcel drew as one dot regardless of buildings.
   `computeSpatialData` now prefers the linked building's entrance, resolved at
   read time rather than written back — the pin belongs to the building, and
   copying it would leave two rows to disagree on the first correction.

`buildingCode` had been on the citizen profile since P4-T4 and the citizen page
rendered `buildingName` instead — a free-text string that looks identical whether
the card is linked or not. It now shows «سجل المباني» with the code, which is the
only on-screen confirmation the link exists.

### 10.5 Deferred: subdivision and deed modelling — read this first

**Not done, and not because it is unimportant.** Under Lebanon's joint-ownership
regime a **مفرز** building's apartments each receive a **رقم القسم** appended to
the parcel number, each gets its own **صحيفة عينية إضافية**, and **each قسم is
itself 2400 shares**. «العقار ٤١١٥ القسم ٥» is what appears on the deed, the
إفادة عقارية, the sale contract and any court paper.

`Unit` carries `unitCode` (ours, derived) and `postedNumber` (what is on the
door) and nothing for القسم. D14 says the collector trusts the door over the
register — but there is a third number and it **outranks both legally**. A
collector disputing a fee will be handed a deed with a قسم on it and have nothing
to match it against.

Two things fall straight out, and neither is a small change:

- **`Building.isSubdivided` (مفرز / غير مفرز) is load-bearing.** A غير مفرز
  building is *one* عقار with one share pool over the whole thing; a مفرز one is
  N legal objects with N share pools. Ownership, billing and every conflict check
  change on that flag.
- **The two halves already disagree about shares.** `PROPERTY_FIELD_MAP`
  restricts `shares` to `LAND`; `upsertOccupancySchema` accepts shares on any
  OWNER unit occupancy. The census side is right and the card side is wrong —
  co-heirs holding fractions of a مفرز apartment cannot be recorded from the
  registration form today.

**When it is picked up:** add `Unit.legalPartNumber` (nullable — most village
buildings are genuinely غير مفرز), `Building.isSubdivided`, and lift the `shares`
restriction for `BUILDING`/`HOUSE` cards on subdivided structures. Print القسم
beside `code` and `postedNumber` on notices. Then the ownership-arithmetic report
below becomes possible.

### 10.6 P5-T5, and P5-T7 reverting it — the registration layer stays per-parcel

**What P5-T5 did.** `/map` renders `getRegisteredParcels` — one marker per
رقم العقار, positioned at the parcel's centroid. Reading the user's report of "one
centred dot" as the same defect P5-T4 had just fixed elsewhere, this split the
grouping key to `(parcelNumber, buildingId)` so each censused structure got its
own marker on its own entrance pin.

**Why it was wrong, and reverted.** The map already has a **census layer**:
`getBuildingMapPins` draws an icon per building at its own entrance, coloured by
survey rollup and ringed by damage, above zoom 16.5. Splitting the registration
markers put a second, differently-shaped dot on top of every one of those pins —
two layers saying the same thing in two visual languages, which is worse than
either alone. The user's screenshot showed it plainly: blue dots sitting on green
building pins.

The two layers answer different questions and the split conflated them:

| Layer | Question | Grouping |
|---|---|---|
| `getBuildingMapPins` (census) | *What is standing here, and how far has the survey got?* | One pin per building, at its entrance |
| `getRegisteredParcels` (registrations) | *Who is registered on this عقار?* | **One dot per parcel, at the parcel's point** |

So the grouping key is `propertyNumber` again, `markerKey`/`buildingId`/
`buildingCode`/`buildingName` are gone from `RegisteredParcel`, and everyone on a
plot — linked or not, in whichever block — is under one dot. `computeSpatialData`
was reverted for the same reason; it had no frontend consumer, and leaving it
per-building would have handed a future one the behaviour just rejected.

**What was kept.** The editor still refuses to hand the second structure on a
parcel the same centroid it gave the first (§10.4). That is not about this layer
at all: it is about the *census* pins, which are per-building by design and need
real entrances to be distinguishable from each other.

**The lesson worth keeping.** "One dot where there should be several" had two
possible readings, and the expensive one was assumed. The cheap check — *is there
already a layer that does this?* — was not made. Two overlapping layers is a
design question, not a bug, and it needed asking before the grouping key moved.

### 10.7 P5-T6 — three faults behind one terminal log

A dev-server log after P5-T5 carried three unrelated problems. Two were real
defects with production consequences; the third was self-inflicted and is now
impossible to inflict again.

#### 1. `relation "damage_assessments" does not exist` — raw SQL and the pooler

**Evidence.** Staging Postgres logged the error once, at `2026-09-10 08:18:23Z`,
with **no other Postgres activity in the four-minute window around it**. The
table exists and has since migration 0030. Every Prisma *model* query in the
same request succeeded. Only the raw query failed.

**Cause.** Prisma qualifies its own generated SQL — `?schema=` makes it emit
`"tenant_x"."buildings"`. It does **not** touch `$queryRaw`, so
`FROM damage_assessments` resolves through the connection's `search_path`. That
is session state, and this app does not own the session: `DATABASE_URL` is the
Supabase **transaction pooler** (port 6543, `pgbouncer=true`), where statements
go to whichever server connection is free and session settings are explicitly
not guaranteed to travel with them.

A probe confirmed the mechanism is *usually* fine — 25/25 raw queries resolved
correctly through the pooled URL — which is precisely what makes it dangerous.
It fails rarely, unreproducibly, under load, and takes a whole page with it.

**Fix.** Every raw query in the backend now writes its schema into its SQL:
`FROM ${S}"damage_assessments"`. Nothing sets `search_path`, waits for a
transaction, or costs a round trip — the statement means the same thing on any
connection it lands on. `tenant-schema-ref.ts` holds the helper and the reasoning.

Two things worth knowing beyond the mechanical change:

- **The advisory locks were affected too.** §4.4's suffix allocation keyed on
  `hashtext(current_schema() || parcel)`, and `current_schema()` reads the same
  session state. On a drifted connection it returns `public`, so either every
  municipality's parcel 28 serialises against every other's, or — worse — two
  officers on one parcel take *different* lock keys and the race the lock exists
  to prevent is back. The key is now the schema name as a literal.
- **A missing schema now fails loudly.** `tenantSchemaRef` throws on an invalid
  name. The first attempt put a `schemaRef` getter on `TenantContextService`;
  the integration specs stub that service as a bare object, so the getter came
  back `undefined`, interpolated as a *bound parameter*, and produced
  `syntax error at or near "$1"` — a quiet wrong answer in place of a loud one.
  Call sites now call the helper with `tenantContext.schemaName`, a plain string
  a stub can supply, and an absent one raises a message that names the problem.

**And a guard, because the two versions look identical.**
`raw-sql-is-schema-qualified.spec.ts` reads the table list from
`schema.prisma`'s own `@@map` names — so a table added tomorrow is covered
without touching it — and fails on any `FROM`/`JOIN` naming one of them without
an interpolation in front. CTEs, `generate_series` and subqueries are untouched.
It was verified by breaking a query on purpose and watching it fail.

#### 2. The map cache never heard about the census

`ReportingService` invalidates `dashboard:{slug}:` on registration, cadastre,
citizen and money events. It did not listen to `building.changed`.

That was survivable while markers sat on the parcel centroid. It stopped being
survivable in P5-T5, which positions them on `Building.latitude/longitude`: an
officer places a building's entrance, reloads the map, and **the dot does not
move** — for the whole TTL, five minutes in the shipped config, which reads
exactly like the pin having failed to save.

Now listens to `building.changed` (every write in `BuildingsService` and
`CensusSyncService` — created, edited, deleted, units generated, occupancy
recorded or ended, visit logged, code recomputed) and to `damage.recorded`,
which draws the ring on every census pin and the «مبانٍ متضررة» tile.

#### 3. `Cannot find module './vendor-chunks/zod@3.25.76.js'` — self-inflicted

`next build` and `next dev` share `apps/frontend/.next`. A verification build run
while the dev server is up rewrites the chunks that server is mid-way through
serving, and the dev server then fails at *runtime* on files that no longer
exist — a 500 on every request to a page whose source is fine, plus hot-update
404s and "Fast Refresh had to perform a full reload". Nothing in the error points
at the cause, and it survives until the dev server is killed.

This is the frontend twin of the `nest build` EBUSY hazard §6 already records.

`pnpm build:check` now sets `NEXT_DIST_DIR=.next-check`, which `next.config.mjs`
reads as `distDir`; `pnpm build` is unchanged and still writes `.next`, which is
what Vercel and `next start` expect. `.next-check/` is gitignored **and added to
the ESLint ignores** — without the second, `pnpm lint` reported 3,652 errors from
webpack's own output.

> The `Municipality '_next' was not found` warnings in the same log appeared
> only alongside the stale-chunk 500s and the full reloads, and stopped when the
> dev server was restarted. The service worker is inert on localhost and the
> middleware already rewrites a `_next` first segment to the app's 404, so no
> separate cause was identified and none is claimed. If it recurs on a clean
> `.next`, it is a real bug and this note is the place to start.

### 10.8 What is still not covered

- **No ownership-arithmetic report.** Units with more than one current OWNER
  occupancy whose shares do not sum to 2400 are a detectable conflict and nothing
  detects them. Cheap to add, and the only automated ownership-dispute detector
  the system could have — but it is only meaningful once §10.5 lands, because
  before إفراز the 2400 is over the whole building rather than the flat.
- **Still no test runner in `apps/frontend`.** The Phase 5 frontend work ships
  verified by `tsc`, `eslint` and a production build only.
- **The offline round trip is still unexercised end to end** (P3-T8's note).
  Phase 5 added `acknowledgedDuplicates: true` to the queued payload — a queued
  creation was answered by a person before it was queued, and without the flag
  the server would refuse it on delivery with nobody at the screen. That
  reasoning is sound and untested against a real airplane-mode round trip.
- **`code` churn on zone reassignment is unaddressed.** `Building.code` is
  recomputed when a parcel moves between sectors; `codeSuffix` and the UUID are
  durable. P4-T4 prints `code` on receipts, so a citizen holding a notice reading
  `A-4115-B` after a sector change is looking for a building that no longer
  answers to that name. D9 states the principle; the printed artefact does not
  yet respect it.
- **Migration 0033 uses a plain `CREATE INDEX`**, which the deploy script flags
  as a write lock. Correct here — `buildings` holds 0 rows in production and a
  handful in staging — but a municipality with a populated census would want
  `CONCURRENTLY`, which cannot run inside the migrator's transaction.
