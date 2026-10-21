# Mechanization (منظومة المكننة البلدية الذكية)

Last verified against the code: `feat/earnings-by-actor` (on `develop@149e458a`, uncommitted): an inspector paid for the units he filed on any file, and «إضافة على ملف» in his log, 2026-10-21; `feat/duplex-merge` (stacked on `feat/unit-levels`): «دمج كدوبلكس» and `UNIT_LEVELS_TO_CONFIRM`, D28, 2026-10-17; `feat/unit-levels` (stacked on `chore/migration-0095`, on `develop@a7e62087`): duplexes and the per-roof factor, a house that grows, D28, 2026-10-17; `fix/pr115-review` (PRs #123, #124 and #115 stacked on `develop@5e8f5c3`, each with its review fixes): «أمان الحساب» for every staff role, no new filing — card, flat or sale — on an archived file; an archived file takes no new fee on any path, 2026-10-15; and `bugs-fix` (on `develop@5e8f5c3`; the finance audit remediation: the manager cancels a bill, a salary is paid once a month under the manager's ceiling, a collector settles only into his own custody), 2026-10-12; collectors raise no bills on `fix/fees-page-ux` from `develop@5e8f5c3` (uncommitted), 2026-10-12; income and expenses on one page, «الإيرادات والنفقات», on the same branch (uncommitted), 2026-10-12; the same day, the register moved to «الحركات المالية» and «الإيرادات والنفقات» became the recording page (uncommitted); later that day «الحركات المالية» became a filter bar over a dated list, with each voucher in a side panel, and the recording page took the full width (uncommitted); municipal requests and certificates, online and at the counter, with migration `0092` (uncommitted), 2026-10-13; the product owner's decisions of the same day (online Whish payment paused, citizen sign-in by reference alone, no SMS or WhatsApp provider) (uncommitted); and, on `fix/fees-page-ux` rebased onto `chore/migration-0092@16473f0` (2026-10-13), the review of PR #122: a request cancelled with its bill (`cancelRequestOfCancelledBill`), a card or a flat a request names never deleted (`PROPERTY_NAMED_BY_REQUEST`, `HAS_REQUESTS`), request bills stamp `issuedById`, the API's log lines without query strings, and the isolation tests; and, on `fix/pr122-review` (2026-10-15), the review's blocker and majors: a bill cancellation names the request it cancels, and a citizen reports a Whish Money transfer only.

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
  - Check outstanding fees and charges without visiting the municipal hall. A bill paid in part
    shows what is left on it and what was paid of it («سدّدت X من Y»), and the transfer the pay
    dialog asks for is what is left, which is all a confirmed report credits. A bill whose
    reported transfer waits for review is listed with its status and not counted in what is owed,
    on every portal page alike.
  - View their registered properties, apartments, shops and land parcels.
  - Sign in with their رقم مرجعي alone, with no code by SMS and no second factor, so elderly
    citizens can sign in (the product owner's decision of 2026-10-13,
    [open-decisions.md §21](docs/open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)). The risk that whoever holds the reference can act for the
    citizen is accepted ([docs/security.md](docs/security.md#known-gaps)). Nothing is sent to them by
    SMS or WhatsApp. Whoever does not have their reference asks for it at the municipality, with
    their ID card.
  - Pay in cash at the municipality or to a collector, and receive an official receipt.
  - Ask the municipality for a paper online («طلباتي» on their file): a براءة ذمة, a residency,
    occupancy or vacancy certificate, a lease registration, a renovation or sign permit, or a
    general request; attach a copy of their identity card and the papers that support it, pay
    the fee at the municipality (paying online is paused, below), follow it until it is ready, and
    collect it at the municipality with the original identity card. They see where it stands and why it was refused, never the papers back.
  - Report a Whish Money transfer made in the Whish app, with its reference. The report is a
    declaration that stays pending until a clerk matches and confirms it. It is the only payment a
    citizen reports: cash is paid at the office, and never declared.
  - Paying online through a Whish checkout is **paused** until Whish gives the municipality its
    API (the product owner's decision of 2026-10-13, [open-decisions.md §21](docs/open-decisions.md#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)): the portal
    offers no «ادفع عبر Whish», says online payment is paused, and shows where and how to pay, and
    the server refuses the checkout. Reporting a transfer made in the Whish app, above, stays; «نقداً
    في البلدية» is an instruction only and declares nothing.
- **Collectors (`COLLECTOR`, جابي) and counter clerks**:
  - Record in-person payments, full or partial, at the counter (`CASH`) or on a round
    (`COLLECTOR`). A collector records cash only as his own collection, into his own custody, or a
    Whish transfer a citizen makes at the door; the cash desk and naming another collector are the
    counter clerks'.
  - Raise no bills. Issuing a fee and charging one citizen («تكليف مباشر») are the manager's and the
    accountant's; a collector settles what they bill (decided 2026-10-12).
  - Issue official receipts matching Lebanon's printed receipt books (`وصل جباية رسمي`).
  - Share a receipt through the device share sheet, a WhatsApp link, or a PDF download.
  - See every receipt on a bill, and every reversal, on the bill's own page («وصولات الفاتورة»),
    reached from the bill's row on the citizen's file: «تسجيل دفعة نقدية» while it is owed,
    «وصولات الفاتورة» once it is paid in full or cancelled. Only the manager (`SUPER_ADMIN`) may reverse a
    receipt («عكس الوصل»), with a written reason. A reversal is an opposing entry beside the
    receipt, never an edit, and the amount is owed on the bill again. Once the treasury is live
    the money is paid back out of a wallet — the one the payment went into, a collector's custody
    only while it still holds it and otherwise the cash safe; for a payment taken before go-live,
    the cash safe or the Whish account — and the reversal is refused if that wallet cannot cover
    it. A receipt is never reversed twice: pressed again after an answer was lost, the screen says
    it is already reversed. While a Whish transfer the citizen reported on the bill waits for
    review, no receipt on it is offered for reversal: the transfer is confirmed or rejected on the
    fees page first, since a reversal would erase the report; the server refuses such a reversal
    too (`PAYMENT_CLAIM_UNDER_REVIEW`).
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
  - **إلغاء الفاتورة** (manager only): withdraw a bill nothing has been paid on — a fee issued twice,
    a charge raised in error — with a reason. The bill stays on the citizen's file, marked cancelled,
    and is no longer owed. A bill with money on it has its receipts reversed first. A municipal
    request waiting on the bill is cancelled with it: the bill's page names the request, the
    confirmation warns that it goes too, and the message after names it.
  - **تسديد الفواتير المحددة** (accountant and manager): tick several unpaid bills of one citizen —
    on «الرسوم» or on the citizen's file — and settle them in one act, in cash (ليرة and dollars at the
    municipality's rate, with the change worked out and checked against the safe), through a
    collector, or by Whish. Every bill is paid or none is. Each bill keeps its own receipt, and the
    citizen gets one «وصل قبض بلدي مجمّع» numbered «BRC-2610-0001» listing them all, to print,
    download as PDF or send over WhatsApp. A bill can still be settled on its own, and a collector
    settles one bill at a time.
  - **The treasury (الخزينة)**: live balances of the municipality's cash safe and Whish account in
    ليرة and dollars, a statement for each, and their total at the municipality's rate. A citizen payment credits
    the right wallet automatically. `SUPER_ADMIN` activates it once by entering the counted opening
    balances; the accountant works it, the auditor and view-only staff read it. Income, the
    collector handover, transfers and exchange, and the daily count and day closing are below. The
    manager adds a bank account or a petty-cash fund («إضافة حساب»); it opens at zero and is filled
    by a transfer, and a second wallet of the same name, kind and currency is refused
    ([docs/finance.md](docs/finance.md)).
  - **المناقلات والمصارفة**: money between the municipality's own wallets, in one register with the
    collectors' handovers.
    - An *internal transfer* moves one currency — a Whish cash-out, a bank deposit, topping up
      petty cash. Any bank or Whish fee is taken from the source with it and filed as its own «أمر
      صرف» under «رسوم تحويل ومصرفية»: the manager's transfer is the order of its fee; an
      accountant's fee is paid at once as an art. 35 payment with a reason the system writes, held
      to the urgent-payment ceiling, and waits for the manager's order.
    - An *exchange* sells one currency for the other: the accountant enters what left and what
      arrived (or the rate the صرّاف quoted), and the screen shows the rate against the
      municipality's own. A rate further than the allowed difference (3% unless the manager changes
      it) needs a written reason. Such an exchange, any exchange above the large-exchange threshold
      ($1,000 unless changed), and any exchange made with no official rate set are booked at once
      and wait, amber, for an auditor or the manager to approve the review, once.
    - Every transfer prints as a «سند» with the three signatures (handed over, received,
      accountant). Only the manager cancels one; its fee goes back with it, and a cancellation is
      refused while the destination no longer holds the money.
    - The two exchange settings are the manager's alone, and a citizen does not see them.
  - **الإيرادات والنفقات**: where the accountant or the manager records a receipt or a payment
    (2026-10-12; income and expenses were two pages, each with its own «new» page).
    - One form, «قبض | صرف». The amount, the wallet, the other party and the wording survive a
      switch between the two.
    - The wallet is a dropdown in which each wallet shows what it holds; once an amount is typed,
      the chosen one shows what it will hold after the entry, and a payment that would overdraw
      it is stopped with «الرصيد لا يكفي».
    - After each voucher the page says what was written, with its number, print, and a link to it
      in «الحركات المالية», over an empty form for the next one.
    - Other treasury readers who open it are told who records, and sent to «الحركات المالية».
  - **الحركات المالية**: every voucher of both kinds, for every treasury reader.
    - One list, newest first, each line with its date, under a filter bar: the period (this
      month unless another is chosen), the direction, the wallet, the category and whether
      cancelled vouchers are shown.
    - One search covers both kinds of voucher: the number, the payer or payee, the description,
      and the cheque, transfer or invoice number.
    - Picking a line opens that voucher in a side panel over the list (on a phone, the whole
      screen): every field, who recorded it, who ordered or cancelled it; print, cancel (manager)
      or order (manager).
    - What waits on the head's order is one switch away («بانتظار أمر الصرف»).
    - Those who record have «تسجيل قبض» and «تسجيل صرف» in the heading, and on a phone at the
      foot.
  - **النفقات**: the expense side of «الإيرادات والنفقات» and «الحركات المالية», and «أمر صرف».
    - Money leaves on the payment order, as the municipal accounting decree requires (Decree
      5595/1982 art. 28 and 33). The accountant prepares «طلب أمر صرف»: what, to whom, from which
      wallet, against which budget category. The manager orders it, and the voucher is written and
      paid in that act, or rejects it with a reason.
    - For a salary, a routine petty expense or an emergency (art. 35), the accountant pays at once
      with a reason, and the voucher waits for the manager's order after the fact.
    - The manager may set «سقف الدفع العاجل» in الإعدادات, one per currency (ليرة, dollar): an
      urgent payment above it cannot be made by the accountant and goes to the manager as a
      request. Left unset, there is no ceiling. Salaries are not held to it. Only the manager
      changes it.
    - The manager's own recording is the order.
    - A mistake is cancelled with a reason, which returns the money and keeps both the voucher and
      its cancellation on the record. Only the manager may cancel.
    - The treasury page shows what is waiting on the manager.
    - A salary or wage is paid from the staff list itself («صرف راتب / أجر»): the payer picks the
      wallet, the amount and the month, and the voucher is filed under «رواتب وأجور», in the staff
      member's own name and linked to their account. The manager's payout is the order; an
      accountant's is paid at once as an art. 35 payment, with the reason «راتب — يُدفع قبل الحوالة
      (المادة 35)» written by the system, and waits for the manager's order. Each staff member is paid
      one salary per month, and an accountant's payout is held to the manager's «سقف صرف الرواتب»
      (set in الإعدادات, per currency); above it the manager pays it.
    - The staff list no longer shows the field inspectors' commission cards; an inspector's earnings
      stay on their own profile.
    - An inspector's commission is paid from his row too («صرف عمولة»): the dialog shows the units
      he is credited for and what he is still owed, the manager picks a dollar wallet and sees its
      balance, and once the treasury is live the payment is a «أمر صرف» under «تعويضات المسح
      والجباية» that takes the money out of that wallet; the manager's payout is the order.
      Cancelling that voucher puts the amount back on what the inspector is owed. Before the
      treasury is live, the manager records a payout as he always did, with no wallet, dated no
      later than today.
    - An inspector is paid for the units he filed, whoever's file they are on (decided 2026-10-16):
      an owner he records on the matrix, an owner he links to a tenant, or a flat he adds on the
      edit form is his, not the officer's who registered the citizen. Until then the officer who
      registered a citizen was paid for everything later added to that file. His survey log lists
      those files too, marked «إضافة على ملف» and dated when he added the units, and his payout
      history counts them from that day. Still one dollar per flat per officer: an inspector who
      filed a tenant and then recorded the same flat's owner is paid once.
    - An inspector's payout history shows, after each payout, what was still owed then: what he had
      earned by then less what had been paid by then, with «زيادة» where a payout went past what he
      had earned. A payout whose voucher was cancelled stays listed and is not counted as paid. The
      figures are worked out from today's records, which the page says, so a registration
      corrected since can move a past row. When he has been paid more than he earned, the summary
      shows «مدفوع بالزيادة» in place of what is still owed.
    - A commission is paid like a salary (decided 2026-10-10): an accountant may pay one once the
      treasury is live, at once, as an art. 35 payment with the reason «عمولة مسح ميداني — تُدفع
      قبل الحوالة (المادة 35)» written by the system, and it waits for the manager's order. He
      cannot pay his own. He has no screen for it yet and is not shown what an inspector is owed
      (the dialog is on the manager's screens), so today he pays through the API alone
      ([docs/finance.md](docs/finance.md) §5.6).
    - A commission is paid only through «صرف عمولة»: the expense form no longer offers
      «تعويضات المسح والجباية», since a commission paid there was not counted against what the
      inspector is owed.
  - **Printed vouchers.** Every «أمر صرف» and every «سند قبض إيرادات» prints on an A4 sheet from
    its register, from the success message after recording it, and (for a commission) from the
    inspector's payout history: the municipality's letterhead and crest from الإعدادات, the number
    and date, the payee or payer, the category with its budget chapter and article, the amount in
    figures and in Arabic words, the wallet, and signature lines — the accountant, the head of
    municipality and the beneficiary on a payment order; the cashier and the accountant on a
    receipt, which also carries a QR code of its number. A cancelled voucher still prints, marked
    cancelled with its reason. «حفظ كملف PDF» is the browser's own print destination.
  - **الإيرادات**: the income side of «الإيرادات والنفقات» and «الحركات المالية», its «سند قبض إيرادات» — money that reaches the treasury without a
    citizen's bill: the Independent Municipal Fund, the state's share of telephone, electricity and
    water revenue, permits, rent on municipal property, grants, fines.
    - The accountant or the manager records the amount, the wallet it arrived in (a cash safe, Whish
      or a bank account, never a collector's custody), the source category, the payer and the cheque
      or transfer number, and the wallet's balance rises in the same act. Numbered «RV-2610-0001».
    - Only the manager may cancel, with a reason, and a cancellation is refused once the wallet has
      spent the money.
    - Citizen fees are not entered here: they credit the wallets on their own.
    - The manager manages the income categories on «بنود الإيرادات»: adds one (from that page, or
      without leaving a half-filled voucher), renames it, gives it an English name or its budget
      chapter and article, and stops or restarts it. A category is never deleted; a stopped one
      leaves the form and stays in the register.
  - **عهدة الجباة**, on its own page «الجباة والتحصيل» rather than on the treasury's, since it is
    not the treasury's money yet: what each collector is still carrying from his round, and
    «استلام الصندوق».
    - The accountant counts the notes with him and records the handover, which moves the money from
      his name into the cash safe. Nobody receives his own custody.
    - Cash a collector took at a door is never counted as the municipality's until that moment.
    - A partial handover is normal; the rest stays on his name.
    - Custody is never spent. A payment refunded after he handed it in is refunded from the safe.
  - **ما حصّله الجابي**: beside «استلام الصندوق», the people behind the figure — every receipt he
    wrote at a door, with the citizen who paid, what the bill was for, and how much. What the
    accountant reads while the notes are on the desk, and what settles «قلت إني دفعت لعلي» when a
    citizen comes back. Collected and held are two different numbers and the screen says why: the
    difference is what he has already handed in. Each collector also carries a status read off his
    receipts — «يجمع اليوم», «لم يخرج اليوم», «سلّم كل شيء» — and the day's count and takings.
  - **ترقيم المستندات**: every document the municipality issues carries its book, the month it was
    issued in and a counter that restarts each month — «INV-2610-0001» for a bill, «RCP-2610-0001»
    for the receipt, «PV-» for an expense voucher, «RV-» for an income voucher, «TR-» for a
    transfer and «BRC-» for a consolidated receipt of several bills. A number read over the phone says which book it came from. Documents issued before
    the change keep the numbers already printed on them; bills raised before it stay without one,
    because a number minted today for a document issued last year would be a fiction.
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
  pays online is an open decision ([docs/open-decisions.md](docs/open-decisions.md)); while
  online payment is paused (2026-10-13) they pay at the counter or to a collector, or report a
  transfer made in the Whish app, like everyone.
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
- **Citizens ask for papers, online or at the counter** («طلبات المعاملات», 2026-10-13;
  [docs/municipal-requests-plan.md](docs/municipal-requests-plan.md), decisions in
  [open-decisions.md §20](docs/open-decisions.md#20-municipal-requests-and-certificates-decided-2026-10-12-and-2026-10-13)).
  The manager keeps the list of what the municipality offers and the fee of each, in pounds,
  0 for free. A citizen files online with an identity copy; a clerk (the manager or the
  administrative officer) files for a citizen at the counter, for one of the properties on
  their file where the paper is about a property. The fee becomes a bill only when the person
  is ready to pay, at the counter («تحصيل الرسم»): paying online is paused until Whish gives the
  municipality its API, so the portal tells a citizen to pay at the municipality, quoting the
  request number. A paid request goes to review: the clerk writes what the
  paper certifies, or refuses it with a reason; a براءة ذمة is refused while the property's own
  bills owe anything. The paper prints under the letterhead with a QR code of the request
  number, and is handed over against the original identity card. A request is cancelled only
  while it has no bill, or with its bill when the manager cancels that bill («إلغاء الفاتورة»),
  which frees the citizen to file it again; a fee paid on a refused request is not returned on
  its own. A property card or a flat a request names is never deleted from a file: the clerk ends
  the ownership or the tenancy instead. Readers are
  the manager, the administrative officer, the accountant and the auditor — not «مشاهد فقط»,
  since the papers are identity copies — and every opening of a paper is in the activity log.
  No SMS or WhatsApp notice is sent: there is no provider for now, by the owner's decision of
  2026-10-13 (D9), and the portal shows where each request stands.
- **A citizen file is archived, never deleted** (decision of 2026-10-05). «أرشفة الملف»
  asks for the reason and who asked for it, both written to the activity log; an archived
  file is billed nothing new and keeps everything it holds, and «إعادة من الأرشيف» brings it
  back. Every way of raising a fee refuses one on an archived file, «تكليف مباشر» and a municipal request's fee included
  (`FEE_CITIZEN_ARCHIVED`, since 2026-10-14), and the fee pickers do not offer it. It takes no
  new filing either — no card, no flat, no sale: a registration that would join it, a person
  put in a flat, or a sale's buyer is refused with «أعِده من الأرشيف أولاً», on the form, from
  the offline queue (which parks it as refused) and in an import; the census and ownership
  pickers show it marked «مؤرشف» and do not take it.
- **A building's height counts its built floors, never its roof** (the user's decision of
  2026-10-07). «الطوابق المسقوفة» is every level under a roof, the ground floor and a
  «طابق أعمدة» included. The building editor says so, says how to record a duplex, and
  warns when the top rows of the matrix hold nothing, offering to lower the count; it never
  lowers it by itself, and says nothing for a building still going up.
- **A home on several levels is one unit** (decision D28, 2026-10-17). «عدد طوابق المسكن» on a
  flat or a house makes it a «دوبلكس» or «تريبلكس»: one unit, drawn across its floors in the
  matrix, the drawing and the paint grid. A per-unit fee counts it in roofs — a duplex flat at
  the municipality's factor (1.8 by default, set in Settings › المالية «معامل السقوف»), a house
  one roof per storey; two separate flats stacked on each other stay two roofs.
- **A house that grows is asked which it is.** Adding a unit to a structure whose one unit is
  on somebody's file as a «منزل» (or to a bare «منزل مستقل») asks «طابق إضافي من المسكن نفسه،
  أم وحدة مستقلة؟». The first raises the home a level; the second adds the unit and turns the
  «منزل» card into a «مبنى» card naming the house, so the household keeps its occupancy and is
  never filed twice. «ملاحظات الجودة» lists any «منزل» card left on a structure of several units.
- **«دمج كدوبلكس» (SUPER_ADMIN).** Two flats recorded as two units that are one home on two levels
  are folded into one: the lower flat becomes a «دوبلكس» with both areas, the upper one is removed
  the way «حذف تصحيحي» removes it (its file lines closed «سُجِّل بالخطأ»), its visits and cases move
  down. Refused when the two are not one household. «ملاحظات الجودة» lists the candidates.
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
- **Every staff member manages their own account.** «أمان الحساب» shows each role its own
  sign-in email and whether its second factor is on, and changes the email or the password
  with the current password typed again. A password change signs the account out
  everywhere, this screen included, and the sign-in page says why.
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
