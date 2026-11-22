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

## 2. OTP delivery fallback (not used: decided 2026-10-13)

**Status:** decided by the product owner on 2026-10-13 ([§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)): no SMS or WhatsApp
provider for now, and citizens sign in with their رقم مرجعي alone, with no code and no second
factor. What is built below stays in the code for the day a provider is chosen; the portal's
front door no longer links to it (`/login`, the phone-code sign-in, answers only by address).

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

**Reopened only if [§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13) is:** then which two providers, and whether a
staff-assisted registration path is needed for citizens who cannot complete OTP at all. The
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

**Per roof (decided 2026-10-17, D28).** Under a `PER_UNIT` notice a unit counts
in roofs: a flat on two levels (a «دوبلكس») counts the municipality's factor —
1.8 by default, where two separate flats stacked on each other count 2 — kept in
Settings › المالية as a table per level count; a level count with no factor is not
billed until one is set. A house counts one full roof per storey. `PER_AREA` and
`FLAT` are unaffected. See docs/building-census-plan.md §15.

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

**Status:** open; deferred with online payment ([§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13), 2026-10-13), and to be decided
before it resumes.

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

None of this can happen while online payment is paused ([§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13), 2026-10-13):
`startWhishCheckout` is refused before the provider is called, and `postCheckout` is still
unwritten (it throws in live mode). Decide before online payment resumes: after the first live
checkout it stops being cheap.

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

**While online payment is paused** ([§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13), 2026-10-13) no citizen pays online through a
checkout, with a phone or without. One remote way stays: the report of a transfer made in the
citizen's own Whish app («أبلغ عن الدفع»), which §21 keeps. `/payments` and `declare` admit any
citizen session, the reference-only one included, and «ملفّي» now links there, so option 2 is in
effect for that report. Whether a reference-only session may report a transfer stays open here.

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
practice; D6, D7, D9 and the receipt's paper size by the owner on 2026-10-10. Each one
is written up, with its grounds, in
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
- **D4, stage 5 before activation:** not required with D3 in place. Until it shipped, the
  one-day statement was the daily register (art. 101), printed, counted and signed. Stage 5
  was built on 2026-10-10 (PR #106): the day is counted and closed in the system, and
  «تقرير الصندوق اليومي» is the register ([finance.md §7](finance.md)).
- **D5, the go-live day:** live, for payments, expenses and income alike. Whatever was
  taken before the opening count is entered before activation; a document dated that
  day is never placed before the opening entry.
- **D6, a ceiling on the urgent path (decided 2026-10-10):** a per-voucher ceiling per
  currency (LBP, USD), set by the manager in الإعدادات. An accountant's urgent payment
  above it is refused (`EXPENSE_URGENT_OVER_CEILING`) and goes to the manager as a
  request. Unset means no ceiling, which is where every municipality starts. Art. 35
  covers salaries, routine petty spending and genuinely urgent spending; the ceiling
  keeps a large purchase on the order path. Salaries are not held to it.
- **D7, a salary paid by the accountant (decided 2026-10-10):** art. 35 names salaries,
  so the accountant's «صرف راتب / أجر» is paid at once on the urgent path, with the
  reason «راتب — يُدفع قبل الحوالة (المادة 35)» written by the server, and waits for
  the manager's regularisation. The manager's payout is the order itself.
- **D8, an accountant's own salary (2026-10-10):** refused (`SALARY_SELF_PAYOUT`); the
  manager records it, or it goes to him as a request.
- **D9, an inspector's commission (decided by the owner, 2026-10-10):** paid like a salary.
  Art. 35 names salaries and wages («الرواتب والأجور»), so the manager's «صرف عمولة» is the
  order, and the accountant's is paid at once on the urgent path with the reason «عمولة مسح
  ميداني — تُدفع قبل الحوالة (المادة 35)» written by the server, waits for the manager's
  regularisation, and is not held to the urgent ceiling. He cannot pay his own commission
  (`COMMISSION_SELF_PAYOUT`), and before go-live, when a payout is a figure with no voucher to
  regularise, it stays the manager's. This settles the question PR #109 raised on 2026-10-10
  ([finance.md §5.6](finance.md)).
- **The printed receipt (decided 2026-10-10):** A5, scaled in print to fit one sheet,
  rather than running over two or moving to another paper size. The frontend
  implements it ([ui-ux-standards.md](ui-ux-standards.md), the printing entry).

**Still open:**

- **How large a salary or a commission may an accountant pay before the order?** Both are
  exempt from the urgent ceiling (D7, D9), so the only bounds are the wallet and, for a
  commission, what the inspector is owed. The manager sees each one in the regularisation
  queue, after the cash has left. **Undecided:** a ceiling of their own, or none.
- **A commission paid on another day, once live.** «صرف عمولة» is dated today, and the expense
  form may not file under «تعويضات المسح والجباية» (a commission paid there left the inspector
  owed what he was paid). So a commission handed over yesterday has no road into the system
  today. **Undecided:** a back-dated payout with a reason, as the expense form has, or none.
- **Whether the accountant sees what an inspector is owed.** He may pay a commission (D9), but
  the inspector's profile, which carries the figure, also lists the citizens the inspector
  registered, and stays the manager's and the inspector's own. So the accountant pays through
  the API with no screen and no figure, and the refusal names none. **Undecided:** a narrow
  read of the owed figure for him (and the dialog on a screen he opens), or the manager keeps
  paying commissions himself.
- **Which settings the accountant may change.** The settings route admits him for every field
  except the urgent ceilings, including the official exchange rate ([security.md](security.md)
  gaps). **Undecided.**
- **A transfer's fee and the payment order (PR #111 review, 2026-10-10).** A bank or Whish fee
  is taken by the provider as the money moves, so it cannot wait for the order. Until decided,
  the code applies D3 as to any voucher: the manager's transfer is the order of its fee, and an
  accountant's fee is paid at once on the urgent path with the server's reason «رسوم تحويل —
  تُدفع مع المناقلة (المادة 35)» (`TRANSFER_FEE_URGENT_REASON`), waits for regularisation, and is
  **held to the urgent ceiling**: a fee above it refuses the whole transfer, which the manager
  then records. **Undecided:** whether a fee is exempt from the ceiling like a salary (D7), held
  to it as now, or needs no regularisation at all because the transfer is the act.
- **Who may clear the review of an exchange the manager booked himself (PR #111 review,
  2026-10-10).** The review is `TREASURY_REVIEW_ROLES` (the auditor and the manager), so the
  manager can approve the review of his own exchange — the self-check D8 and
  `CUSTODY_SELF_RECEIPT` refuse elsewhere. Refusing it would leave a municipality with no auditor
  account unable to clear any of the manager's flagged exchanges. **Undecided:** refuse a
  self-review (`TRANSFER_SELF_REVIEW`), or allow it and let the audit row show who reviewed whom.

- Whether each municipality wants the head’s signature reflected through the
  manager’s account, or a role of its own.
- Petty-cash advances (art. 37–42).
- How a backup should carry an append-only ledger ([database.md](database.md),
  **Undecided**).

---

## 19. Settling several bills at once: what the PR #112 review left open (2026-10-10)

What the code does now ([finance.md](finance.md) §3.7):

- «تسديد الفواتير المحددة» refuses a bill waiting for review of a Whish transfer
  (`BULK_SETTLE_BILL_PENDING_REVIEW`): the screens never offer one, and a citizen can send
  a bill for review between the tick and the press. The **single** counter settle does not
  refuse it on the server: its screens hide the button, but the API takes the money, and the
  Whish callback then finds the bill PAID and records nothing for the transfer that arrived
  (`FeesService.settleFromWhishCallback` returns `{ applied: false }` on a PAID bill).
  **Decided (the owner, 2026-10-12; [finance.md](finance.md) §13.1c, D11):** no. The single
  settle and a reversal are refused too (`PAYMENT_CLAIM_UNDER_REVIEW`) until a clerk confirms or
  rejects the claim, and a Whish success for a bill settled another way meanwhile is set aside,
  MISMATCHED, for a clerk rather than dropped.
  Online payment is paused ([§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)),
  so no Whish callback arrives; the refusal holds as well for a transfer the citizen declares in the
  portal («أبلغ عن الدفع»), which puts the bill under review the same way.
- A settlement row keeps the citizen who paid. A merge of two citizen files moves the bills
  to the file kept, but `payment_settlements` is append-only, so the consolidated receipt
  still names the file merged away, and a retry of that press after the merge is refused as
  another act. **Undecided:** is that the receipt as issued (keep it), or should a merge
  carry settlements over (which needs an exception to the append-only trigger)?

---

## 20. Municipal requests and certificates (decided 2026-10-12 and 2026-10-13)

The plan is [municipal-requests-plan.md](municipal-requests-plan.md) §2, which gives each
question's reason. D8 was the user's answer (2026-10-12). On 2026-10-13 the user approved in
advance the plan's recommended option for every other question, so each is recorded here as
decided; a later answer from the municipality overrides it and is recorded here the same way.

- **D8 — both channels from the first release.** Citizens submit online through the portal, and
  staff file at the counter for a citizen who is present. One request, one bill and one queue
  either way; the request records its channel and, at the counter, the clerk. While online
  payment is paused ([§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)), the fee of a request filed online is paid at the municipality.
- **D1 — fees: a per-municipality list, set by the manager, in Lebanese pounds.** Each request
  type is offered only once the manager has switched it on and set its fee
  (`request_type_settings`). No amount is written in the code. A fee of 0 is a free type: no bill,
  and the request goes straight to review. The fee is the one in force when the bill is raised, so a
  request still waiting for its fee, never billed, whose type is made free later goes to review on
  its next read (`REQUEST_FEE_WAIVED`). Pounds only for now: the portal draws every figure in
  ل.ل, and a dollar fee waits until it does not.
- **D2 — eligibility is judged by the clerk, not encoded.** The applicant declares in what
  capacity they ask (owner, tenant, heir, agent, free occupant) and attaches the papers; the clerk
  reviews them and rejects with a reason when they fall short. What the system enforces: a type
  tied to a property names one of the citizen's own cards, and an **online** request carries a
  copy of an identity paper before its fee can be paid (reference-only sign-in, kept by [§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13),
  means whoever holds the reference can act for that citizen; pickup is against the original card
  in any case).
- **D3 — what a paper certifies is written by the clerk.** Approving a request («جاهزة للاستلام»)
  requires the statement the paper will carry, printed under the letterhead with the request
  number, the citizen's name and identity number, the property and the date; no validity period is
  printed unless the clerk writes one. A **براءة ذمة** cannot be approved while anything is owed on
  the property by its own bills (`ParcelDuesService`); the check, its total and its time are kept
  on the request and the paper says «حتى تاريخ …».
- **D4 — a request names the citizen's card.** `PropertyEntry`, and optionally one unit line on it
  (`BuildingUnit`); the server checks the card is the citizen's. Required for براءة ذمة, إفادة
  إشغال, إفادة شغور, تسجيل عقد إيجار, ترميم and لافتة; optional for إفادة سكن and طلب عام.
- **D5 — no automatic refund.** A paid request can be rejected; the fee stays recorded and the
  request says it was paid, so the accountant can decide; any refund goes through the treasury's
  existing expense flow. No money moves on its own.
- **D6 — identity copies: staff readers only, kept with the request.** Attachments open (a signed
  URL, every view audited) to the request readers — the manager, the administrative officer, the
  accountant and the auditor — never to «مشاهد فقط» and never back to the portal, which lists their
  type and date only. They are kept as long as the request; deletion waits for §1.
- **D7 — the QR code holds the request number only.** No public verification page.
- **D9 — notifications are not built, and none are planned for now** (confirmed by the product
  owner on 2026-10-13, [§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13): no SMS or WhatsApp provider). The portal shows each request's
  status. Phase 5 waits until a provider is chosen.
- **D10 — cancelling, expiry, duplicates.** The citizen (online) or the clerk may cancel a request
  while no bill has been raised for it. The fee's bill is raised when the citizen goes to pay
  («تحصيل الرسم» at the counter; online «ادفع الآن» once online payment reopens, [§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)),
  not when the request is filed. Once a bill exists the request is paid or waits — unless the
  manager cancels that bill («إلغاء الفاتورة», only on a bill nothing was paid on, finance audit B3):
  the request waiting on it is then cancelled with it, in the same transaction, so the citizen can
  file it again (decided 2026-10-13; `0094` lets a request be cancelled once its bill is). Nothing
  expires on its own. One open request per citizen, type and card (a partial unique index); a
  cancelled, rejected or completed request frees its place.

---

## 21. Online payment, citizen sign-in and notifications (decided 2026-10-13)

**Status:** decided by the product owner on 2026-10-13.

1. **Online payment through Whish is paused** until Whish gives the municipality its API.
   Citizens pay at the municipality's cash office or to a collector.
   - **What the code does.** `FeesService.startWhishCheckout` and a citizen's own request bill
     (`POST requests/mine/:id/bill`) answer `ONLINE_PAYMENT_UNAVAILABLE` while the Whish gateway
     is not live, before anything is read or written. The portal shows no «ادفع عبر Whish» or
     «ادفع الآن» (`ONLINE_PAYMENT_OPEN` in `apps/frontend/lib/online-payment.ts`); it says
     online payment is paused, and «طريقة الدفع» opens where and how to pay: cash at the office
     (an instruction only — «حسناً» closes it, nothing is declared), and the Whish report below. A
     request's fee is raised and paid at the counter («تحصيل الرسم»).
   - **Why the server refuses too.** Without credentials the gateway runs a sandbox. Pressing
     «ادفع عبر Whish» moved the bill to «قيد المراجعة» under a `WSH-` reference of our own, with
     no money taken, and a bill in review cannot be settled at the counter until a clerk rejects
     the claim.
   - **Kept.** The citizen's report of a transfer made in their own Whish app to the
     municipality's number («أبلغ عن الدفع», `POST fees/payments/mine/:id/declare`) stays: it
     needs no Whish API, and a clerk confirms it against the statement. Any citizen session can
     send it, the reference-only one included (§17.1). A municipality that does not want it leaves
     its Whish Money number empty in الإعدادات. It is the only claim a citizen makes: the route takes
     `WHISH_MONEY` with its reference and nothing else, and `FeesService.declare` refuses any other
     method before any read (`PAYMENT_DECLARATION_WHISH_ONLY`, 2026-10-15). Cash was declarable through
     the API after the portal stopped offering it, and a cash claim held the bill «قيد المراجعة».
   - **Before it ships.** Bills already moved to «قيد المراجعة» by the sandbox carry a
     `whishTransactionRef` beginning `WSH-`, which no Whish statement shows. A clerk rejects each
     in the review queue, so the citizen can pay at the counter. They were not counted: that needs
     a query on staging and production. The same goes for a bill a citizen declared paid in cash:
     `paymentMethod` CASH with PENDING_REVIEW. A clerk rejects each, and the citizen pays at the
     counter; not counted either.
   - **To reopen:** write `WhishGatewayService.postCheckout` against Whish's contract, set
     `WHISH_PROVIDER_WIRED` and add the `WHISH_*` pair rule to the backend's env schema in the same
     change, set them, decide §15, then set `ONLINE_PAYMENT_OPEN`. `WHISH_*` are declared since S18
     (2026-11-16), so a value in a deployed `.env` reaches the gateway, and `isLive` needs
     `WHISH_PROVIDER_WIRED` as well as both credentials, so a value set before `postCheckout` is
     written no longer lifts the server's refusal into 500s.
2. **Citizen sign-in stays the رقم مرجعي alone** (`POST citizen/reference/open`): no code by SMS
   and no second factor, because elderly citizens must be able to sign in without help. The risk
   is accepted: whoever holds a citizen's reference signs in as that citizen, reads their file and
   acts on their requests ([security.md](security.md#known-gaps)). The rules treat the reference as
   the credential it is: it is never logged or sent to Sentry (non-negotiable 7), and a request's
   paper never prints it. One known exception stays open: the single-bill receipt's WhatsApp text
   carries the full reference (a Medium row of security.md's Known gaps), which this decision makes
   weigh more. Staff sign-in is not part of this decision.
3. **No SMS or WhatsApp provider for now.** Nothing is sent to a citizen; the portal shows where
   each request stands ([§20](#20-municipal-requests-and-certificates-decided-2026-10-12-and-2026-10-13)
   D9). `SmsProviderService.deliver` stays unwritten, and §2 waits for a provider.

---

## 22. What the PR #120 review left open (2026-10-13)

The finance audit remediation closed what the code could close. These three are the owner's.

### 22.1 A collector's Whish entry is not checked against Whish

What the code does now ([finance.md](finance.md) D13): a collector records cash as his own collection
(method COLLECTOR, himself named), or a Whish transfer the citizen made at the door (`WHISH_MONEY`),
credited to the Whish wallet. B2 refuses a reference already on a receipt still standing, so one
transfer cannot settle two bills. Nothing checks that a reference typed at the door exists at Whish.

The risk: a collector keeps the cash, records the bill as `WHISH_MONEY` with an invented reference, and
the bill reads PAID while his custody owes nothing and the Whish wallet is overstated
([security.md](security.md#known-gaps)).

**Undecided:** send a collector's Whish entry to finance confirmation (PENDING_REVIEW, as a citizen's
claim is), reconcile counter-entered Whish references against the provider's statement, or accept the
risk as D13 stands.

### 22.2 A salary paid through the full expense form escapes one-salary-a-month

What the code does now ([finance.md](finance.md) §5.8, D10): «صرف راتب» records the month
(`salaryPeriod`, 0091), refuses a second salary for one person and month, and only offers this month
or the eleven before it, which the server enforces too (`SALARY_PERIOD_TOO_OLD`). The full expense form
can still pay a salary as an ordinary voucher under «رواتب وأجور» (`SALARIES`): it carries no
`payeeStaffId` and no `salaryPeriod`, so D10 does not apply; an accountant's is held only to the
urgent ceiling, each one, and nothing bounds how many.

**Undecided:** refuse the SALARIES category outside «صرف راتب» (an older salary would then need its own
path), require a payee and a month on that category in the form too, or keep the form as the
documented way to pay an old or irregular salary.

### 22.3 A collector cannot record foreign notes into his custody

What the code does now (decision of 2026-10-13): no screen sends a collector to «تسجيل دفعة نقدية»,
which takes the notes handed over in two currencies (`tendered`) but only as `CASH`, the method a
collector may not use (`COLLECTOR_CANNOT_SELECT_METHOD`). He records on the settle page, as his own
collection, an amount in the bill's currency. A collector given $20 for a ليرة bill therefore records
its value in ليرة, and his custody wallet in ليرة is credited while he holds dollars, so the handover
count differs in both currencies until he exchanges them.

**Undecided:** allow `tendered` with method COLLECTOR, crediting each currency to that collector's
custody wallet, or keep collectors on the bill's currency.

## 23. Old debts: what the municipality must answer (2026-11-21)

Plan and the fourteen decisions already taken: [old-debts-plan.md](old-debts-plan.md).
Nothing is built yet; these change what the code does once it is.

### 23.1 The fee types on the template

What the plan does now: a provisional list from Law 60/1988 (القيمة التأجيرية, صيانة المجاري
والأرصفة, إنشاء الأرصفة والمجاري, النظافة) and `OTHER` with a description
([old-debts-plan.md](old-debts-plan.md) §5.2). The column is text, so the final list needs no
migration.

**Undecided:** the list the municipality's books actually use. Ask its accountant, with a photo of
one page of the old books.

### 23.2 When prescription («مرور الزمن») starts, and what interrupts it

Decided (Hashem, 2026-11-20): a debt older than 5 years is dropped (decision 14). What the plan does
now: the 5 years count from 31 December of the debt's year, so a line of year *Y* is dropped from
1 January of *Y* + 6, and the dry run marks it DROP with the reason «مرور الزمن»; no bill is raised.

**Undecided:** whether the 5 years count from each debt's due date instead, and whether a notice or a
demand to pay interrupts them. The 5 years themselves could not be verified in Lebanese law online:
the municipality's legal adviser confirms them.

### 23.3 Maker ≠ checker on a batch

Proposed, not confirmed. What the code does now (task 5, 2026-11-21): whoever prepared a batch may approve
it. `ARREARS_APPROVER_IS_PREPARER` exists and `APP_CONFIG.arrears.approverMustDifferFromPreparer` turns it on,
in one place, off today. **Undecided:** whether SUPER_ADMIN may approve a batch they prepared. If not, with one
SUPER_ADMIN, an accountant prepares every batch.

### 23.4 The old books' total per year

Proposed, not confirmed. What the plan does now: `arrears_control_totals` ships empty with the
migration; nothing writes or reads it. **Undecided:** whether SUPER_ADMIN enters each year's arrears
total from the last «قطع الحساب», so the report shows how much is still to import against it.

### 23.5 Writing off many bills at once

**Later step.** «شطب» ([finance.md](finance.md) §3.8, task 9) is one bill at a time, on the bill's own
page. A bulk write-off — «all penalties before 2020, by decision X» — is wanted eventually; it is not
built or designed.

### 23.6 A municipal request's fee may be written off (decided 2026-11-21)

Decided by the owner (Abed, 2026-11-21): «شطب» works on a municipal request's fee too. What the code does:
the request waiting on the bill goes on to «قيد المعالجة», as one whose fee was made free does
(`REQUEST_FEE_WAIVED`), and the audit row is `REQUEST_FEE_WRITTEN_OFF`. Its `paidAt` is the moment the fee
stopped being owed, because a database CHECK wants a stamp on a billed request in review; if a screen must tell
"paid" from "forgiven", read the audit row, or give the request its own column in a later migration.

---

## 24. Request form builder: what the owner must decide (2026-11-21)

The plan is [request-forms-plan.md](request-forms-plan.md) (Jira epic D3-139), whose §2 gives each question's
reason in the plan's own format. **Every question below is decided** by Abed on 2026-11-21 and signed off by Hashem on 2026-11-22, who changed F1 (no built-in types) and added F13 (F9's wording still waits on the municipality); each carried a recommendation to
bring to the decision meeting; the **Status** line of each says who decided and when, or that it is waiting on
the owner or the municipality, and what the code does until then. No code is written until F1–F12 are answered
(Story 1's acceptance criterion), because the migration they shape cannot be edited once applied
([CLAUDE.md](../CLAUDE.md), non-negotiable 2). F12 was found while writing the plan; the Jira story lists F1–F11.

What this builds: a form the manager defines (its questions, its fee), which a citizen fills in online and a clerk
fills in at the counter, producing the same request, bill and queue as today ([§20](#20-municipal-requests-and-certificates-decided-2026-10-12-and-2026-10-13)).
Decisions D1–D10 of §20 stand; F1–F11 only say how a form fits inside them. Read §1 (retention), §20 and §21 first:
F4, F8 and F10 touch them.

### F1 — The eight built-in request types

**Question.** `RequestType` has eight values (`CLEARANCE`, `RESIDENCY`, `OCCUPANCY`, `VACANCY`,
`LEASE_REGISTRATION`, `RENOVATION`, `SIGNAGE`, `OTHER`). Do they become forms too, or stay as they are beside the
custom forms?

**Options.** (a) They become *system forms*: one model, the manager's fee list moves onto the form, a backfill
migration links every existing request. (b) They stay: two models for ever, and every reader of `requestType`
(the reporting grouping, «دمج ملفين», the printed paper, the types screen) handles both.

**Recommendation.** (a), built last (Story 9) and only after custom forms work. A system form keeps its special
behaviour keyed on a fixed **system kind**, never on its name: the براءة ذمة dues check before approval
(`ParcelDuesService`, D3) and the list of types tied to a property (`REQUEST_TYPES_ON_PROPERTY`, D4).

**Why it matters.** (a) rewrites live rows in two municipalities and needs a rehearsed backfill; (b) is cheap now
and permanent. If the answer is (b), Story 9 is dropped and `formId` simply stays nullable on a request.

**Blocks.** Story 3 (does the table carry a system kind?) and Story 9.

**Status.** **Changed by Hashem, 2026-11-22: (c) there are no built-in types.** The manager creates every form. Abed had decided (a) on 2026-11-21; Hashem decided to remove the built-ins because no request has been filed on them. **Conditional on a count of zero requests in every production municipality** (`SELECT count(*) FROM citizen_requests`): if any exists, a used form can never be deleted (F7), so that municipality's built-in type is archived instead. Consequences: Story 9 is dropped (`0114` and the system-forms code are never merged); a later story removes the typed path (the types screen, typed submit and, in a release of its own, `request_type_settings`); the dues check moves to a form setting (F13). Decided by: Hashem (as stated in the session) · Date: 2026-11-22.

### F2 — Editing a form that already has requests

**Question.** What happens to a request already filed when the manager changes the form's questions?

**Options.** (a) A published form is **versioned**: a request is tied to the version it was filled against, so an
old request still shows the questions its answers belong to. (b) Edit in place, answers keyed by field: an old
request loses or misreads answers when a field is removed or retyped. (c) A form with any request is frozen, and a
change is a new form.

**Recommendation.** (a). The fee is not versioned: it stays «the one in force when the bill is raised» (§20 D1).

**Why it matters.** It decides whether a form has a versions table at all, and whether an answer can ever be
orphaned.

**Blocks.** Stories 3, 5 and 6.

**Status.** **Decided: (a), a published form is versioned.** Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22.

### F3 — Field types and their validation

**Question.** Which kinds of question may a form ask, and how much may the manager configure?

**Options.** (a) A fixed catalogue, each type with fixed, safe options. (b) Also a free-form pattern (a regular
expression) the manager types.

**Recommendation.** (a): short text, long text, whole number, decimal number, date, phone, civil ID or document
number, single choice, multiple choice, yes/no, file (image or PDF). Per type: minimum and maximum length or value,
the choices, the accepted file kinds, the maximum files. **Every field is required** (F4), so there is no «required» setting. **No free-form pattern**: a pattern typed by a
non-engineer is a way to reject a real citizen or to hang the server. Files keep today's limits, which are
shared by the request: the kinds the server sniffs (`REQUEST_ATTACHMENT_MIME_TYPES`: JPEG, PNG, WebP, PDF), 5 MB
a file (`REQUEST_ATTACHMENT_MAX_BYTES`) and at most 10 for the whole request (`REQUEST_ATTACHMENTS_MAX`). A form
with several file fields shares that 10; the builder refuses to promise more.

**Why it matters.** The catalogue is the validator both apps share (Story 4); adding a type later is a code change
in both and a migration for any stored enum.

**Blocks.** Stories 4 and 7.

**Status.** **Decided: (a), a fixed catalogue of field types with fixed options, no pattern typed by the admin; files keep today's limits.** Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22.

### F4 — Fields that already exist on the citizen's file

**Question.** A form asks for a name, a phone or an ID the register already holds. Typed again, or taken from the
file?

**Options.** (a) **Linked fields**: prefilled from the file and read-only, their value **copied onto the request** at
submission, so the paper and the audit show what was submitted even if the file changes later. (b) Always typed
again. (c) Read from the file live, never copied.

**Recommendation.** (a). The sources are the file's own columns: first name (`firstName`), father's name
(`middleName`), last name (`lastName`), mother's name (`motherName`), phone (`phone`), and an identity number
(`identityDocNumber`, with its type) or the civil record number (`civilRecordNumber`). **To confirm: which of
the last two «civil ID» means**, or both. The رقم مرجعي is **never** a linkable source: it is the citizen's
sign-in credential ([§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13), non-negotiable 7).

**The empty-value case.** Only `firstName` and `lastName` are always present. `motherName` is NULL on every file
filed before migration 0044 and on non-resident owners (NULL means «لم يُسأل», not blank); `phone` can be NULL when
the person has no phone (`hasNoPhone`); the identity and civil record numbers are nullable. So a *required* linked
field must say what happens when the file has no value. **Decided (Abed, 2026-11-21): the request is refused** until a
clerk has completed the file at the counter, through the file's own review. Nothing is typed on the request in its
place and nothing is written back to the file; the portal tells the citizen the municipality must complete their file.

**Why it matters.** A copy of an identity number on a request is a second copy of PII, under the retention that §1
leaves unanswered. It is also what saves a clerk re-typing a name wrongly.

**Blocks.** Stories 4, 6 and 8.

**Status.** **Decided: every field on every form is required, and a required linked field the citizen's file cannot fill blocks the request until a clerk completes the file.** The manager cannot mark a field optional, so a field has no «required» setting; a yes/no must be answered, a multiple choice needs at least one choice, a file field needs at least one paper. Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22. **«civil ID» means both:** a question may be linked to the identity number or to the civil record number (Hashem, 2026-11-22).

### F5 — Who builds and enables forms, and where they live

**Question.** Which roles build, publish, enable and archive forms, and is a form per municipality or shared?

**Recommendation.** The manager only, as for the types list today (`REQUEST_SETTINGS_ROLES` is `SUPER_ADMIN`):
a form sets a fee and what papers are demanded, which are the council's. Reading a form's requests stays
`REQUEST_READ_ROLES`. Forms live in each municipality's tenant schema, as `request_type_settings` does. A shared
template library across municipalities is out of scope for the first release.

**Why it matters.** A role set is part of the API and pinned per route (`route-inventory.spec.ts`); a template
library would need a schema outside the tenants.

**Blocks.** Story 5.

**Status.** **Decided: (a), the manager only, per municipality, no shared template library in the first release.** Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22.

### F6 — The property card and the applicant's capacity

**Question.** Does a form name one of the citizen's property cards (§20 D4)? Does it ask in what capacity the
applicant asks (owner, tenant, heir, agent, free occupant: `ApplicantCapacity`, D2)?

**Recommendation.** Two per-form settings. Property: *not asked*, *optional* or *required*. Capacity: asked or
not. Today the property rule is per type and fixed (`REQUEST_TYPES_ON_PROPERTY`: six of the eight types require a
card). A system form keeps its own rule.

**Why it matters.** A form with no property cannot run a dues check, and the one-open rule (F11) keys on the card.

**Blocks.** Stories 3 and 6.

**Status.** **Decided: a per-form property mode (not asked, optional or required) and a per-form switch for the applicant's capacity.** Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22.

### F7 — Disabling and deleting a form

**Question.** What does switching a form off do to requests already open, and can a form be deleted?

**Recommendation.** Disabled means hidden from new requests; open requests continue to their end (as a stopped type
does today). A form that has any request is **never deleted, only archived**; a form that never had one may be
deleted. This matches the request itself: `0094` allows no `DELETE` on a request.

**Why it matters.** It is the forms' own guard trigger: what it refuses, and the reason a request keeps a form it
can read.

**Blocks.** Stories 3 and 5.

**Status.** **Decided: disabled means hidden from new requests and open requests continue; a form with any request is archived, never deleted.** Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22.

### F8 — Who sees the answers, and for how long

**Question.** Who may read a request's answers, do the citizen's own answers come back to the portal, and how long
are they kept?

**Recommendation.** Staff: the same readers as the request's papers, `REQUEST_READ_ROLES` (the manager, the
administrative officer, the accountant, the auditor), never «مشاهد فقط» (D6). A file answer opens only through the
signed five-minute URL, each view audited, and never goes back to the portal as a file. **The portal shows the
citizen their own text answers** so they can check what they sent, but because sign-in is the رقم مرجعي alone
([§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13), an accepted risk: whoever holds the
reference reads the file), an **identity or civil record number is shown masked**, as the portal already masks the
reference, and never in full. Retention follows §1,
still unanswered: until then answers are kept as long as the request, like its papers (D6), and nothing is deleted.

**Why it matters.** The answers are citizen PII: never logged, never sent to Sentry, never exposed by
`scripts/db/setup-claude-ro.sql`, and deliberately in the backup's table order.

**Blocks.** Stories 6 and 8.

**Status.** **Decided: staff read answers as `REQUEST_READ_ROLES` (never «مشاهد فقط»); the portal shows the citizen their own text answers with identity and civil-record numbers masked to their last 3 characters; files never come back.** Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22.
**Retention (Hashem, 2026-11-22): answers are kept as long as the request**, like its papers (D6), and nothing is deleted. A fixed deletion period, if the municipality wants one, is a later decision under §1.

### F9 — The printed paper

**Question.** Does a form carry the statement the paper certifies?

**Recommendation.** An optional **template text** the clerk starts from, with placeholders for answers (plain
substitution of a field's key, no logic, nothing that can print a رقم مرجعي). The clerk still writes and approves
the final statement (D3), so the template is a draft, not the certificate.

**Why it matters.** The paper's wording is a legal statement and **the municipality's to confirm**
([municipal-requests-plan.md](municipal-requests-plan.md) §7): nothing here claims a legal form. Until it answers,
a form carries no template and the clerk writes every statement, as for «طلب عام» today.

**Blocks.** Story 8 (print) and whether Story 3 has the column.

**Status.** **Decided: (a), an optional statement template the clerk starts from; the clerk still writes and approves the final statement.** Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22.
**The wording is waiting on the municipality:** until it answers, a form carries no template and the clerk writes every statement.

### F10 — Languages

**Question.** The form's name, its field labels, help text and choices: Arabic only, or Arabic and English?

**Options.** (a) Arabic required, English optional, the screen falling back to Arabic. (b) Both required.
(c) Arabic only.

**Recommendation.** (a). **To confirm against non-negotiable 9** («both locales are complete»): the rule is about
the product's own copy, which stays in the message files, and a form's questions are the manager's data. On the
English portal a form with no English shows its Arabic text, never a blank or a key.

**Why it matters.** It decides the columns on a form and on a field (one label or two) and what a choice's stored
value is.

**Blocks.** Stories 3, 7 and 8.

**Status.** **Decided: (a), Arabic required, English optional, the English screen falling back to Arabic; form text counts as the manager's data, not the product's own copy (non-negotiable 9).** Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22.

### F11 — One open request per citizen and form

**Question.** Today a citizen has one open request per type and card (§20 D10: the partial unique index
`citizen_requests_one_open_key`, on the citizen, `requestType` and the card, a request on no card keying on the nil
uuid). Does the same rule hold per form?

**Recommendation.** Yes: one open request per citizen, form and card, with no setting to relax it in the first
release; revisit on a real case that needs two at once. A cancelled, rejected or completed request frees its place.

**Why it matters.** The existing index keys on `requestType`, so custom forms need their own key (the form) or two
different forms would block each other. That is a new index in the migration, not an edit of `0092`.

**Blocks.** Stories 3 and 6.

**Status.** **Decided: one open request per citizen, form and card, with no setting to relax it in the first release.** Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22.

### F12 — The identity copy on an online request (found while writing the plan)

**Question.** D2 ([§20](#20-municipal-requests-and-certificates-decided-2026-10-12-and-2026-10-13)) says an online
request carries a copy of an identity paper before its fee can be paid, and the server enforces it
(`REQUEST_IDENTITY_COPY_REQUIRED` when the fee's bill is raised, for an `ONLINE` request with no attachment of type
`IDENTITY`). Does that hold for every custom form?

**Options.** (a) Yes, for every form: the portal adds the standard identity step to each form and the server keeps
the check. (b) A per-form setting. (c) Not for custom forms.

**Recommendation.** (a). The reason D2 gave still holds: sign-in is the رقم مرجعي alone
([§21](#21-online-payment-citizen-sign-in-and-notifications-decided-2026-10-13)), so whoever holds the reference can
file as that citizen, and the paper is handed over against the original card. A form can ask for further papers with
file fields; it cannot waive this one. A form the manager publishes with a file field of type `IDENTITY` already
satisfies it, so the builder's only job is to say so.

**Why it matters.** Under (b) or (c) the server's check becomes conditional on the form, and a custom form could
bill an online request nobody has identified.

**Blocks.** Stories 6 and 8.

**Status.** **Decided: (a), every online request carries an identity copy before its fee can be paid, whatever the form.** Decided by: Abed · Date: 2026-11-21. Hashem's sign-off: approved · 2026-11-22. **Online only** (Hashem, 2026-11-22): at the counter the clerk checks the original card, so the counter takes no identity copy.

### F13 — The dues check on a clearance (added by Hashem, 2026-11-22)

**Question.** Today a براءة ذمة is refused while the property owes (`ParcelDuesService`, D3). With no built-in types (F1), where does that rule live?

**Decided.** It becomes a **setting of a form**: a form may ask for the dues check, which then needs a property (`propertyMode` required) and refuses approval while the property owes, exactly as the clearance does today. A story of its own, after the built-ins are removed; until then the check stays with the built-in clearance. Decided by: Hashem (as stated in the session) · Date: 2026-11-22.
