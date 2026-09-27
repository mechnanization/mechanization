# Codebase current state: SMS, OTP and notifications (mechanization-1, branch `feat/production-like-seed`, read 2026-09-26)

Sources are repository files, given as repo-relative paths with line numbers (links are relative to this notes folder). Git-history facts come from `git log --all -S/-G` run on 2026-09-26. No `.env` values, secrets or citizen data were read or recorded. Only variable names were checked.

## 1. Where is the SMS send function, what does it do today, which env variables does it need, and which provider names appear anywhere?

### Takeaway
Everything goes through one adapter, `SmsProviderService` (`apps/backend/src/infrastructure/sms/sms-provider.service.ts`). Its `deliver()` method always throws "SMS provider not yet wired". The two env keys (`SMS_PROVIDER_API_KEY`, `SMS_PROVIDER_FALLBACK_API_KEY`) are optional in every environment and do nothing today. No SMS vendor is named anywhere in the code, docs or git history.

### Cited Findings
- **The adapter.** `SmsProviderService implements SmsSender`. Its constructor reads `SMS_PROVIDER_API_KEY`, `SMS_PROVIDER_FALLBACK_API_KEY` and `NODE_ENV`. — [sms-provider.service.ts L18-28](../../apps/backend/src/infrastructure/sms/sms-provider.service.ts)
- **Boot-time logging.** In production with no primary key it logs at error level: "No SMS provider configured in production — every citizen OTP sign-in will fail. Staff login is unaffected." With no fallback key it logs a warning. — [sms-provider.service.ts L30-46](../../apps/backend/src/infrastructure/sms/sms-provider.service.ts)
- **`hasFallback`** is true only when a fallback key is set and differs from the primary key. — [sms-provider.service.ts L49-51](../../apps/backend/src/infrastructure/sms/sms-provider.service.ts)
- **`send({phone, message, channel})`:**
  - It picks the primary key, or for `FALLBACK` the fallback key (falling back to primary).
  - With no key in production, it throws `'No SMS provider configured'`.
  - With no key outside production, it `logger.debug`s the unmasked phone and the full message (including the code) and returns.
  - With a key, it calls `deliver()`.
  - [sms-provider.service.ts L53-67](../../apps/backend/src/infrastructure/sms/sms-provider.service.ts)
- **`deliver()` is the only vendor-specific part.** It logs a masked phone and then always throws: `'SMS provider not yet wired. Choose a provider (see docs/open-decisions.md), implement SmsProviderService.deliver(), and set SMS_PROVIDER_API_KEY.'` Per its comment, "Replace the body when the provider is chosen; nothing above this method needs to change." — [sms-provider.service.ts L69-85](../../apps/backend/src/infrastructure/sms/sms-provider.service.ts)
- **Masking** keeps the first 5 and last 2 characters of the phone. — [sms-provider.service.ts L87-90](../../apps/backend/src/infrastructure/sms/sms-provider.service.ts)
- **The interface** is `SmsSender { send({phone, message, channel: OtpChannel}): Promise<void>; readonly hasFallback: boolean }`, with `OtpChannel = 'PRIMARY' | 'FALLBACK'`. — [otp-repository.interface.ts L1, L35-40](../../apps/backend/src/domain/interfaces/otp-repository.interface.ts)
- **DI wiring.** The token `SMS_SENDER` is bound to `SmsProviderService`. — [base-repository.interface.ts L24](../../apps/backend/src/domain/interfaces/base-repository.interface.ts); [infrastructure.module.ts L40, L79, L102](../../apps/backend/src/infrastructure/infrastructure.module.ts)
- **The only caller is `OtpService.issue()`.** Grepping the backend for `SMS_SENDER` or `sms.send` finds no other consumer, so the SMS path is OTP-only today. — [otp.service.ts L33, L98-103](../../apps/backend/src/application/features/identity/otp.service.ts)
- **Env schema.** `SMS_PROVIDER_API_KEY: z.string().optional()` and `SMS_PROVIDER_FALLBACK_API_KEY: z.string().optional()`. — [env.schema.ts L199-201](../../apps/backend/src/presentation/config/env.schema.ts)
- **`OTP_ENABLED`** defaults to `'true'`. Any value other than false/0/no/off parses as enabled. — [env.schema.ts L203-217](../../apps/backend/src/presentation/config/env.schema.ts)
- **The only SMS/OTP rule for production** is that `OTP_ENABLED` must be true. — [env.schema.ts L437-451](../../apps/backend/src/presentation/config/env.schema.ts)
- **The two SMS keys "used to be demanded" in production and no longer are**, because `deliver()` always throws. The comment says: "Restore both checks in the same change that implements `deliver()`." It describes the result as a system that "fails closed": citizen login does not work in production until a provider exists, and staff login (password + TOTP) is unaffected. — [env.schema.ts L492-515](../../apps/backend/src/presentation/config/env.schema.ts)
- **The runbook's env table** lists `OTP_ENABLED` as "`true` — production refuses to boot without it" and both SMS keys as "Optional and currently inert — no provider is implemented". — [docs/deploy-vercel.md L42-44](../../docs/deploy-vercel.md)
- **AGENTS.md §8.7** records the old two-key rule as "A guard that enforced nothing". — [AGENTS.md §8.7](../../AGENTS.md)
- **Git history.** Commit `7f33bf4` (2026-09-05, "feat(env): stop requiring SMS provider keys to boot production") removed the boot requirement. It changed `.env.example`, `.env.production.example`, `sms-provider.service.ts`, `env.schema.ts`, `docs/deploy-vercel.md` and `docs/open-decisions.md`. — `git show 7f33bf4 --stat`
- **Commits containing the exact string `SMS_PROVIDER`** (5 total; a case-insensitive search finds 7):
  - `b94268b` 2026-07-25, scaffold
  - `e3ada03` 2026-08-29, run on Vercel
  - `77a9627` 2026-09-05
  - `7f33bf4` 2026-09-05
  - `c4efe07` 2026-09-07

  The `infrastructure/sms` folder was touched only by `b94268b` (created) and `7f33bf4`. — `git log --all -S "SMS_PROVIDER"`
- **Vendor names in git history: none.** Case-insensitive `git log --all -S` found **0 commits** for each of: twilio, infobip, vonage, nexmo, messagebird, sinch, plivo, unifonic, monty, bird.com, `aws-sdk/client-sns`, `client-pinpoint`, `pinpoint-sms-voice`, "End User Messaging" and cloud-api. — git pickaxe run 2026-09-26
- **The only messaging vendor product ever named** is "WhatsApp Business Cloud API", in a code comment. Commit `aa41808` (2026-08-07) added it to `payment-receipt.tsx`: attaching a file "needs the WhatsApp Business Cloud API (a Meta app, a registered number, a media upload, a server-side token)". Commit `d346729` (2026-08-29) removed it. — `git log --all -i -S "whatsapp business"`
- **Backend dependencies include no SMS SDK.** The backend has `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `nodemailer`, `otplib`, `bcrypt`, `ioredis`, `@nestjs/schedule`, `@nestjs/throttler` and `@nestjs/event-emitter`. There is no Twilio, SNS, Pinpoint or other SMS SDK. — [apps/backend/package.json L28-49](../../apps/backend/package.json)
- **Email vendors named (email only).** The SMTP sender comment names "SES, Postmark, Resend and a municipality's own mail server" as SMTP options. — [smtp-email.sender.ts L6-18](../../apps/backend/src/infrastructure/email/smtp-email.sender.ts)
- **The local `apps/backend/.env`** sets `SCHEDULER_ENABLED` and `OTP_ENABLED` and sets no `SMS_*` variable (names only were checked). It is the only `.env*` file present under `apps/backend`. — local file inspection, names only

### Inferences
- A provider integration touches `deliver()` and, per the comments, the restored production checks in `env.schema.ts`. Channel selection, failover, masking and the error surface already exist.
- Right now the code models each route as a single API key string. A provider that needs more than one credential (for example account SID + auth token, an AWS region + IAM credentials, or a sender ID / origination number) will need new env variables and schema entries.
- `SmsSender` carries an OTP-specific `channel: OtpChannel` and a 2-route model. Bulk notifications (section 3) will probably want either a separate method or interface, or reuse of `send()` with a new message type. Nothing in the interface supports delivery receipts, message IDs, sender ID selection or batching.
- The dev-mode debug line logs the full phone and the OTP code. That is harmless in dev, but worth keeping in mind so that no "debug" logging of that shape reaches production when `deliver()` is written (AGENTS.md: citizen data must never reach a log).

### Gaps
- The "v2 spec, Section 10" that the adapter comment cites for the two-route requirement is not in the repository. Only `docs/open-decisions.md` tracks it.
- Vercel and GitHub Environment secrets cannot be seen from the repo, so whether anyone has set `SMS_PROVIDER_*` values in a deployed environment is unknown. It would not matter today, because `deliver()` throws.

## 2. How does citizen login work today? Is there an OTP flow (generation, storage, hashing, expiry, attempt limits, resend limits, rate limiting per phone/IP)? Is there a رقم مرجعي login?

### Takeaway
A complete phone-OTP flow is built: 6 digits, bcrypt-hashed in Postgres, a 5-minute TTL, 5 guesses, a cap of 6 codes per phone per hour, and a route switch from the second attempt. It cannot deliver, so in production it fails closed.

Citizens actually get in through the رقم مرجعي (reference number). The landing page takes the reference number **alone** as the full credential, and the payments portal takes reference number + phone.

### Cited Findings
**Four citizen sign-in routes** (all `@Public()`, under the tenant prefix `api/v1/t/:tenantSlug/auth/...`):
1. **`POST citizen/otp/request`**
   - Throttled to 3 per 60 s ([auth.controller.ts L189-219](../../apps/backend/src/presentation/controllers/auth.controller.ts); [app.config.ts L57-58](../../apps/backend/src/presentation/config/app.config.ts)).
   - The response never reveals whether the phone is registered. It returns `sent: true`, `otpRequired`, `channel`, `expiresAt`, `resendAvailableAt`, plus `devCode` outside production.
2. **`POST citizen/otp/verify`**
   - Has no route-specific `@Throttle`, so it falls under the global default of 120 per 60 s ([auth.controller.ts L221-236](../../apps/backend/src/presentation/controllers/auth.controller.ts); [app.module.ts L62](../../apps/backend/src/app.module.ts)).
3. **`POST citizen/reference/login`**
   - Takes رقم مرجعي + phone, used by the payments portal. Throttled to 5 per 60 s.
   - The same message is returned for a wrong reference or a wrong phone ([auth.controller.ts L238-264](../../apps/backend/src/presentation/controllers/auth.controller.ts); [identity.service.ts L666-709](../../apps/backend/src/application/features/identity/identity.service.ts)).
4. **`POST citizen/reference/open`**
   - Takes رقم مرجعي **alone**. Throttled to 5 per 60 s: "the reference *is* the whole credential on that route" ([auth.controller.ts L266-295](../../apps/backend/src/presentation/controllers/auth.controller.ts); [app.config.ts L49-56](../../apps/backend/src/presentation/config/app.config.ts); [identity.service.ts L711-749](../../apps/backend/src/application/features/identity/identity.service.ts)).

**Reference-only login and why it exists**
- Format: `^[A-Z]{3}-\d{4}-[32-symbol alphabet]{6}$`, e.g. `BZR-2608-5HLQBM` (2³⁰ suffix space). — [fee.schema.ts L650-665](../../packages/shared-schemas/src/fee.schema.ts)
- The stated reason for accepting one factor: "the household phone is shared, off, or out of credit, and an SMS code that never arrives is a door that never opens". — [fee.schema.ts L626-649](../../packages/shared-schemas/src/fee.schema.ts)
- The citizen landing page is a single رقم مرجعي field. "The SMS route still exists at `/login` for anyone who would rather use it." — [(citizen)/page.tsx L21-33](../../apps/frontend/app/%5Btenant%5D/%5Blocale%5D/(citizen)/page.tsx)
- Reference numbers minted before a CSPRNG fix came from `Math.random()`. A `reissue-references` script replaces them all and writes a CSV that "is the only record of which citizen to notify". — [README.md L115-119](../../README.md)

**OTP policy constants.** `codeLength: 6`, `ttlSeconds: 300`, `maxAttempts: 5`, `resendCooldownSeconds: 30`, `maxPerHour: 6` (per phone, "counted in Postgres since there is no Redis"), `fallbackAfterAttempt: 2`. — [app.config.ts L33-44](../../apps/backend/src/presentation/config/app.config.ts)

**OTP mechanics**
- **Generation.** `crypto.randomInt(0, 10**6)`, zero-padded. — [otp.service.ts L84-87](../../apps/backend/src/application/features/identity/otp.service.ts)
- **Hashing.** bcrypt with cost 12 (`PasswordHasher`). — [otp.service.ts L88](../../apps/backend/src/application/features/identity/otp.service.ts); [bcrypt-password.hasher.ts L5-19](../../apps/backend/src/infrastructure/security/bcrypt-password.hasher.ts)
- **Storage.** A per-tenant table `otp_challenges` (`OtpChallenge`: id, phone, codeHash "bcrypt hash — a leaked table must not hand out live login codes", channel, attempts, expiresAt, consumedAt, createdAt; index `(phone, createdAt)`), created in tenant migration `0001_init`. — [tenant schema.prisma L249-266](../../apps/backend/src/infrastructure/prisma/tenant/schema.prisma)
- **One live code per phone.** Creating a challenge burns every earlier unconsumed challenge for that phone. — [otp.repository.ts L24-48](../../apps/backend/src/infrastructure/repositories/otp.repository.ts)
- **Per-phone hourly cap.** `countRecent(phone, now-1h) >= 6` returns `ConflictError` "تم إرسال عدد كبير من الرموز — يرجى المحاولة بعد ساعة". The comment reads "Protects the citizen from SMS-bombing and the municipality from the bill". The count covers rows by `createdAt`, consumed or not. — [otp.service.ts L77-82](../../apps/backend/src/application/features/identity/otp.service.ts); [otp.repository.ts L85-89](../../apps/backend/src/infrastructure/repositories/otp.repository.ts)
- **Route selection.** From `attempt >= 2`, and only if `hasFallback`, the channel is `FALLBACK`. `attempt` is sent by the client (1–6). — [otp.service.ts L91-94](../../apps/backend/src/application/features/identity/otp.service.ts); [auth.schema.ts L56-63](../../packages/shared-schemas/src/auth.schema.ts)
- **SMS body.** `رمز الدخول: ${code}\nصالح لمدة ${ttl/60} دقائق.` — [otp.service.ts L101](../../apps/backend/src/application/features/identity/otp.service.ts). Measured locally: 37 characters, containing non-GSM-7 (Arabic) characters, so UCS-2 encoding.
- **Delivery failure.**
  - The challenge row is kept.
  - In production the citizen gets `ConflictError` "تعذّر إرسال الرمز حالياً. يرجى إعادة المحاولة، أو مراجعة البلدية لتسجيل طلبك."
  - Outside production it continues and returns `devCode`.
  - [otp.service.ts L104-144](../../apps/backend/src/application/features/identity/otp.service.ts)
- **Resend cooldown.** Only returned to the client as `resendAvailableAt`. `issue()` contains no server-side cooldown check; the only server-side resend limit is the 6-per-hour cap. — [otp.service.ts L58-145](../../apps/backend/src/application/features/identity/otp.service.ts)
- **Verification.**
  - Looks up the newest unconsumed, unexpired challenge.
  - At 5 or more attempts the challenge is burned.
  - A wrong code increments `attempts` and burns the challenge at 5.
  - A correct code consumes it (single use).
  - [otp.service.ts L151-181](../../apps/backend/src/application/features/identity/otp.service.ts); [otp.repository.ts L50-83](../../apps/backend/src/infrastructure/repositories/otp.repository.ts)
- **Shared household phones.** When one phone matches several citizens, verification returns `CHOOSE_PROFILE`, and the chosen id must be among the phone's matches. — [identity.service.ts L751-806](../../apps/backend/src/application/features/identity/identity.service.ts)
- **`OTP_ENABLED=false`.** `issue` writes nothing and sends nothing, and `verify` accepts any code. — [otp.service.ts L38-48, L65-75, L154-156](../../apps/backend/src/application/features/identity/otp.service.ts)
  - The local dev template sets `OTP_ENABLED=false`. — [docs/database-environments.md L118-119](../../docs/database-environments.md)
- **Pruning of expired challenges.**
  - `OtpCleanupJob` runs `@Cron(EVERY_HOUR, UTC)` across all active tenants. — [otp-cleanup.job.ts L27-75](../../apps/backend/src/application/background-jobs/otp-cleanup.job.ts)
  - On Vercel the same job runs from cron `0 1 * * *` (daily) via `GET /api/v1/internal/cron/otp-cleanup`. — [apps/backend/vercel.json L15-17](../../apps/backend/vercel.json); [internal-cron.controller.ts L68-75](../../apps/backend/src/presentation/controllers/internal-cron.controller.ts)
- **Session length.** The citizen JWT lasts 7 days (`JWT_CITIZEN_TTL`), and citizens have no refresh path. — [env.schema.ts L197](../../apps/backend/src/presentation/config/env.schema.ts); [identity.service.ts L862-866](../../apps/backend/src/application/features/identity/identity.service.ts)
- **Per-IP rate limiting.**
  - `ThrottlerGuard` is global ([presentation.module.ts L58-77](../../apps/backend/src/presentation/presentation.module.ts)).
  - Its storage is in memory, "correct for a single instance" ([app.module.ts L56-62](../../apps/backend/src/app.module.ts); [docs/open-decisions.md L120-131](../../docs/open-decisions.md); [docs/deploy-vercel.md L195-199](../../docs/deploy-vercel.md)).
  - The code states: "behind nginx with no `trust proxy`, every request reaches the throttler from nginx's own address". — [metrics.controller.ts L29-33](../../apps/backend/src/presentation/controllers/metrics.controller.ts)
  - A grep of `presentation/bootstrap.ts`, `main.ts` and `serverless.ts` found no `trust proxy` setting.
- **Citizen login UI** ([(citizen)/login/page.tsx L1-40](../../apps/frontend/app/%5Btenant%5D/%5Blocale%5D/(citizen)/login/page.tsx); [api-client.ts L534-565](../../apps/frontend/lib/api-client.ts)):
  - It has phone → code → choose-profile stages.
  - It shows a resend path and states that the server switches route on retry.
  - It skips the code stage when the server reports `otpRequired: false`.
- **Staff login is separate.** It uses email + password + TOTP (`otplib`), is mandatory for SUPER_ADMIN, and never touches SMS. — [auth.schema.ts L15-35](../../packages/shared-schemas/src/auth.schema.ts); [env.schema.ts L509-510](../../apps/backend/src/presentation/config/env.schema.ts)

### Inferences
- **The OTP request limit is effectively global on Lightsail.** With no `trust proxy` behind nginx, the per-IP limits key on nginx's address. The 3-per-minute limit on `otp/request` would then be about 3 per minute **for all citizens combined** (per process), and the global 120 per minute covers all traffic. For "daily citizen OTPs" at peak (for example after a billing notice) this could reject legitimate requests before any SMS cost is incurred. This is inferred from the code comment; the nginx config and pm2 instance count are not in the repo.
- **The hourly prune weakens the per-phone cap.** The prune deletes rows whose `expiresAt` has passed (5 minutes after creation). `countRecent` counts rows created in the last hour. So after a prune, codes issued more than 5 minutes earlier stop counting. On a host running the hourly `@Cron`, one phone could receive more than 6 codes within a rolling hour that spans a prune. This is relevant to SMS-bombing cost exposure. Inferred from reading the code, not tested.
- **The resend cooldown is enforced only by the client**, so a scripted caller can resend immediately, up to the per-phone and per-IP caps.
- **Any provider needs no more than one segment per OTP.** The OTP text is 37 UCS-2 characters, so it fits in one Arabic segment (the UCS-2 single-segment limit is 70 characters, a general SMS fact not from this repo). Adding a sender or brand name or an app hash to the text could push it over.
- **Resend attempts need their own budget.** Because attempt 2 onward goes to the fallback route (when configured), resend traffic from the "daily citizen OTPs" lands on the second provider. The two-provider budget should account for that.

### Gaps
- It is unknown whether nginx on the Lightsail box sets `X-Forwarded-For` and whether Express is configured to trust it anywhere outside `apps/backend/src`. The only evidence is the code comment.
- There is no data on actual citizen login volume by route (reference-only, reference + phone, OTP). The repo has no metrics for this, and production logs were not consulted (out of scope).

## 3. Is there a notification feature for owners/tenants that would send ~4,000 messages a month, and what job/queue infrastructure exists for bulk sends?

### Takeaway
No outbound citizen notification feature exists. There is no SMS, email or push to citizens about fees, registration or billing. The only "notifications" are an in-app bell for staff about pending payments.

Job infrastructure is limited to in-process `@nestjs/schedule` crons, or Vercel Cron hitting internal endpoints, plus a synchronous in-process event bus. There is no durable queue (BullMQ, pg-boss or similar).

### Cited Findings
- **The "payment notifications" are for staff.** A grep of backend `src` for notify/notification/reminder/broadcast/web-push finds only the `isSeen` flag on `CitizenPayment`, surfaced as `markAsSeen` / `markAllPendingAsSeen`. — [fees.service.ts L1649-1678](../../apps/backend/src/application/features/fees/fees.service.ts); [fees.controller.ts L305-312](../../apps/backend/src/presentation/controllers/fees.controller.ts)
- **The frontend `NotificationsBell`** polls pending payments every 60 s for SUPER_ADMIN, AUDITOR and ACCOUNTANT. It is staff-only and in-app. — [notifications-bell.tsx ~L36-37](../../apps/frontend/components/admin/notifications-bell.tsx)
- **Billing entities.**
  - `FeeNotice` has `frequency` (ONCE, MONTHLY, HALF_YEARLY, ANNUALLY), `targetType` (ALL_CITIZENS, BUILDING_CATEGORY, INDIVIDUAL_CITIZEN), `dueDate`, and `instructions` "Shown to the citizen above the payment options".
  - `CitizenPayment` is one citizen's debt.
  - [tenant schema.prisma L1638-1752](../../apps/backend/src/infrastructure/prisma/tenant/schema.prisma)
- **Recurring billing.** `RecurringBillingJob` runs daily at 02:00 UTC across all tenants. It is idempotent per (citizen, notice, period). — [recurring-billing.job.ts L9-80](../../apps/backend/src/application/background-jobs/recurring-billing.job.ts)
  - On Vercel the same job runs via cron `0 2 * * *` → `/api/v1/internal/cron/recurring-billing`. — [apps/backend/vercel.json L15-17](../../apps/backend/vercel.json)
- **The `fee.issued` event.** It is emitted on manual issue and on each recurring run that creates invoices. The payload holds noticeId, title, amount, targetType, issuedCount and periodKey, with no per-citizen list. Its only listeners are the audit log and reporting. — [fees.service.ts L895-905, L1045-1058](../../apps/backend/src/application/features/fees/fees.service.ts); [audit.service.ts L316](../../apps/backend/src/application/features/audit/audit.service.ts); [reporting.service.ts L1763](../../apps/backend/src/application/features/reporting/reporting.service.ts)
- **The event bus is synchronous on purpose.** `EventEmitterModule.forRoot({ global: true })` is synchronous because listeners depend on the request's AsyncLocalStorage tenant scope. "Switching this to a queue would silently break that and start writing audit rows to whichever tenant happened to be current." — [app.module.ts L25-32](../../apps/backend/src/app.module.ts)
- **The scheduler is in-process.** `ScheduleModule.forRoot()` loads only when `isSchedulerEnabled()`. That function reads `SCHEDULER_ENABLED`; unset means "not on Vercel". — [app.module.ts L34-54](../../apps/backend/src/app.module.ts); [env.schema.ts L10-46](../../apps/backend/src/presentation/config/env.schema.ts)
- **Cross-tenant jobs walk the registry.** Each such job "must iterate the registry and open [a tenant scope] per municipality explicitly". — [otp-cleanup.job.ts L8-16](../../apps/backend/src/application/background-jobs/otp-cleanup.job.ts)
- **The code assumes a single long-lived backend process** for both the throttler and the cron schedule. — [docs/open-decisions.md L120-150](../../docs/open-decisions.md)
- **No queue libraries.** No BullMQ, Bull, pg-boss, agenda or node-cron dependency. `ioredis` is present, and `REDIS_URL` is optional and used for caches. — [apps/backend/package.json L28-49](../../apps/backend/package.json); [env.schema.ts L219-225](../../apps/backend/src/presentation/config/env.schema.ts)
- **Today's citizen-facing messaging is manual, one at a time, from a clerk's own WhatsApp.** Examples are the registration welcome message containing the رقم مرجعي and payment receipts (see section 5). — [apps/frontend/lib/whatsapp.ts L18-72](../../apps/frontend/lib/whatsapp.ts); [PRODUCT.md L17](../../PRODUCT.md)

### Inferences
- The ~4,000 monthly owner/tenant notifications would be a **new feature**. The natural trigger is `fee.issued`, or a step after `RecurringBillingJob`, fanned out to the affected `CitizenPayment` rows.
- **A durable outbox is the likely shape.** Because the event bus is synchronous and in-request, and no queue exists, sending thousands of SMS inside the event handler or billing loop would block that request or cron run. A durable, per-tenant outbox table drained by a cron (the same "iterate tenants" pattern `OtpCleanupJob` and `RecurringBillingJob` use) fits the existing architecture better than adding BullMQ. That would require a new, additive tenant migration.
- **Opt-out and per-recipient state are missing.** There is no delivery status, opt-out or consent field and no message log model in the tenant schema. A bulk-notification provider's delivery receipts (DLRs) would need somewhere to land.
- **The recipient set needs care.** Phones are shared by households and not unique (see section 4). Several citizens on one phone would receive duplicate notices unless the fan-out de-duplicates by phone.

### Gaps
- No product spec in the repo defines the owner/tenant notification content, cadence or recipient rules. The "~4,000/month" figure comes from the task brief, not from any repo document.

## 4. How are phone numbers stored and normalized (E.164, +961, Lebanese prefixes), and is there validation in packages/shared-schemas?

### Takeaway
Phones are stored as E.164 strings with a leading `+`. Local input defaults to Lebanon (`+961`), and Eastern Arabic digits are normalized.

The shared schema `internationalPhone` accepts foreign numbers (8–15 digits after `+` or `00`). The backend OTP path re-parses with a **Lebanese-mobile-only** value object, so OTP login works only for Lebanese mobiles (national numbers starting 3, 70–79 or 81).

### Cited Findings
- **`normalizeDigits`** converts Arabic-Indic and Extended Arabic-Indic digits to ASCII. — [primitives.ts L3-8](../../packages/shared-schemas/src/primitives.ts)
- **`lebanesePhone`** uses the regex `^(\+961|00961|0)?(3|7[0-9]|8[1])\d{6}$` and outputs `+961…`. Its doc comment lists "+961 3/70/71/76/78/79/81". — [primitives.ts L10-23](../../packages/shared-schemas/src/primitives.ts)
- **`internationalPhone`** ([primitives.ts L25-90](../../packages/shared-schemas/src/primitives.ts)):
  - Input starting with `+` or `00` is international, with 8–15 digits.
  - Input with no country code is Lebanese, strictly `^0?(3|7[0-9]|8[1])\d{6}$`.
  - Output is always `+<digits>`.
  - The stated reason is that owners abroad and returning families hold foreign numbers.
- **Where `internationalPhone` is used:**
  - citizen `phone`, `whatsapp` and `localContactPhone` — [citizen.schema.ts L177-179, L317-321](../../packages/shared-schemas/src/citizen.schema.ts)
  - `landlordPhone` — [property.schema.ts L81, L100, L450](../../packages/shared-schemas/src/property.schema.ts); [building.schema.ts L807](../../packages/shared-schemas/src/building.schema.ts)
  - OTP request and verify — [auth.schema.ts L56-80](../../packages/shared-schemas/src/auth.schema.ts)
- **The shared auth schema comment** says foreign numbers are accepted at login but "`SmsProviderService` still routes to Lebanese networks, and a code for a foreign number will fail to arrive until a provider that can reach one is chosen". — [auth.schema.ts L39-55](../../packages/shared-schemas/src/auth.schema.ts)
- **The backend `PhoneNumber` value object** ([phone-number.vo.ts L1-48](../../apps/backend/src/domain/value-objects/phone-number.vo.ts)):
  - It strips spaces, dashes and parentheses, removes a leading `+961`, `00961` or `0`, then requires `^(3|7[0-9]|8[1])\d{6}$`, otherwise it throws "رقم الهاتف غير صالح".
  - It stores `+961<national>`.
  - `masked` shows only the last 4 digits.
  - `OtpService.issue` and `verify` both call `PhoneNumber.parse` first. — [otp.service.ts L59, L152](../../apps/backend/src/application/features/identity/otp.service.ts)
- **Login-by-reference phone comparison.** It uses a lighter `normalisePhone`, which strips formatting and a `+961`/`00961`/`0` prefix. — [identity.service.ts L1043-1052](../../apps/backend/src/application/features/identity/identity.service.ts)
- **Database columns and indexes.**
  - `User.phone`, `User.whatsapp` and `User.localContactPhone` are nullable strings, indexed by `@@index([kind, phone])` and `@@index([kind, whatsapp])`.
  - Phone is deliberately **not unique**: "A household commonly shares one phone".
  - `PropertyEntry.landlordPhone` is indexed.
  - `SystemSettings.contactPhone` and `whatsappNumber` hold the municipality's own numbers.
  - [tenant schema.prisma L111-114, L237-244, L501, L633, L1537-1546](../../apps/backend/src/infrastructure/prisma/tenant/schema.prisma)
- **Frontend wa.me formatting.** Links drop the `+` and default to 961 when the number has 8 or fewer digits or starts with 0. — [apps/frontend/lib/whatsapp.ts L1-9](../../apps/frontend/lib/whatsapp.ts)

### Inferences
- **Stored format is provider-ready.** Stored numbers are already E.164 with `+`, which is the format SMS APIs expect, so no reformatting layer is needed for Lebanese numbers.
- **Foreign-number OTP fails earlier than documented.** Because `OtpService` re-parses with the Lebanese-only `PhoneNumber`, a citizen whose stored number is foreign gets a validation error at `otp/request`, not a delivery failure as the `auth.schema.ts` comment says. International OTP would need a code change (switch the value object to accept `internationalPhone` output) as well as an international-capable provider. Owner/tenant *notifications* to owners abroad would use stored `+<cc>` numbers directly, so an international-capable route matters for that use case.
- **The Lebanese prefix regex is broad.** It accepts all of 70–79, including prefixes that may not be allocated. Nothing in the repo maps prefixes to carriers (Alfa or touch), so carrier-specific routing would need its own table.

### Gaps
- There is no count of how many stored citizen phones are foreign versus Lebanese, or how many citizens have no phone. Answering needs a database query, which is out of scope for this read-only task.

## 5. Is there any email, WhatsApp, or push notification code?

### Takeaway
- **Email:** an SMTP sender via nodemailer exists, used only for staff password resets, and optional.
- **WhatsApp:** only `wa.me` click-to-chat links and an OS share sheet, sent manually from the clerk's own WhatsApp account. There is no WhatsApp Business API.
- **Push:** none.

### Cited Findings
- **Email sender.** `SmtpEmailSender` uses nodemailer, "SMTP, deliberately, rather than a vendor SDK", because "The municipality has no domain yet". When unconfigured it falls back to Supabase's reset mail. Its only message is a staff password reset. — [smtp-email.sender.ts L6-60](../../apps/backend/src/infrastructure/email/smtp-email.sender.ts)
- **Email env variables** are `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM`, all optional. `SMTP_HOST` and `MAIL_FROM` must be set together. — [env.schema.ts L141-146, L420-433](../../apps/backend/src/presentation/config/env.schema.ts)
- **WhatsApp welcome message.** `buildCitizenWelcomeMessage` builds a formal Arabic registration message that includes the رقم مرجعي, with an emoji and WhatsApp markdown. `buildWhatsappHref` builds a `https://wa.me/<digits>?text=…` link. — [apps/frontend/lib/whatsapp.ts L18-72](../../apps/frontend/lib/whatsapp.ts)
- **Receipt sharing.** The receipt uses a wa.me text link ([payment-receipt.tsx L29, L164](../../apps/frontend/components/admin/payment-receipt.tsx)). The PDF goes through the Web Share API, which is "the only way a `wa.me`-based flow can carry an actual attachment" ([receipt-pdf.ts L81-100](../../apps/frontend/lib/receipt-pdf.ts)).
- **The sender is whichever account is signed in.** The office WhatsApp number is stored, but "It cannot *make* a `wa.me` link send from this number — no link can; the sender is whichever account the browser is signed into." — [tenant schema.prisma L1540-1546](../../apps/backend/src/infrastructure/prisma/tenant/schema.prisma)
- **Other wa.me and tel: links** appear on the admin citizen pages. — [citizens/page.tsx L459, L479](../../apps/frontend/app/%5Btenant%5D/%5Blocale%5D/%5BadminPath%5D/(protected)/citizens/page.tsx); [citizens/[citizenId]/page.tsx L2972-2980](../../apps/frontend/app/%5Btenant%5D/%5Blocale%5D/%5BadminPath%5D/(protected)/citizens/%5BcitizenId%5D/page.tsx)
- **Product scope.** "Share receipts directly to citizen WhatsApp accounts via native OS share sheet or PDF download." — [PRODUCT.md L17](../../PRODUCT.md)
- **No push code.** A grep for web-push, `PushSubscription`, firebase, FCM and expo-notifications in backend, frontend and shared-schemas sources found nothing.

### Inferences
- **WhatsApp is established behaviour.** Clerks already use it by hand for the welcome message and receipts, and the schema stores a separate `whatsapp` number per citizen. A WhatsApp Business API channel (template messages) would be an addition consistent with how the municipality already communicates. The welcome message's emoji and `*bold*` formatting are WhatsApp-specific and would need rewriting for SMS.
- **The existing email sender is not a citizen channel.** It serves staff only. `User.email` sits in the "Staff-only" block of the model ([tenant schema.prisma L94-95](../../apps/backend/src/infrastructure/prisma/tenant/schema.prisma)), and `citizen.schema.ts` has no email field. So there are no citizen email addresses to fall back to, and SMS or WhatsApp are the only channels that can reach citizens.

### Gaps
- It is unknown how many citizens have a `whatsapp` value distinct from `phone`. That needs a database query.

## 6. Planning documents in docs/ mentioning SMS, OTP, WhatsApp, or notifications

### Takeaway
The only planning document on this subject is `docs/open-decisions.md` §2, "OTP delivery fallback". It is marked 🔴, as blocking real citizen data. Its status is "structurally implemented, no provider chosen", with "which two providers" still to decide. No document plans owner/tenant bulk notifications.

### Cited Findings
- **§2 "OTP delivery fallback"** ([docs/open-decisions.md L43-74](../../docs/open-decisions.md)):
  - It gives the reasoning: "SMS delivery to Lebanese networks fails or stalls often enough that a single provider makes citizen login a coin flip".
  - Already built: two routes, the switch on the second resend, a 30 s cooldown, and a counter fallback with the رقم مرجعي.
  - Not built: `deliver()`.
  - "Still to decide: which two providers, and whether a staff-assisted registration path is needed for citizens who cannot complete OTP at all."
- **§1 "Legal basis and retention policy"** is 🔴 and unanswered. The data held includes phone, national ID and refugee/displaced status. — [docs/open-decisions.md L13-39](../../docs/open-decisions.md)
- **§3 "Production hosting and data residency"** is 🔴, "unanswered". "The deciding factor is not price — it is whether this data may sit outside Lebanon". It still mentions the Supabase `ap-south-1` example URL. — [docs/open-decisions.md L78-95](../../docs/open-decisions.md)
- **§5 "Horizontal scaling → rate limiting and the job schedule"** covers the single-process assumptions. — [docs/open-decisions.md L120-150](../../docs/open-decisions.md)
- **docs/deploy-vercel.md:**
  - The env table marks the SMS keys "Optional and currently inert" (L42-44).
  - The OTP prune runs hourly on a long-lived host and becomes daily on Vercel Cron (L159, L170).
  - "Rate limiting is per instance … the staff-login and OTP limits are the ones that matter" (L195-199).
  - [docs/deploy-vercel.md](../../docs/deploy-vercel.md)
- **docs/database-environments.md** has the local template: `OTP_ENABLED=false  # false: citizen OTP accepts any code. true: the code comes back as devCode.` — [docs/database-environments.md L111-119](../../docs/database-environments.md)
- **docs/building-census-plan.md** has no SMS, OTP, WhatsApp or notification content. The one grep hit, «رسالة», is an unrelated enum-helper example at L173. — [docs/building-census-plan.md L173](../../docs/building-census-plan.md)

### Inferences
- **§3 is out of date.** Production and staging moved to Lightsail in September 2026 (section 7), but it still reads as unanswered and names Supabase `ap-south-1`.
- **Residency is a live question for providers.** The residency question ("whether this data may sit outside Lebanon") would plausibly extend to an SMS provider that processes citizen phone numbers and message content. That is a criterion for the provider choice, not something the repo decides.

### Gaps
- The "architecture spec" / "v2 spec" that `open-decisions.md` and code comments refer to (for example "Section 10") is not in the repository.

## 7. Where is the backend hosted, and in which AWS region? (relevant to AWS End User Messaging)

### Takeaway
The production and staging backend and databases run on an AWS Lightsail instance, deployed with pm2 over SSH. The instance's public IPs in the repo's test fixtures fall in AWS range `13.36.0.0/14`, which AWS publishes as **eu-west-3 (Paris)**. The pre-migration backup bucket is also in eu-west-3.

A Vercel serverless deployment path for the API also still exists in the repo: `vercel.json` crons and `docs/deploy-vercel.md`.

### Cited Findings
- **The Lightsail box.** "Staging and production live on the Lightsail box that also runs the backend (moved off Supabase in September 2026)". Access is by SSH tunnel, and port 5432 is closed to the internet. — [docs/database-environments.md L6-14](../../docs/database-environments.md)
- **Deploy workflow.** Backend deploys run over SSH (`appleboy/ssh-action`, host from secret `SSH_HOST`), with pm2 releases on ports 4000/4001 and an `ecosystem.config.js` on the box. — [.github/workflows/deploy-backend.yml L114-184](../../.github/workflows/deploy-backend.yml)
- **IP addresses.** Lightsail IPs appear in guard test fixtures: `13.39.160.240` (older) and `13.37.53.105`. — [scripts/db/targets.test.mjs L81, L170, L259](../../scripts/db/targets.test.mjs)
- **Both IPs are in eu-west-3.** AWS's published IP ranges (`createDate 2026-09-26-04-37-05`) place both in `13.36.0.0/14`, region `eu-west-3`, services AMAZON and EC2. — [AWS ip-ranges.json](https://ip-ranges.amazonaws.com/ip-ranges.json)
- **Backup bucket.** `PRE_MIGRATE_BUCKET: nestjs-db-backups-687326766003-eu-west-3-an`, `PRE_MIGRATE_REGION: eu-west-3`. — [.github/workflows/migrate-database.yml L64-69](../../.github/workflows/migrate-database.yml); [docs/database-environments.md L539-546](../../docs/database-environments.md)
- **S3 tests** use `AWS_REGION: 'eu-west-3'` as the fixture region. — [s3-storage.service.spec.ts L82, L221](../../apps/backend/src/infrastructure/aws/s3-storage.service.spec.ts); [env.schema.spec.ts L130](../../apps/backend/src/presentation/config/env.schema.spec.ts)
- **AWS configuration in the env schema.**
  - `AWS_REGION` is required in production.
  - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are optional and must be set as a pair. The code notes that "an EC2 instance role supplies them without either variable being set".
  - [env.schema.ts L99-118, L380-392, L459-472](../../apps/backend/src/presentation/config/env.schema.ts)
- **The Vercel path.** `apps/backend/vercel.json` defines crons for `otp-cleanup` and `recurring-billing`, and `docs/deploy-vercel.md` documents the API on Vercel. — [apps/backend/vercel.json L15-17](../../apps/backend/vercel.json); [docs/deploy-vercel.md L28-54](../../docs/deploy-vercel.md)

### Inferences
- **An AWS integration would slot in easily.** The backend already uses AWS SDK v3 (`@aws-sdk/client-s3`), requires `AWS_REGION` in production, and supports explicit access keys. An AWS End User Messaging SMS integration (`@aws-sdk/client-pinpoint-sms-voice-v2`) could reuse the same credential and region pattern, with the Lightsail host in eu-west-3.
- **Region availability is a separate check.** Whether End User Messaging SMS is available in eu-west-3, and whether sending to Lebanon (+961) from that region needs a registered sender ID, is for the provider researchers. Nothing in the repo answers it.

### Gaps
- The deployed `AWS_REGION` value and the S3 credential mechanism (access keys or a role) are not visible from the repo; they live in secrets on the box. So is the question of whether any IAM principal would be allowed SMS sending permissions.
- The pm2 instance count on the box is not in the repo. It determines whether the in-memory throttler and the in-process cron act as one instance or several.
- The repo cannot show which host serves production citizen traffic at the moment: Lightsail per the runbook, with a Vercel path still present. Vercel and GitHub settings were not consulted.
