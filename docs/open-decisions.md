# Open decisions

Things this codebase cannot decide for itself. Each one is flagged in the
architecture spec; this file is where they are tracked to a resolution, with
what the code currently does in the meantime.

**Four of these block handling real citizen data.** They are marked 🔴. The
system is buildable and demoable without them; it should not collect a real
person's national ID number until they are answered.

---

## 🔴 1. Legal basis and retention policy for the data collected

**Status:** unanswered. Owner: whoever is accountable for the municipality's
data handling — not an engineering decision.

This system stores, per citizen: full name, national ID or passport number,
civil record number, residency number, phone, family size, home address and
coordinates, scanned identity documents, and **refugee / displaced status**.
That last field, combined with an address, is the kind of record that causes
concrete harm to a real person if it leaks or is handed to the wrong party.

Needed before real data is collected:

- A stated legal basis for holding it, and for holding residency status
  specifically.
- A retention period, and what happens at the end of it. Right now nothing is
  ever deleted — there is no retention job, because inventing a deletion policy
  in code would be worse than the absence of one.
- Who inside the municipality may see what. `AUDITOR` and `FIELD_INSPECTOR`
  exist as roles but the split between them was chosen by this codebase, not by
  the municipality.
- What a citizen may request: correction, export, deletion. None of these
  currently have an endpoint.

**Current behaviour:** all data is retained indefinitely. Audit entries redact
identity numbers (`AuditLogEntry.redact`), so the audit trail is not a second
copy of the sensitive fields, but the primary tables hold everything.

---

## 🔴 2. OTP delivery fallback

**Status:** structurally implemented, no provider chosen.

SMS delivery to Lebanese networks fails or stalls often enough that a single
provider makes citizen login a coin flip — and a citizen who never receives a
code has no other way in. The v1 spec had no answer here at all.

**What is built:**

- Two delivery routes (`SMS_PROVIDER_API_KEY`, `SMS_PROVIDER_FALLBACK_API_KEY`).
  From the second resend, `OtpService` switches to the fallback route rather
  than retrying the one that just failed.
- A visible resend path with a 30s cooldown, showing the citizen that waiting is
  expected.
- ~~Production boot **fails** without both keys set (`env.schema.ts`).~~
  **Removed 2026-09-05.** The check demanded credentials for a route that
  cannot carry a message — `deliver()` throws with both keys set exactly as it
  does with neither — so all it enforced was a boot failure. Production now
  starts without them and `SmsProviderService` logs an error at boot instead.
  Restore the check in the same change that implements `deliver()`; at that
  point the keys mean something again.
- The login page tells a citizen who cannot receive a code to visit the
  municipality with their رقم مرجعي.

**What is not built:** `SmsProviderService.deliver()` throws — the actual HTTP
call cannot be written before a provider is chosen. Everything around it
(channel selection, failover, masking phone numbers in logs) is real.

**Still to decide:** which two providers, and whether a staff-assisted
registration path is needed for citizens who cannot complete OTP at all. The
counter fallback above is a workaround, not a feature.

---

## 🔴 3. Production hosting and data residency

**Status:** unanswered. Blocks launch, not development.

Candidates named in the spec: Railway, Fly.io, a VM. The deciding factor is not
price — it is whether this data may sit outside Lebanon, which is question 1's
territory.

Also unresolved by hosting choice:

- **Supabase region.** The example `DATABASE_URL` points at `ap-south-1`
  (Mumbai). That is almost certainly wrong for Lebanese citizen data and should
  be a deliberate decision, not a leftover from whichever region was clicked
  first.
- **Backups**: who takes them, where they live, and whether they inherit the
  same residency constraint. A backup in another jurisdiction is still data in
  another jurisdiction.

---

## 🔴 4. Duplicate-person tolerance

**Status:** partially decided in code; the product question is open.

v1 flagged `@@unique([phone, lastName])` as "a disambiguation aid, not a hard
identity gate". This codebase changed the key to
`@@unique([identityDocType, identityDocNumber])`, which is stricter and more
honest: a household shares a phone, so a phone was never an identity.

**What that still does not solve:** the same person can register twice under
different document types — once with a national ID, once with a passport — and
the system will see two people. Tightening further means rejecting legitimate
registrations from people whose documents genuinely differ.

**The product question:** which error is worse here — a duplicate claim, or a
displaced person turned away at the form because their paperwork does not match
what the municipality has on file? That is a policy call about fraud tolerance
versus access, and it should be made by the municipality rather than defaulted
in a schema.

---

## 5. Horizontal scaling → rate limiting **and the job schedule**

**Status:** decided, with a documented trigger.

**Two** things in this codebase assume a single long-lived backend process, not
one. Both break on the same day, and this list was missing the second until
2026-09-21.

**Rate limiting.** `@nestjs/throttler` uses in-memory storage. This is correct
for one instance and wrong the moment there are two: per-instance counters make
the effective limit N× what is configured, so staff login would allow 5×N
attempts per minute.

**The job schedule.** `ScheduleModule` registers in-process `@Cron` timers, so
every replica that boots with them is a *separate scheduler*. Two replicas is
two `RecurringBillingJob` runs at 02:00 UTC.

Worth stating precisely, because it is **not** the same severity as the
throttler: no citizen gets billed twice. `runRecurringBilling` writes through
`createMany({ skipDuplicates: true })` against the unique
`(citizenId, feeNoticeId, periodKey)` triple, which Postgres serialises as
`ON CONFLICT DO NOTHING` — the second run inserts nothing and, because the
`fee.issued` event is emitted only when `created.count > 0`, does not
double-announce either. OTP pruning is idempotent by construction.

What a second scheduler does cost is real but quieter: every run re-resolves
every notice's targets and re-assesses every citizen and building
(`assessTargets`), so N replicas is N× that load against the pooler at the same
minute, N copies of the "not assessed" warnings in the log, and N attempts at
the same rows. And the operational point stands regardless of the blast radius:
**nothing in the deployment says which process is supposed to run it.**

`SCHEDULER_ENABLED` (`env.schema.ts` → `isSchedulerEnabled`) is what decides it.
**Unset means the old behaviour — run unless `VERCEL` is set** — so the flag
changes nothing until someone sets it; that default exists so that shipping the
flag could not be the reason billing quietly stopped. It is not a safe default
for a second replica, because the second replica's environment also does not
set `VERCEL`.

**Trigger to revisit — the first time a second backend replica is deployed.**
On that day, both of these, not one:

1. Move the throttler to Redis. That is the one piece Redis needs to come back
   for; nothing else in v2 depends on it.
2. Set `SCHEDULER_ENABLED=false` on every replica but one — or `false` on all of
   them and drive the jobs from an external scheduler through
   `InternalCronController`, which is what the Vercel deployment already does
   and is the better answer once "which box is the one" stops being obvious.

**Open, and not an engineering call:** which runtime owns the schedule. The
repository contains a Vercel deployment (`apps/backend/vercel.json`, with
`crons`) and a Docker deployment (`apps/backend/Dockerfile`,
`docker-compose.yml`), and no artefact for any other host. If the API in fact
runs somewhere else — a VM behind nginx, say — then nothing in this repository
describes how it is started, `VERCEL` is unset there, and that box has been the
scheduler by default since it was stood up. Someone has to say which it is and
write it down here; it cannot be derived from the code.

---

## 6. Tenant count → migration strategy

**Status:** decided, with a documented trigger.

Schema-per-tenant means every migration runs once per municipality
(`pnpm tenant:migrate-all`). At tens of tenants this is a loop and a non-issue.

**Trigger to revisit:** low hundreds of tenants, or a migration that takes long
enough that the loop becomes a deployment window problem. Not before — the
isolation guarantee is worth this cost at the expected scale.

---

## 7. Wizard field spec

**Status:** derived, needs confirmation.

The architecture doc references a companion `wizard-architecture-spec.md` as the
field and validation source of truth for the 7-step wizard. That document was
not available. The wizard was instead derived from:

- the Zod schemas in `packages/shared-schemas` (which already encoded the
  occupancy and property-type conditional axes as discriminated unions), and
- the `Albazourieh` reference implementation's `CitizenWizardForm.tsx`.

**Assumptions made, worth checking against the real spec:**

- Step order: personal → contact → properties → locations → documents → review →
  declaration. Properties span steps 3–4, matching the "Steps 3–4" comment in
  `property.schema.ts`.
- `صفة الإقامة` describes the person, never the property, and only *suggests* a
  property type (`SUGGESTED_PROPERTY_TYPE`) — it never gates one.
- Required proof follows occupancy: `RENTAL_CONTRACT` for a tenant,
  `OWNERSHIP_PROOF` for an owner, and **nothing for a شاغل بتسامح** — no بدل is
  paid so there is no عقد إيجار, and the سند الملكية names the owner, who is
  not the person filing. `requiredProofDocument` returns null for that case
  rather than demanding a paper that does not exist. Worth confirming with the
  municipality that a card with no attachment is acceptable there.
- Location is optional on every property.

---

## 8. Credential rotation

**Status:** action required now.

The project brief contained what appear to be live credentials in plain text: a
Supabase database password and a JWT secret. Anything pasted into a chat, a
ticket, or a shared document must be treated as disclosed.

**Rotate before any real use:** the Supabase database password, the service-role
key, and `JWT_SECRET`. Rotating `JWT_SECRET` invalidates all existing sessions,
which is harmless now and disruptive later — so do it now.

That still holds with staff refresh tokens, and covers them too: the hash each
refresh token is stored under and the name of its cookie are both keyed off
`JWT_SECRET`, so after a rotation no stored token matches and every staff
member, «تذكّرني» included, signs in again. There is no separate refresh secret
to rotate or to forget.

No real secret is committed to this repository; `apps/backend/.env.example`
contains placeholders only.

---

## 9. Who is accountable for a «يتطلب مراجعة» record, and by when

**Status:** unanswered. Owner: the municipality, not engineering.

A field officer may now register a citizen with named fields left
«غير مؤكَّد / بانتظار المعلومة», each with a written reason. That was the only
honest alternative to the two things the form used to force: invent a value, or
do not register the person. What it does not decide is what happens next.

Needed from the municipality:

- **Who owns the queue.** A record filed with three unestablished fields sits in
  «يتطلب مراجعة» until someone opens it and fills them in. Nothing currently
  assigns that to a person or a desk, so on present behaviour it is whoever
  notices.
- **How long is too long.** There is no deadline, no escalation and no reminder.
  A parcel number missing for a week is a normal afternoon's work; missing for a
  year is a register that has quietly stopped being accurate about that
  household — and the two look identical on screen today.
- **Whether an incomplete record may be billed.** It is billable now: the
  citizen is registered from the moment the row exists, and the fee engine does
  not read this status. That is deliberate — a household should not escape
  رسوم because a clerk could not reach their landlord — but a fee notice for a
  property with no رقم العقار is a document somebody has to be able to defend.
- **What may never be flagged.** The code fixes a minimum
  (`NON_FLAGGABLE_FIELDS`: the name, the nationality question, and the two
  property discriminators) on structural grounds — a record with no name cannot
  be found again, and the rest of the form branches on the others. Whether the
  municipality wants the identity document on that list too is a policy call
  this codebase should not make on its own.

**Current behaviour:** flagged records are stored, billable, searchable, and
counted on the registry's «يتطلب مراجعة» filter with the number of fields still
open. Each flag keeps the officer's reason verbatim, and filling a field in is
what clears it — there is no separate "resolve" action to forget to perform.
Nothing expires, nothing escalates, and nobody is notified.

---

## 🔴 10. A رقم العقار the cadastre has never heard of

**Status:** the code has stopped refusing these. Whether that is where the line
belongs is the municipality's call.

Until now a property number absent from the imported cadastre was rejected
outright, on the reasoning that it could only be a typo. That reasoning held at
a counter and broke completely in the field: a record filed with no signal is
validated in the browser, queued, and promised to the officer as sent — and
then refused hours later on sync, in a settlement nobody is going back to, over
a number the officer read off the deed in front of them. The register was
losing whole households to a check meant to catch a mistyped digit.

The number is now kept as read. The record is stored, the parcel is annotated
«بانتظار التحقق» with the reason attached, and the whole record lands in the
same «يتطلب مراجعة» queue as any other open question. Nothing is guessed at and
nothing is discarded; the typo is caught by the person who was always going to
have to catch it, with the household's data in front of them instead of a
blank. The annotation is re-derived on every save, so a record held only because
its parcel was missing clears itself the first time anyone saves it after the
survey office imports that parcel.

Needed from the municipality:

- **Whether an unverified parcel may be billed.** Same question as §9 and the
  same current answer — yes, it is billable from the moment the row exists —
  but sharper here, because the fee notice would carry a رقم العقار the
  municipality's own registry does not contain. That is a document somebody has
  to be able to defend at a counter.
- **How stale a cadastre is allowed to get.** This change moves the cost of an
  out-of-date cadastre from the officer (whose record was refused) to the
  reviewer (whose queue now grows). That is the right direction, and it stops
  being right if the survey office's export is a year behind and the queue is
  mostly parcels that do exist.
- **Whether a bulk import should behave the same way.** It now does: a
  spreadsheet row with an unknown parcel used to fail the row and is now
  imported as «يتطلب مراجعة». For a municipality's existing paper register —
  the case imports exist for — keeping the data and flagging it is almost
  certainly right, but it is a change in what a clerk sees after an upload.

**Current behaviour:** submission and edit both report rather than refuse. A
municipality with no cadastre imported is unaffected — there is nothing to
check against, so nothing is annotated. Only the server may raise this
annotation; one sent by a browser is discarded and recomputed, so a phone that
queued a record days ago cannot replay a verdict the cadastre has since
outgrown.

---

## 🔴 11. Whether a fee is charged per citizen or per unit

**Status:** the code can now do either. Which one applies, and to which fees, is
a council decision with a legal basis behind it — not a deploy.

The register could always record that a citizen holds six shops. The biller
could not read it. A notice's `amount` *was* the invoice, and the only question
ever asked of a citizen's holdings was a boolean — do they have at least one of
these — so six shops and one shop were billed identically. That was never a
policy anyone chose; it was the shape of the code.

A notice now carries a **basis**. `FLAT` is the old behaviour and the default,
so every notice already issued keeps charging exactly what it charged, and this
change alters nobody's bill until someone deliberately issues a notice on one of
the other two: `PER_UNIT` (rate × units held) or `PER_AREA` (rate × total m²).
Each invoice stores the breakdown it was computed from, so the number can be
defended at the counter against the register as it stood the day the bill was
raised.

Needed from the municipality:

- **Which fees move, and on what authority.** Moving رسم المحلات to `PER_UNIT`
  multiplies what some residents owe. That needs the by-law it rests on named
  before it is switched on, and residents told before the first notice lands.
- **A dry run first.** Before switching a live recurring notice, issue it once
  and read the assessment: the system reports who would be billed what. A
  municipality should see the distribution — especially the largest bills —
  before residents do.
- **What happens to unsurveyed buildings.** A مبنى whose units were never
  surveyed cannot be assessed per unit, and the code **refuses to guess**
  rather than counting it as zero: counted as zero, the largest building in the
  municipality would pay nothing, and the schedule of fees would be most
  generous to exactly the properties worth the most. Those citizens are named
  in the issue result and left unbilled. Somebody has to own chasing that
  survey, which is the same unanswered question as §9.
- **Whether area data is good enough to bill on.** `PER_AREA` is only as honest
  as the areas in the register. A unit with no recorded area is refused rather
  than defaulted, but a *wrong* area bills wrongly and looks fine.

**Current behaviour:** basis defaults to `FLAT` everywhere, including for every
existing notice. Recurring notices re-assess each period, so a citizen who
registers two more shops is billed for them next month and one who sells a
building stops paying for it. One invoice per citizen per period regardless of
basis — never one per unit — because the settlement, receipt, Whish and
collector flows all key on a single payment row, and a citizen at a counter
should get one bill that can explain itself rather than six that cannot.

---

## 🔴 12. Who bears each fee — الرسم على الشاغل أم على المالك

**Status:** the register can now say who occupies each unit, and each notice
says whether it falls on the occupant or the owner. Which of the two applies to
which fee is a council decision with a legal basis behind it — the same bar as
§11, for the same reason.

Lebanese practice has always distinguished الشاغل — the person occupying a
property, who owes the القيمة التأجيرية and رسم النظافة — from a شاغر unit,
which has no occupant and is conventionally relieved of those fees while
remaining liable for the foundational ones (أرصفة, مجاري). The register could
express neither: occupancy was OWNER or TENANT, so a شاغل بتسامح was filed as a
tenant, and a unit had no state at all, so a landlord's empty third floor and
his occupied second were identical rows.

Two columns now carry it. `PropertyEntry.unitStatus` (مشغولة من المالك / مؤجرة
/ شاغرة / قيد الإنجاز) records what each unit is, per unit; `FeeNotice.bearer`
records who owes the fee, per notice.

**The bearer is the question, and vacancy is one of its answers.** This started
as a boolean — "does this notice charge empty units?" — and that was a symptom
mistaken for the disease. It could not reach the other half of the same
problem: a مبنى is filed once by its owner and again, flat by flat, by each
tenant, so under a per-unit notice the same apartment was charged twice, to two
people. No municipality would choose that; it survived only because nothing
could tell an owner's own home from an owner's let flat. Both halves fall out
of one fact:

- **`OCCUPANT`** — رسم النظافة, القيمة التأجيرية. An owner pays for what they
  live in, a مستأجر and a شاغل بتسامح for what they occupy, a let flat is
  billed to its tenant alone, and an empty or unfinished unit to nobody.
- **`OWNER`** — الأرصفة, المجاري, and the rest of الرسوم التأسيسية. The deed
  holder pays for everything they own, occupied or not; tenants owe none of it.

There is deliberately no third value meaning "charge everyone holding it". That
was the old behaviour, and it is double taxation of one unit rather than a
policy anyone would adopt.

Needed from the municipality:

- **Which bearer each fee carries, and under which article.** This is now a
  required choice on every non-flat notice rather than a default someone can
  arrive at without meaning to, and it is the one decision that determines both
  who is billed and which units are exempt.
- **Whether قيد الإنجاز should be separable from شاغرة.** An occupant-borne fee
  exempts both, since nobody is in either. An owner-borne fee charges both,
  since both are owned. A council wanting to relieve construction from an
  owner-borne fee has no way to say so today; that would be a second flag, not
  a deep change.
- **Who re-checks a unit's status, and how often.** This is the sharp edge and
  it has no technical answer. A flat marked شاغرة in March and let in April
  keeps billing as exempt in December, because recurring notices re-assess
  against whatever the register currently says. Unlike an unsurveyed building —
  which refuses to be billed and names itself — a stale status looks like a
  complete record. Same unanswered question as §9, arriving on a field that
  costs money.

**Deliberate asymmetries, so they are not read as oversights:**

- **A unit nobody marked is charged.** Null means "not asked", never "empty".
  This is also what makes `OCCUPANT` safe as the default: on a register with no
  حالة الوحدة recorded anywhere, every unit reads as occupied by its owner, so
  the owner is billed for all of them and each tenant for their own — exactly
  the arithmetic that came before any of this existed. The double-charge
  corrects itself only as landlords actually mark units مؤجرة, which is the one
  mechanism that does not require guessing on their behalf.
- **The field is optional everywhere.** A required four-way choice on all twenty
  flats of a building is answered by thumb, not by looking — and a guessed
  exemption is worse than no exemption. The units editor offers a "set all"
  control instead, so the common case is one tap and the officer is left with
  the units that actually differ.
- **Only an owner is asked.** A مستأجر or a شاغل بتسامح *is* the occupant of
  what they are filing. `PropertyEntry.normalise` strips a status from any
  non-owner card, because a «شاغرة» left behind by an occupancy change would
  claim the filer does not live there — and could exempt them from a fee they
  owe.
- **Units left out are counted, not merely omitted.** Every invoice stores
  `excludedUnitCount` and the issue result reports the total. Revenue absent by
  design is still revenue absent, and it has to be a number somebody can take
  to the council rather than a difference nobody can see.
- **FLAT ignores the bearer entirely.** A flat notice never asks the register
  what anyone holds, so there is no unit for a bearer rule to include or
  exclude. The consequence is that "a flat annual charge on property owners"
  is not currently expressible; say so if it is wanted.

**Still not solved by any of this:** a vacant unit whose owner never registered
is invisible, because the register is keyed to citizens and a property card
only exists under one. This records the vacancies of people the municipality
already knows about; it is not a vacancy census.

---

## 13. Whether a confirmed owner link may be billed

**Status: decided 2026-09-11 — yes, a confirmed link puts the structure on the
owner's file, and the file is what bills.** The reasoning and the remaining
exposure are below; the council question that is *not* settled by it is the last
bullet.

`PropertyEntry.landlordPhone` has been collected since the first migration and
compared against nothing. A tenant's file named their owner and gave a number
for them, and the register could not tell you whether that number belonged to a
citizen it had registered. الأرصفة and المجاري fall on the deed holder
(`FeeNotice.bearer = 'OWNER'`), so an owner the register could not recognise was
an owner nobody billed — with no row anywhere saying how much was going
uncollected, or on how many units.

**What is built:**

- `landlordCitizenId` on `PropertyEntry` — the owner named here *is* this
  registered citizen. Written only by `LandlordLinkService.confirm`, which is
  only reachable from a screen where a person said yes.
- `landlordLinkDismissedAt` — and this one was ruled out. The two are the only
  stored state, because the *match* is derived (any card whose `landlordPhone`
  equals some citizen's `phone` or `whatsapp`) and only a human's answers are
  not.
- The question asked twice: inline in the form while the officer is still with
  the tenant, and from «روابط المالكين» for the ones nobody answered.
- Confirming records an `OWNER` occupancy on every canonical unit the card
  names, so the matrix shows them.

**Why nothing links itself.** A phone is not an identity in this schema and says
so in its own comment — `User` is unique on the identity document *because* «a
household commonly shares one phone». A father and son on one line are one
number and two people. `confirm` additionally re-checks that the number actually
belongs to the citizen being named, so a request pairing an arbitrary citizen
with an arbitrary card is refused rather than recorded as a confirmed match.

**What a confirmed link does, as decided.** It mints a property card on the
owner's own registration where they had filed none on that structure. This was
initially withheld on the grounds that `PropertyEntry` is the citizen's record of
what *they filed*, and minting one asserts something on their behalf. That
restraint was overridden deliberately, because the alternative was strictly worse
in the field: `assessCitizen` bills from property cards and `attachOccupancies`
consults occupancies only to itemise a مبنى card naming no flats of its own — so
without a card the register knew the person owned the flat, showed them on the
matrix, and billed nobody. الأرصفة and المجاري went uncollected on a unit the
municipality could name.

Two restraints keep the minted card honest, and both are load-bearing:

- **No unit rows.** The card claims the *structure*, not a list of flats nobody
  enumerated on the owner's behalf. That is also what makes it self-maintaining:
  an empty `units` array is exactly what `heldThroughOccupancy` answers for, so
  the claim tracks every flat the owner is linked to — now and after the next
  tenant — instead of freezing at whatever one tenancy happened to name.
- **An existing card is never touched.** If the owner already filed for this
  building, that is their own account of what they hold. Topping up an *itemised*
  card would also silently change how it is billed: an itemised card stops
  consuming the occupancy list, so adding the flats from a single tenancy could
  *reduce* what the owner is charged.

A منزل is the one shape that carries a حالة: it bills its single unit from its
own columns, so the card states «مؤجرة» / «مشغولة بتسامح» — otherwise `bearsFee`
reads the null as "nobody was asked" and charges the owner the occupancy fee
their tenant is already paying. A `TENT_SHELTER` gets no card at all, because
`branchFieldsOnly` would drop its link on the first edit and leave a holding
attached to nothing.

Needed from the municipality:

- **Whether a third party's statement may raise a bill. This is the one still
  open, and it is now live rather than hypothetical.** Confirming says a tenant
  named this person and a clerk recognised them. It is not a deed. A notice for
  الأرصفة now *can* rest on it, and that notice is a document somebody has to
  defend at a counter against an owner who never declared the property — a
  different conversation from one resting on a card they filed themselves. If the
  council's answer is no, the remedy is not to unpick the link: it is to keep
  owner-borne notices off these cards until the owner confirms, which the register
  can express and nothing currently asks it to.
- **What the owner is told, and when.** Nobody is currently notified that they
  have been recorded as owning something on somebody else's say-so. If this
  becomes billable, being told by the invoice is the wrong way to find out.
- **Whether confirming should prompt a declaration instead.** The cleaner path
  may be that a link opens a task — "ask this owner to file their holdings" —
  rather than being treated as the filing. That keeps the invariant and gets
  better data, at the cost of another visit.

**Current behaviour:** a confirmed link writes the `landlordCitizenId`, an
`OWNER` occupancy on each canonical unit the tenant's card names, and — where the
owner had filed nothing on that structure — a property card on their file. No
existing invoice changes, and recurring notices re-assess each period, so a link
confirmed today is picked up at the next assessment rather than backdated.

`unbilledOwnedUnits` still counts what remains recorded and unbilled: an owner
whose only card on the building was filed as a مستأجر, a `TENT_SHELTER` that
cannot carry the link, a citizen with no registration to hang a card on.
«روابط المالكين» prints it above the queue. Revenue absent by design is still
revenue absent, and it has to be a number somebody can take to the council rather
than a difference nobody can see.

---

## 🔴 14. What proves a returned record was actually corrected

**Status:** open. The code does what it can and says so; the rest needs a
decision about the vocabulary.

Returning a record flags one or more `REVIEW_FIELD` values — `NAME`,
`MOTHER_NAME`, `PHONE`, `HOUSEHOLD`, `RESIDENCE`, `PROPERTY`, `OCCUPANCY_ROLE`,
`UNIT_LINK`, `AREA`, `UNIT_STATUS`, `LANDLORD`, `DUPLICATE`, `OTHER` — and a
sentence of prose. Any subsequent save by anyone used to close every open return
on the record, without looking at either.

Two halves, and only one of them is decidable in code:

**Fixed.** A return naming a flag that is *checkable against a column* now stays
open while that column is still empty. `MOTHER_NAME` and `PHONE` are the two —
both nullable, both gaps an officer is asked to fill. «اسم الأم ناقص» is no
longer answered by a save that corrected a phone number.

**Open.** The rest of the vocabulary is categorical, not a set of record paths.
`PROPERTY` covers an entire card; `OTHER` covers whatever the reviewer typed.
Nothing mechanical can show that a save addressed «العنوان على الشارع الخطأ», so
those flags keep the old behaviour — the first save closes them. That is a
known, deliberate gap, left visible rather than papered over with a check that
would look like verification and would not be one.

The choice is between:

1. **Leave it.** A reviewer's return is a conversation, and the officer saving
   the record is the reply. Cheap, and wrong whenever the officer saved for an
   unrelated reason.
2. **Narrow the vocabulary** so every flag names something checkable, and let
   `OTHER` never auto-close — the reviewer closes it by hand. More honest, more
   clicks, and it needs the field list re-cut with the people who use it.
3. **Compare the saved payload to the flagged areas.** Needs `citizen.changed`
   to carry which areas a save touched, which it does not today: the payload
   carries an `after` summary, not a diff.

**Also recorded here:** who closed it. The «إكمال السجل» dialog saves through
`updateCitizen` like any other edit, so a reviewer filling a gap themselves
triggered the auto-close under their own id and the record read as
`RECORD_CORRECTED` — "the officer went back and fixed it", when nobody did. The
announcement now carries `resolvedByReviewer`, the flags it closed, and what it
left open. That does not decide the question above; it stops the trail being
misleading while it is open.

---

## 🔴 15. An orphaned Whish checkout

**Status:** open, and newly *visible* rather than newly created.

`startWhishCheckout` creates a checkout at the provider, then marks the invoice
`PENDING_REVIEW`. Those are two steps with a network round-trip between them,
and the invoice can be settled at the counter in the gap.

That write is now conditional — it carries the status it was quoted against — so
a counter settlement can no longer be silently dragged back to `PENDING_REVIEW`
with the cash already in the drawer. The citizen gets a refusal and is asked to
refresh.

What that leaves is a live checkout at the provider that no row references. If
the citizen was already redirected and pays it, the success callback arrives
with a reference no invoice carries, is logged as an unknown reference, and **the
money is not banked**. The race is not new; the fix converted a silent
corruption into a visible orphan, which is the better failure but not a
resolved one.

Three ways to close it, and the choice is the municipality's:

1. **Accept the orphan.** Smallest change. It becomes a manual reconciliation
   case, which needs somebody to own it and a way to spot it.
2. **Reserve the invoice before calling the provider,** rolling back to `UNPAID`
   if the provider call fails. Closes the orphan; leaves a stuck
   `PENDING_REVIEW` if the process dies between the two.
3. **Cancel the checkout at the provider on refusal.** Correct, and needs a
   `WhishGateway` method that does not exist today.

None of this is urgent while the provider is unimplemented —
`whish-gateway.service.ts` throws unconditionally and both environments hold
zero payments — which is exactly why it is cheap to decide now and expensive to
decide after the first live checkout.

---

## 16. The head's account, habitability, the fee hold and archiving (decided 2026-10-05)

**Status:** decided by the product owner on 2026-10-05, in the review of
`PR #88`; built on `fix/pr88-review`.

1. **«مشاهد فقط» (`VIEWER`) is the municipality head's account.** It reads the
   dashboard, the reports and the register with its citizens' data, and does
   nothing else.
2. **An automatic fee hold** on any unit read «غير صالحة للسكن», until a
   re-inspection reads it habitable.
3. **A citizen file is never hard-deleted.** It is archived, with a written
   reason and who asked for it.
4. **The UN-Habitat scale stays verbatim**, and habitability is a separate
   yes/no answer, prefilled where the level decides it (a collapse is never
   habitable).

What the code chose inside those decisions, for the owner to confirm or undo:

- **The hold covers the fees the occupant bears**: the rental-value fee and the
  annual maintenance fee, which Law 60/1988 (Art. 11, Art. 79) ties to actual
  occupancy. A fee the owner bears follows the deed and is still charged.
- **Nothing is back-billed.** The hold is recomputed on every daily run, so a
  unit read habitable again is charged from the next run: for the period in
  progress when the citizen has no bill for it yet, otherwise from the next
  period; periods already billed without it stay uncharged. A one-off fee has no next
  period: a held unit is not charged it unless a clerk issues it an individual
  fee after the re-inspection, which the issue toast says.
- **A reading that judged nothing leaves the hold standing.** A later «غير مصنّف»
  reading with no habitability answer — a satellite pass, say — does not end a
  hold a field visit started; only a reading that answers does.
- **Older readings count.** A reading from before the question, at collapse or
  evacuation, is read as uninhabitable from the day this deploys, so units
  already recorded that way stop being charged occupant-borne fees from the
  next issuance. Their number on production was not counted (no access during
  the change). Before the release, count the readings that can do it on each
  tenant, by target: `SELECT ("unitId" IS NULL) AS whole_building, count(*)
  FROM damage_assessments WHERE level IN ('TOTAL_COLLAPSE', 'UNSAFE_EVACUATE')
  AND habitable IS NULL GROUP BY 1`. It counts readings, not units: a
  whole-building reading holds every flat in that building, and a later reading
  that answers releases one, so it bounds the impact in neither direction —
  read the whole-building rows building by building.
- **The head's account is never shown a رقم مرجعي.** The reference is a sign-in
  credential, not citizen data, so it is masked for that role in every response,
  and its searches leave the reference out, so typing one finds nobody. It also
  cannot export the register or read the activity log (`AuditController`); it
  does read each file's own «سجل التعديلات», which shows changes, not views.
- **The archive adds no column.** It is `isActive = false`, with the reason and
  the requester on the Tier 1 audit row; the archive dialog stays with the roles
  that edit the register screen today, which leaves out «جابي».

## 17. Questions the 2026-10-05 review left open

### 17.1 How a citizen with no phone of their own pays online

**What the code does:** «لا يملك رقم هاتف» is a complete record (0069). Such a
citizen opens their page with the reference number alone
(`POST citizen/reference/open`). The payments portal asks for the reference
*and* the phone on file (`loginByReference`), and the code sent to a phone looks
up the citizen's own number (`verifyOtp`), so neither works for them. «رقم
للتواصل» is never accepted in place of their phone: it is somebody else's
number, and accepting it would make a relative's phone a credential for this
file.

**Options:**

1. **Accept it.** They pay at the counter or to a collector, as they would
   without a phone today.
2. **Let the reference-only session pay.** It already reads the bills; paying
   is a smaller step than reading, but widens what a guessed reference can do
   ([docs/security.md](security.md#known-gaps)).
3. **A counter-issued one-time code** for the family, handed over in person.

### 17.2 Whether the head's account sees scanned identity documents

Decision 1 says the head "can view citizens and their data". The scans
(`GET documents/:id/url`) were withheld from «مشاهد فقط» in `PR #88` and still
are: the role sees which documents a file holds, not the documents. Whether
"their data" includes the scans is the owner's call. Opening them is one role
added to the documents routes, and every view is already audited
(`document.viewed`).

### 17.3 Whether «المحاسب» sees «بانتظار إعادة الكشف»

The accountant issues fees and reads how many units the hold kept off a notice,
but the re-inspection list is a census worklist (`CENSUS_WORKLIST_ROLES`) and
does not admit the role. The issue summary therefore names no page to go to.
Adding the role to the read is small; whether billing staff should read census
work is a question of who does what in the office.

### 17.4 Whether the head's account exports the building census

«تصدير CSV» on «سجل المباني» builds the file in the browser from the same read
as the table (`buildings/page.tsx` `exportCsv`), so every role that opens the
page has it, «مشاهد فقط» included. It carries no citizen: codes, parcels,
sectors, structure and damage, coordinates, and the officers' free-text notes.
The register's own export (citizens, `REGISTER_EXPORT_ROLES`) was taken from the
head's account in `PR #88`. Whether "does nothing else" also means no building
export, or only no register export, is the owner's call; hiding the button for
the role is one allow-list in `lib/staff-roles.ts`.

## 18. The treasury’s controls (decided 2026-10-09)

**Status:** decided on the PR #104 review, from the municipal accounting decree
(Decree 5595/1982, read in its consolidated text) and municipal cash-handling
practice. Each one is written up, with its grounds, in
[finance.md §13.1c](finance.md), and pinned by
`treasury-controls.integration.spec.ts`.

- **D1, a refund after a handover:** it comes out of the collector’s custody only
  while that still holds all of it; otherwise it comes out of the safe. A collector
  pays nothing out (art. 93).
- **D2, a payment dated before go-live:** only a finance role may record one once the
  treasury is live, and the audit row says no wallet was credited.
- **D3, the payment order:** an accountant’s expense waits for the manager’s order
  (art. 28, 33). Urgent payments are paid first and regularised after (art. 35). The
  manager records the order the head signs on paper; the head’s own account stays
  «مشاهد فقط» (decision 16).
- **D4, stage 5 before activation:** not required with D3 in place. Until it ships, the
  one-day statement is the daily register (art. 101), printed, counted and signed.
- **D5, the go-live day:** live, for payments and expenses alike. Whatever was taken
  before the opening count is entered before activation; a document dated that day is
  never placed before the opening entry.

**Still open:**

- **A ceiling on the urgent path (art. 35).** An accountant can pay any amount, from any
  wallet, under any band, by giving an urgent reason. The only check is the manager's
  queue of vouchers waiting for an order. **Undecided:** whether to add a per-voucher
  ceiling, a list of bands that may be paid first (salaries, petty and urgent ones, as
  the article names them), or neither.

- Whether each municipality wants the head’s signature reflected through the
  manager’s account, or a role of its own.
- Petty-cash advances (art. 37–42).
- How a backup should carry an append-only ledger ([database.md](database.md),
  **Undecided**).
