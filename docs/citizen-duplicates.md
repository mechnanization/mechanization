# Duplicate citizens: detection, refusal and «دمج ملفين»

The identity document is no longer collected for a Lebanese citizen
(`building-census-plan.md` §13.1), so nothing unique identifies a person. This
page describes how the register recognises somebody filed twice, when it
refuses a second file, and how an administrator merges two files and undoes a
merge.

Code: `apps/backend/src/application/features/citizens/possible-duplicates.ts`
(the rule), `citizen-merge.plan.ts` (every merge decision, no database),
`citizen-merge.service.ts` (reads, writes, undo), `merged-away.ts` (the guard
other write paths share). Tenant migration **0061**.

## 1. The rule — one function, every place

`duplicateSignals` → `duplicateScore` → `isLikelySamePerson` /
`duplicateVerdict`. The same rule runs in four places, and they cannot
disagree:

| Where | What it does |
|---|---|
| Live alert «قد يكون مسجَّلاً مسبقاً» — in the form's sticky step bar, on every step and screen size (`DuplicateAlert`) | `POST /citizens/possible-duplicates` while typing; a certain match closes «حفظ وإنشاء» and «حفظ سريع» for an officer, with the reason beside them |
| Save of a new file (`POST /citizens`, form, offline queue, import) | Refuses or asks — see §2 |
| `POST /citizens/duplicate-review` | The form's question before it writes |
| Quality screen «شخص مسجَّل مرتين» | Batch scan, blocked on first name, family name, phone and رقم السجل |

Until 2026-09-28 the live panel ran the register's search box instead:
`«حسين وطفى»` matched anyone with حسين anywhere and وطفى anywhere, including
the father's and mother's names. The panel now asks the save's own question.

### Names

Folded first (أإآ→ا، ة→ه، ى→ي، digits, spaces inside a name, «ال» at the start
of a family name). Then, part by part:

- **Hard stops (NONE):** first name differs, or father's name differs when
  both are on file. Brothers differ in the first name and cousins in the
  father's name.
- Parts under 5 letters must match exactly (حسن/حسين، محمد/محمود).
- A longer part may be one letter off, **unless** it is a real different name:
  feminine forms (جميل/جميلة) or a listed pair (عبدالحسن/عبدالحسين،
  عبدالله/عبدالاله، سليمان/سلمان).
- **EXACT** / **NEAR** (typo) / **PARTIAL** (first and father's name agree,
  family name differs) / **NONE**.

### Score (ask at ≥ 3)

| Fact | Points |
|---|---|
| Three names identical, father's name compared | 3 |
| Identical without a father's name on one side, or a typo apart | 2 |
| PARTIAL with father's name compared / without | 1 / 0 |
| Same mother — written in full on both / a lone first name | +2 / +1 |
| Same phone or WhatsApp | +1 |
| Same رقم السجل (only with the father's names compared, or another personal fact agreeing; zeros ignored) | +1 |
| Same current flat (census unit) | +1 |
| Same residence permit (not with a PARTIAL name lacking the father's name) | +2 |
| Gender differs / two different permits | −4 |
| One Lebanese and one not | −3 |

**Hard stop:** both mothers on file and different → never asked.

The weights follow record-linkage practice (a fact counts by how rarely two
different people share it). They are a starting point, not a calibration: see
§6.

## 2. Refuse, ask, or say nothing (`duplicateVerdict`)

User decision, 2026-09-29: "know when to stop an officer from creating a
duplicate — do not just warn".

- **BLOCK** — the save is refused, on every path (form, offline queue,
  spreadsheet import). Reserved for evidence no two people here share:
  - three names identical or a typo apart, father's name compared, **the same
    mother written in full on both**, and one more fact of their own (phone,
    رقم السجل, residence permit or flat); or
  - the same name and the same residence permit.
  - Never when a contradiction is on file (gender, nationality, permit).
  - The refusal names the file on record (`DUPLICATE_BLOCKED`); the officer
    adds the property to it. The offline queue parks the filing on the phone as refused
    with that sentence — nothing is lost.
  - **SUPER_ADMIN only** may file past it, by naming each blocking record as a
    different person with a reason of 10+ characters.
- **ASK** — the officer answers «هو نفسه» (open their file) or «شخص مختلف»
  with a reason. Offline deliveries and imports are not asked: they land with
  the «سجل مشابه موجود» flag for the quality screen.
- **NONE** — nothing is shown.

Edits are never refused by the rule: correcting a file must stay possible.
Two existing files that turn out to be one person are merged (§3).

## 3. «دمج ملفين» (SUPER_ADMIN)

Entry points: the quality screen's compare view («دمج الملفين»), «دمج» beside
a match in the edit form's panel, and «دمج مع ملف آخر» on a citizen's page.
Every one opens `MergeCitizensDialog`, which shows the server's preview and
requires a reason and the absorbed file's reference typed back.

What a merge does, in one transaction with both citizens and every affected
third-party card locked:

- The file registered first stays by default; «بدّل» swaps.
- The absorbed file's registrations move to the kept person. Every **current
  card** moves onto the **newest filing**, because billing, the edit form and
  the census sync read only that one. A moved card keeps crediting the officer
  who filed it (`property_entries.filedRegistrationId`, read by `cardsFiledOn`
  in both pay screens — user decision, 2026-09-28).
- A flat recorded on both files ends on the absorbed side as «سُجِّل خطأً».
  Its officer loses that dollar (user decision, 2026-09-28), and the dialog
  names who. A card is ended «سُجِّل خطأً» only if nothing on it ended for a
  real reason before.
- Census spells, bills, Whish checkouts, cases, individual fee notices, tenants'
  landlord links (and their footprints and mints) and «ليس هذا المالك» answers
  follow the person. Open «مُعاد للتصحيح» returns move to the newest filing.
- **A bill both files carry for the same notice and period stays on the
  absorbed file, untouched.** The register allows one per person per period,
  and no tool cancels a bill. The accountant sees it in «فواتير تأثّرت
  بتصحيحات» (merges count as corrections).
- Fields the kept file lacks are filled from the other; fields both answer
  differently keep the kept file's answer (listed in the dialog). The identity
  document is unique, so it moves.
- «غير مؤكَّد» flags are re-anchored to the card and row they named — read with
  the edit form's own query, and written at the positions that query returns
  after the move. Cards saved in one filing share `createdAt` to the
  microsecond, so their order is whatever the database returns (see §5).
- The absorbed citizen is deactivated and its portal sessions end. Before
  commit the merge checks that nothing landed on it meanwhile.

Refused (with the step that unblocks it): same file, a deactivated or
already-merged file, a flat owned on one file and rented on the other, a
duplicate copy written by a tenant's link, one file renting from the other, a
non-resident kept file receiving a card that says they live here, more than 25
resulting cards, or a preview that went stale.

### Undo «التراجع عن الدمج»

Reverts exactly what the footprint recorded, **refused once either file
changed** (compared by row content, not timestamps, so a chain of merges undoes
in reverse order). Flag reasons kept for the undo are redacted once it has run.

### A merged-away file

`assertNotMergedAway` refuses edits, reactivation, occupancies, a sale to it,
and individual charges. Cases refuse any inactive file. Deleting either side of
a standing merge is refused. Pickers skip it, the register shows «مدموج في ملف
آخر», and dashboards leave it out of population counts. The kept file's history
includes the absorbed file's trail. The absorbed file's رقم مرجعي no longer
logs in to the portal; that is deliberate — following the merge would hand one
person's slip the other's file if the merge were wrong.

## 4. Deploy order

Tenant migration **0061_citizen_merges** is additive (a table, one nullable
column, FKs; indexes only on the new table). **Apply it before the code**: the
pay screens read `filedRegistrationId`. In-app backup snapshots are now v4;
v3 snapshots are refused, as the backup service does on every table change.

## 5. Known limits

- **Card and row order on a multi-card filing is not deterministic app-wide.**
  Rows and cards saved together share `createdAt`, and every positional reader
  (edit form, profile, landlord link, census) orders by `createdAt` alone. The
  merge matches the form's query exactly, but a later update can still reshuffle
  ties for *any* file. The fix is to add `id` as a tie-breaker in every
  positional reader at once, with a one-off re-anchoring of existing flags —
  its own change.
- Record reviews: the self-review guard and quality sampling still attribute a
  moved card to the newest filing's officer. Officer pay and the two quality
  findings use the filing officer.
- The merged-away guard is a read, not a lock: a matrix write in the same
  sub-second as a merge can still land on the absorbed file if it commits after
  the merge's final check.

## 6. Research and decisions still open (2026-09-29)

Sources: US Census Bureau PVS (Fellegi–Sunter, blocking passes, clerical review
band), ONS Census 2021 linkage, AHIMA patient-matching practice, WFP SCOPE
adjudication and WFP audit AR/21/08, World Bank ID4D, Lebanese DGCS voter
lookup, Law 81/2018. Findings that changed the rule above: mother's full name is
the strongest corroborator after the name; rare-value agreement counts more; a
family fact (سجل, household phone) never decides alone; contradictions weigh
against a match; never auto-merge (Law 81/2018 Art. 86).

Needs a product / policy decision, not a code change:

1. **Year of birth.** Every comparable registry anchors on date or year of
   birth. Suggested: collect the year only, score +2 same, +1 within a year, and
   a hard stop when more than two years apart. Personal data: the form must say
   why (Art. 87–88).
2. **محل القيد** (place of civil registration), as a list of localities. It
   makes رقم السجل meaningful (+2 when both agree). Do not collect المذهب.
3. **Blood type** is health data under Art. 91 (explicit consent or a licence)
   and carries no matching value. Legal review recommended.
4. **Calibration.** After a few hundred officer answers, re-derive the weights
   from how often each fact agreed for real duplicates versus different people.
5. **Common names.** A triple name held by three or more files should count
   less (term-frequency weighting).
6. **Research suggestion not applied:** "a triple name alone should not
   interrupt the officer" (ask at 4, queue at 3). That reverses the earlier
   decision that three identical names always ask; left as it was.
