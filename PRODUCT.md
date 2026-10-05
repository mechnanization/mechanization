# Mechanization (منظومة المكننة البلدية الذكية)

Last verified against the code: `feat/staff-scoping-roles-archive` (on `develop@ec70f68`), 2026-10-05.

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
- **A citizen who owns no phone is a complete record.** «لا يملك رقم هاتف (حالات خاصة /
  كبار السن)» is a real answer to the phone question, and «رقم للتواصل» holds the son's,
  daughter's or neighbour's number the municipality reaches them through. The two are
  separate on purpose: a relative's number recorded as the citizen's own used to offer
  the parent's file to the child signing in and to name the parent as a landlord they
  never were. A household may still share one phone — that is normal, and sign-in asks
  which member is at the screen rather than guessing.
- **Accountants (`ACCOUNTANT`), administrative officers (`ADMINISTRATIVE_OFFICER`),
  auditors (`AUDITOR`) and system administrators (`SUPER_ADMIN`)**, for the council and
  the municipal administration:
  - Dashboards: collection rate, monthly collection, unpaid and overdue balances,
    registered population and households.
  - A cadastral map explorer with parcel numbering and sector zones.
  - CSV export with formula-injection-safe cells.
  - An append-only audit log of staff actions.
- **View-only staff (`VIEWER`, مشاهد فقط)**: read the register, the census, the cases and
  the reports, and write nothing. Every mutating route refuses the role, so a council
  member or an outside reviewer can be given the whole picture and no way to change it.
- **Worklists are each officer's own.** «يتطلب مراجعة» and «وحدات غير ممسوحة» show a
  field inspector or a collector the records *they* filed and the units *they* put on the
  census. The roles whose job is to look across everyone's work — `SUPER_ADMIN`,
  `ADMINISTRATIVE_OFFICER`, `AUDITOR`, `VIEWER` (`SEES_ALL_STAFF_WORK`) — see every
  staff member's.
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
