# Mechanization (منظومة المكننة البلدية الذكية)

Last verified against the code: `feat/treasury-inspector-payouts-and-vouchers` (on `feat/treasury-daily-count-and-closure@3ea515a`), 2026-10-10.

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
  - **The treasury (الخزينة)**: live balances of the municipality's cash safe and Whish account in
    ليرة and dollars, a statement for each, and their total at the municipality's rate. A citizen payment credits
    the right wallet automatically. `SUPER_ADMIN` activates it once by entering the counted opening
    balances; the accountant works it, the auditor and view-only staff read it. Exchange, bank
    deposits and petty cash follow in later stages ([docs/finance.md](docs/finance.md)).
  - **النفقات**: an expense register and «أمر صرف». The accountant or the manager records what was
    paid, to whom, from which wallet and against which budget category, and the money leaves the
    wallet in the same act — there is no approval queue. A mistake is cancelled with a reason, which
    returns the money and keeps both the voucher and its cancellation on the record. Only the
    manager may cancel. A salary or wage is paid from the staff list itself («صرف راتب / أجر»): the
    manager picks the wallet, the amount and the month, and the voucher is filed under «رواتب وأجور»,
    in the staff member's own name and linked to their account. The staff list no longer shows the
    field inspectors' commission cards; an inspector's earnings stay on their own profile. An
    inspector's commission is paid from his row too («صرف عمولة»): the dialog shows the units he
    is credited for and what he is still owed, the manager picks a dollar wallet and sees its
    balance, and once the treasury is live the payment is a «أمر صرف» under «تعويضات المسح
    والجباية» that takes the money out of that wallet. Cancelling that voucher puts the amount back
    on what the inspector is owed. Before the treasury is live, a payout is recorded as it always
    was, with no wallet.
  - **Printed vouchers.** Every «أمر صرف» and every «سند قبض إيرادات» prints on an A4 sheet from
    its register, from the success message after recording it, and (for a commission) from the
    inspector's payout history: the municipality's letterhead and crest from الإعدادات, the number
    and date, the payee or payer, the category with its budget chapter and article, the amount in
    figures and in Arabic words, the wallet, and signature lines — the accountant, the head of
    municipality and the beneficiary on a payment order; the cashier and the accountant on a
    receipt, which also carries a QR code of its number. A cancelled voucher still prints, marked
    cancelled with its reason. «حفظ كملف PDF» is the browser's own print destination.
  - **الإيرادات**: a register of «سند قبض إيرادات» — money that reaches the treasury without a
    citizen's bill: the Independent Municipal Fund, the state's share of telephone, electricity and
    water revenue, permits, rent on municipal property, grants, fines. The accountant or the manager
    records the amount, the wallet it arrived in (a cash safe, Whish or a bank account, never a
    collector's custody), the source category, the payer and the cheque or transfer number, and the
    wallet's balance rises in the same act. Numbered «RV-2610-0001». Only the manager may cancel, with
    a reason, and a cancellation is refused once the wallet has spent the money. Citizen fees are not
    entered here: they credit the wallets on their own. The manager manages the income categories on
    «بنود الإيرادات» — adds one (from that page, or without leaving a half-filled voucher), renames it,
    gives it an English name or its budget chapter and article, and stops or restarts it. A category
    is never deleted; a stopped one leaves the form and stays in the register.
  - **عهدة الجباة**, on its own page «الجباة والتحصيل» rather than on the treasury's, since it is
    not the treasury's money yet: what each collector is still carrying from his round, and «استلام الصندوق» —
    the accountant counts the notes with him and records the handover, which moves the money from
    his name into the cash safe. Cash a collector took at a door is never counted as the
    municipality's until that moment. A partial handover is normal; the rest stays on his name.
  - **ما حصّله الجابي**: beside «استلام الصندوق», the people behind the figure — every receipt he
    wrote at a door, with the citizen who paid, what the bill was for, and how much. What the
    accountant reads while the notes are on the desk, and what settles «قلت إني دفعت لعلي» when a
    citizen comes back. Collected and held are two different numbers and the screen says why: the
    difference is what he has already handed in. Each collector also carries a status read off his
    receipts — «يجمع اليوم», «لم يخرج اليوم», «سلّم كل شيء» — and the day's count and takings.
  - **ترقيم المستندات**: every document the municipality issues carries its book, the month it was
    issued in and a counter that restarts each month — «INV-2610-0001» for a bill, «RCP-2610-0001»
    for the receipt, «PV-» for an expense voucher and «TR-» for a transfer. A number read over the
    phone says which book it came from. Documents issued before the change keep the numbers already
    printed on them; bills raised before it stay without one, because a number minted today for a
    document issued last year would be a fiction.
  - **جرد وإقفال اليومية**: at the end of a municipal day the accountant counts each wallet — the
    notes in the safe, the balance in the Whish app or on the bank statement — beside what the books
    say, and writes why wherever the two differ (فائض or عجز). A difference never changes the books.
    Once the day is over (the next morning, typically) the accountant or the manager closes it: from
    then on nothing dated on that day or before it can be recorded, not a payment, a voucher or a
    transfer, and a late one is entered on the day it is entered. Days on which no counted wallet
    moved close by themselves with the next close. Only the manager can reopen a day — the latest
    one, with a reason that stays on the record. «تقرير الصندوق اليومي» prints the day on A4: each
    wallet's opening balance, money in and out, closing balance, count and difference, the cash still
    with collectors set apart, the day's history, and signature lines for the accountant and the head
    of the municipality.
  - **جولتي**: the collector's own screen, on his own phone. What is in his pocket, then every door
    he collected at since his last handover — the citizen, his unit, the amount, the time and the
    receipt number — with the وصل one tap away to print, download or send over WhatsApp. He sees his
    own round and nothing else of the treasury: it is the answer to «كم بجيبتي؟», not a view of the
    municipality's books.
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
- **A building's height counts its built floors, never its roof** (the user's decision of
  2026-10-07). «الطوابق المسقوفة» is every level under a roof, the ground floor and a
  «طابق أعمدة» included. The building editor says so, gives the two ways to record a duplex
  (two flats, or one flat with both levels' area), and warns when the top rows of the
  matrix hold nothing, offering to lower the count; it never lowers it by itself, and says
  nothing for a house or a building still going up.
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
  per holder of, say, shops is not charged to someone all of whose shops are exempt, cannot
  be lived in, or are paid for by another co-owner named «مالك مسؤول»; one shop they pay for
  beside them and the amount is due as usual. Of four brothers whose one shop the eldest pays
  for, only he is charged; when they split it equally or by أسهم, each is charged the amount
  once (the user's decision of 2026-10-08). A flat amount sent to every citizen is a charge on
  the person and is not affected.
- **A unit can be exempt from fees.** A system administrator can mark a unit «معفاة من
  الرسوم» — a place of worship, a public facility, or another reason written out — and no
  fee is charged on it, whoever owns or uses it. It is for the mosque itself or the
  municipality's own building, not for a shop a waqf rents out: that shop's tenant is billed
  as usual. Granting and lifting are on the activity log; the unit, the owner's file and the
  citizen's «ملفّي» show it — on a house's own flat and on a flat the census recorded the
  person on as well as on an itemised unit — and none of them shows a co-owned unit's split
  while it is exempt, since no owner is billed for it. Granting corrects a fact: bills raised
  on the unit before it, on any day, are listed in «فواتير تأثّرت بتصحيحات» for the accountant
  to decide. Lifting runs forward: the unit owes from then, and earlier bills stay as raised.
  Nothing changes a bill by itself (the user's decision of 2026-10-08).
- **A flat several people own is billed once, divided between them.** Each co-owner's file
  claims the flat, and each used to be billed for all of it. Now what the owners owe is split
  equally by default, and an officer can choose instead to divide it by the owners' أسهم or to
  name one owner who pays for everyone (the user's decision of 2026-10-07). The unit panel shows
  each owner's part before saving, the owner's file and the citizen's own «ملفّي» show it after,
  and a bill says when a co-owned flat was charged at a part or paid by another owner. A tenant
  still pays the whole occupancy fee: only what the owners bear is divided. «ملاحظات الجودة» warns
  when a chosen method cannot be carried out — «حسب الأسهم» with an owner's أسهم missing, which
  stops every co-owner's bill, or a responsible owner who no longer owns the flat, which bills it
  equally instead — and opens the unit where the method is chosen.
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
