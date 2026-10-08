# Mechanization (منظومة المكننة البلدية الذكية)

Last verified against the code: `feat/estate-institution-owners` (on `develop@f10a1b7`), 2026-10-08.

A multi-tenant municipal platform for Lebanese municipalities: the citizen register, the
building and unit census, the cadastral map, municipal fee billing (رسوم القيمة التأجيرية
وبدل النفايات), payment collection at the counter and on collectors' rounds, and formal
Arabic receipts. The visual system is in [DESIGN.md](DESIGN.md); the binding UI rules are in
[docs/ui-ux-standards.md](docs/ui-ux-standards.md).

---

## Product truth and scope

### 1. Who uses it

Staff hold one of seven roles (`STAFF_ROLE` in `packages/shared-schemas/src/enums.ts`).
Citizens are not a role: they are the other user kind (`kind` = `CITIZEN`) in the same
`users` table.

- **Citizens (المواطنون والمكلفون)**:
  - Check outstanding fees and charges without visiting the municipal hall.
  - View their registered properties, apartments, shops and land parcels.
  - Pay in cash at the municipality or to a collector, and receive an official receipt.
  - Report a Whish Money transfer made in the Whish app. The report is a declaration
    that stays pending until a clerk matches and confirms it. There is no live online
    checkout: `WhishGatewayService.postCheckout` is not implemented, and without
    credentials the gateway runs in sandbox mode.
- **Collectors (`COLLECTOR`, جابي) and counter clerks**:
  - Record in-person payments, full or partial, at the counter (`CASH`) or on a round
    (`COLLECTOR`).
  - Issue official receipts matching Lebanon's printed receipt books (`وصل جباية رسمي`).
  - Share a receipt through the device share sheet, a WhatsApp link, or a PDF download.
- **Field inspectors (`FIELD_INSPECTOR`, مفتّش ميداني)**: survey buildings and units on a
  phone, queuing records offline when the connection drops.
- **Accountants (`ACCOUNTANT`), administrative officers (`ADMINISTRATIVE_OFFICER`),
  auditors (`AUDITOR`) and system administrators (`SUPER_ADMIN`)**, for the council and
  the municipal administration:
  - Dashboards: collection rate, monthly collection, unpaid and overdue balances,
    registered population and households.
  - A cadastral map explorer with parcel numbering and sector zones.
  - CSV export with formula-injection-safe cells.
  - An append-only audit log of staff actions.
- **The municipality head (`VIEWER`, مشاهد فقط)** reads the dashboard, the reports, the
  register with its citizens' data, the census, the cases and the fees, and changes nothing
  (decision of 2026-10-05). Every mutating route refuses the role and its screens offer no
  write control. It is never shown a citizen's رقم مرجعي, which is a sign-in credential, nor
  can it confirm one by searching for it, and it does not export the register, open scanned
  identity documents or read the activity log (it does read a file's own «سجل التعديلات»).
- **Worklists are each officer's own.** «يتطلب مراجعة», «وحدات غير ممسوحة» and «بانتظار
  إعادة الكشف» show a field inspector or a collector the records *they* filed, the units
  *they* put on the census and the damage readings *they* recorded. The roles whose job is to look across everyone's work —
  `SUPER_ADMIN`, `ADMINISTRATIVE_OFFICER`, `AUDITOR`, `VIEWER` (`SEES_ALL_STAFF_WORK`) — see
  every staff member's, and can narrow any of the three to one officer or to «بلا موظف»:
  work whose filer was never recorded or has since left.
- **A system administrator can see who is working right now.** The staff directory marks each
  account «متصل الآن» or «غير متصل», with «آخر ظهور» for whoever is not. It is derived from
  requests the account actually made — not from when it signed in, and not from a screen
  left open that refreshes itself — judged on the server's clock, and it is visible on the
  `SUPER_ADMIN`-only staff screen and nowhere else.
- **A citizen who owns no phone is a complete record.** «لا يملك رقم هاتف (حالات خاصة /
  كبار السن)» is a real answer to the phone question, and «رقم للتواصل» holds the son's,
  daughter's or neighbour's number the municipality reaches them through. The two are
  separate on purpose: a relative's number recorded as the citizen's own used to offer
  the parent's file to the child signing in and to name the parent as a landlord they
  never were. A household may still share one phone — that is normal, and sign-in asks
  which member is at the screen rather than guessing. When a relative's number turns up
  in a new file, the officer can answer «رقم أحد أقاربه» on the spot, and a reviewer can
  record «لا يملك رقم هاتف» from «استكمال البيانات الناقصة». Such a citizen opens their page
  with the reference number alone: the payments portal and the code sent to a phone need a
  number of their own, and a relative's is never accepted in its place. How their family
  pays online is an open decision ([docs/open-decisions.md](docs/open-decisions.md)).
  Wherever a phone is shown — the register, a parcel's registrants on the map, a flat's
  owners — the answer «لا يملك رقم هاتف» and the relative's number are shown as such,
  never as the citizen's own, and a search that found a file through the relative's
  number says so on the row.
- **An owner can be an estate or a body, not only a person** (the user's guidance of
  2026-10-07). «صاحب الملف» asks first whether the file is a person's or an estate's or a
  body's. «تركة (ورثة المرحوم)» is the file of an owner who has died: converted in place
  from his own file — with the date of death, through the same guide as a move — so his
  properties and their bills stay where they were, shown everywhere as «ورثة المرحوم …».
  It only owns: his rentals end on the date of death, a home he lived in — or came back to
  for a season — becomes «مشغولة بتسامح» with the widow or a child filed as a household who
  pays the occupancy fee (or «مؤجرة», or «شاغرة»), and the owner's fees and empty units stay
  with the estate. A tenant who writes the owner as «ورثة المرحوم …» is still matched to him.
  «جهة أو وقف» is a waqf, an association or a public body: one name, and it may rent
  what nobody lives in. Each records a representative («ممثل الورثة», «المسؤول عن الجهة»)
  and needs no phone. Neither is billed a per-head flat amount, and neither can be merged
  with a person's file. Archiving a file warns that a deceased owner who still owns here
  should become an estate instead.
- **What is owed on a parcel can be looked up** («المستحق على عقار», for every role that
  reads the fees). Given a رقم العقار, it lists every unpaid bill with a unit on that parcel,
  whoever's file it is on today — the estate's, a tenant's, an archived owner's — with the
  parcel's part of each, by the bill's own lines; and apart, the unpaid bills that name no
  unit of the people on the parcel today. It answers «is anything owed» before a براءة ذمّة
  and issues no certificate; a bill that names no parcel cannot be found by it, and the
  empty answer says so rather than claiming nothing is owed.
- **A citizen file is archived, never deleted** (decision of 2026-10-05). «أرشفة الملف»
  asks for the reason and who asked for it, both written to the activity log; an archived
  file is billed nothing new and keeps everything it holds, and «إعادة من الأرشيف» brings it
  back.
- **War damage has two answers.** Each reading keeps the UN-Habitat level, the scale donors
  and the reconstruction file read, and asks beside it whether anyone can live there
  («صالحة للسكن؟»). The level answers it where it can: a collapse or an evacuation is «لا»,
  locked; no or minor damage starts at «نعم» and can change; restricted use must be
  answered. A reading «غير صالحة للسكن» can carry a re-inspection day, and «بانتظار إعادة
  الكشف» lists them, overdue first. Every reading is on the activity log.
- **No fee at all on a home nobody can live in.** While a unit's current reading says it
  cannot be lived in, nothing is charged on it — neither what its occupant bears nor what
  its owner bears (the user's decision of 2026-10-07: not habitable → exempt) — until a
  re-inspection reads it habitable. A whole-building reading covers every unit in it. A
  building's status alone («متضررة من الحرب وغير مسكونة», «مهدوم») exempts nothing: the
  editor asks for the reading, and «مراجعة الجودة» lists any such building whose units are
  still billed. The bill and the issue summary both say how many units were not charged.
- **A flat amount aimed at a kind of unit follows the same rule.** A notice of one amount
  per holder of, say, shops is not charged to someone all of whose shops are exempt or
  cannot be lived in; one usable shop beside them and the amount is due as usual. A flat
  amount sent to every citizen is a charge on the person and is not affected.
- **A unit can be exempt from fees.** A system administrator can mark a unit «معفاة من
  الرسوم» — a place of worship, a public facility, or another reason written out — and no
  fee is charged on it, whoever owns or uses it. It is for the mosque itself or the
  municipality's own building, not for a shop a waqf rents out: that shop's tenant is billed
  as usual. Granting and lifting are on the activity log; the unit, the owner's file and the
  citizen's «ملفّي» show it — on a house's own flat and on a flat the census recorded the
  person on as well as on an itemised unit.
- **A flat several people own is billed once, divided between them.** Each co-owner's file
  claims the flat, and each used to be billed for all of it. Now what the owners owe is split
  equally by default, and an officer can choose instead to divide it by the owners' أسهم or to
  name one owner who pays for everyone (the user's decision of 2026-10-07). The unit panel shows
  each owner's part before saving, the owner's file and the citizen's own «ملفّي» show it after,
  and a bill says when a co-owned flat was charged at a part or paid by another owner. A tenant
  still pays the whole occupancy fee: only what the owners bear is divided.
- **Staff accounts have three states, and none of them loses history.** An account is
  active, disabled, or deleted. Disabling blocks sign-in and moves the account out of the
  staff directory into «الأرشيف», where a system administrator reads it and can bring it
  back; deleting hides it from both and is undone from «الموظفون المحذوفون». In every
  case the row, the account's details and everything the person did stay on record, and a
  field inspector's earnings and unpaid balance keep their place in the payout ledger.

---

## Core technical constraints

- **Multi-tenancy**: one PostgreSQL schema per municipality (`tenant_<slug>`), resolved
  per request.
- **Language and direction**: Arabic and right-to-left first (`dir="rtl"`); English is a
  full second locale; numbers and codes run left-to-right.
- **Currency**: Lebanese pound (`LBP`, `ل.ل`) with compact formatting for millions and
  billions; US dollar and euro as foreign currencies.
- **Security**: JWT sessions, role-based access over the seven staff roles
  (`SUPER_ADMIN`, `AUDITOR`, `FIELD_INSPECTOR`, `COLLECTOR`, `ACCOUNTANT`,
  `ADMINISTRATIVE_OFFICER`, `VIEWER`) plus the citizen user kind, and an audit log. Rules:
  [docs/security.md](docs/security.md).
