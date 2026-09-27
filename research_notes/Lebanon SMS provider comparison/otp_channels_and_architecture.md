# Non-SMS and Hybrid Channels for OTPs and Notifications to Lebanese Citizens (+961), and OTP Delivery Architecture (as of September 2026)

Research date: 2026-09-26. All prices USD unless stated. "Rest of Middle East" = Meta's WhatsApp pricing market that contains Lebanon.

Volume assumptions used in the inferences below (from the assignment, not from sources): ~4,000 Arabic notifications/month to owners and tenants; daily citizen login OTPs (exact volume unknown, so figures are given per 1,000 OTPs).

---

## Q1. WhatsApp Business Platform (Meta Cloud API): pricing model, Lebanon rates, authentication templates, verification, government eligibility

### Takeaway
Since 1 July 2025 Meta charges per delivered template message. Lebanon sits in "Rest of Middle East", where an authentication or utility template costs $0.0091 (Meta fee, before any BSP markup). That is roughly 40x cheaper than a single international SMS segment to Lebanon. Government entities are allowed, but only through a Solution Provider and after extra Meta pre-approval (typically 3-5 weeks). Two policy constraints matter here: explicit opt-in is required, and asking users to share ID-card numbers over WhatsApp is prohibited. A pricing change lands on **1 October 2026, five days after this research date**: utility templates sent inside the customer-service window stop being free, and service messages become billable.

### Cited Findings

**Pricing model and history**
- "Effective July 1, 2025, Meta charges on a per-message basis" and charges only when template messages are delivered. Categories are marketing, utility, authentication, authentication-international and service. — [Meta for Developers: Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- Meta may change pricing only on the first day of a quarter, so up to four times a year. Changes landed or were announced for 1 Oct 2025, 1 Jan 2026, 1 Apr 2026, 1 Jul 2026 and 1 Oct 2026. The current rate cards are marked "effective July 1, 2026". — [Meta for Developers: Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- The old conversation-based (24-hour conversation) pricing is now documented as deprecated. — [Meta: Conversation-based pricing (Deprecated)](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/conversation-based-pricing)
- Lebanon (+961) is in the **"Rest of Middle East"** market, which Meta's page lists alongside Bahrain, Iraq, Jordan, Kuwait, Oman and Yemen. — [Meta for Developers: Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- Volume tiers for utility and authentication are aggregated at business-portfolio level, specific to each market and category, and reset monthly. — [Meta for Developers: Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)

**Lebanon / Rest of Middle East rates (Meta fee)**
- Twilio's published WhatsApp pricing CSV has this row: `LB,Lebanon,Rest of Middle East,0.0341,100000,0.0091,100000,0.0091,300000`. That is marketing $0.0341, utility $0.0091 and authentication $0.0091, with list-rate volume thresholds of 100,000/month for utility and 300,000 for authentication. Jordan, Bahrain, Iraq, Kuwait, Oman, Qatar and Yemen carry identical rows. — [Twilio WhatsApp pricing CSV](https://www.twilio.com/content/dam/twilio-com/pricing-data/en/WhatsAppPricing-pricing-details.csv)
- SleekFlow's table "As of 1 October 2026" for Rest of Middle East gives marketing $0.0392, utility $0.0091, authentication $0.0091 and service $0.0091. — [SleekFlow: WhatsApp Business API pricing (2026/2027)](https://sleekflow.io/blog/whatsapp-business-price)
- Twilio adds its own fee of **$0.005 per WhatsApp message** on top of Meta's fee. — [Twilio WhatsApp pricing](https://www.twilio.com/en-us/whatsapp/pricing). This is the only Twilio figure I trust from that page fetch; the per-country Meta figures it returned looked like US defaults. The CSV above is the reliable source.
- **Staleness caveat.** The Twilio CSV still lists Qatar, Iraq, Kuwait and Oman under Rest of Middle East. FormBeep says Qatar moved to a standalone rate card on 1 July 2026 ([FormBeep](https://formbeep.com/whatsapp-api-pricing/)). Ominiflow says Iraq, Kuwait and Oman leave the "Rest of" buckets on 1 October 2026 ([Ominiflow](https://ominiflow.com/blog/whatsapp-api-pricing-update-october-2026)). So the CSV's region membership may lag. Lebanon's $0.0091 utility/authentication figure is still consistent across both the Twilio CSV and SleekFlow's October 2026 table.

**1 October 2026 changes**
- Ominiflow, 360dialog and others report four changes on 1 Oct 2026: (1) service messages become billable, (2) utility templates sent inside the customer-service window become chargeable again, (3) a new country rate card, and (4) authentication-international expands from 9 markets to 18. — [Ominiflow](https://ominiflow.com/blog/whatsapp-api-pricing-update-october-2026); [360dialog](https://360dialog.com/blog/whatsapp-service-message-charging-october-2026/)
- Meta's own page says Meta will charge per message for service messages, and for utility messages sent within an open 24-hour customer-service window. By market, service rates equal the utility and authentication rates, with no volume tiers. Messages inside the 72-hour **free entry point** window "remain free". — [Meta: Upcoming pricing updates for service and utility messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages)
- **Conflict:** Several secondary sources say each business phone number gets **1,000 free service messages per month** ([SendPulse](https://sendpulse.com/blog/whatsapp-service-message-pricing); [360dialog](https://360dialog.com/blog/whatsapp-service-message-charging-october-2026/)). My fetch of Meta's page did not surface that allowance. Treat the 1,000 figure as likely but unconfirmed at the primary source.
- Until 30 Sep 2026, "Utility templates delivered within an open customer service window are free". A 72-hour free entry point window opens when a user arrives through an ad or Page CTA and the business replies within 24 hours. — [Meta for Developers: Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)

**Authentication-international**
- Meta's page lists 9 authentication-international markets: Egypt, India, Indonesia, Malaysia, Nigeria, Pakistan, Saudi Arabia, South Africa and UAE. **Lebanon is not listed.** The rate applies only when the sending business is "based in another country" than the recipient's calling code. — [Meta: Authentication-international rates](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/authentication-international-rates/)
- The list expands to 18 markets on 1 Oct 2026, with 30 days' notice before a business is first charged. — [SleekFlow](https://sleekflow.io/blog/whatsapp-business-price); [Ominiflow](https://ominiflow.com/blog/whatsapp-api-pricing-update-october-2026)

**Authentication templates**
- There are three button types. **Copy code** puts the code on the clipboard and works for any client, including a web app. **One-tap autofill** and **zero-tap** need an Android app, its package name and a signature hash. — [Meta: Authentication templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates)
- The body text is fixed: "{{VERIFICATION_CODE}} is your verification code." Optional additions are a security disclaimer ("For your security, do not share this code") and an expiry warning configurable from 1 to 90 minutes. Effective 15 June 2026, iOS 26+ offers native OTP autofill from the notification. — [Meta: Authentication templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates)

**Government eligibility, verification and policy**
- "We permit the use of the WhatsApp Business Platform for government entities and require access through a Solution Provider." Law enforcement, military, national security and intelligence agencies are prohibited, as are political parties, politicians and campaigns. — [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/)
- "Don't share or ask people to share full length individual payment card numbers, financial account numbers, personal ID card numbers, or other sensitive identifiers." — [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/)
- Opt-in: you may contact people only if they gave you their number **and** "you have received opt-in permission from the recipient confirming that they wish to receive subsequent messages or calls from you." — [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/)
- 360dialog describes the process as follows. Government agencies need additional Meta approval. Allowed: government entities, nonprofits and community organizations. Prohibited: law enforcement, military, national security, political actors and emergency services. The steps are:
  1. Create the WABA through Embedded Signup.
  2. Declare government status.
  3. Submit jurisdiction, use-case description, what PII is collected, and whether the entity is an electoral authority.
  4. Complete Meta Business Verification. Only the "Classic" path is available, taking up to 14 days; partner-led verification is not.
  5. Receive Meta approval.
  6. Get display-name approval (about 48 hours).
  7. Optionally request an Official Business Account (blue badge).

  The whole process is typically 3-5 weeks and needs an SSL-secured public website. 360dialog's premium plan is EUR 99 / USD 119 per month per number, with messaging billed separately. — [360dialog: Government Agencies](https://docs.360dialog.com/docs/resources/government-agencies)
- Classic verification needs 2-3 documents proving the legal name, address and phone number, and the website must match. — [respond.io: Government agencies](https://respond.io/help/whatsapp/get-whatsapp-api-account-for-government-agencies); [respond.io: Meta Business Verification](https://respond.io/help/whatsapp/meta-business-verification)
- Messaging limits: a new business portfolio starts at 250 unique users per rolling 24h, outside customer-service windows. It can rise to 2,000 through business verification, partner verification, or 2,000 delivered messages in 30 days. After that it scales automatically to 10K, 100K or unlimited, given good quality and at least 50% utilisation. Limits are shared by every number in the portfolio. — [Meta: Messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits)
- Lebanese companies already run on the WhatsApp Business API. A Cequens article, surfaced only as a search snippet, says Bank Audi uses it. — [Cequens: WhatsApp Business in MEA](https://www.cequens.com/blog/everything-you-need-to-know-about-whatsapp-business-in-the-middle-east-and-north-africa) (secondary; not opened in full). Lebanese BSPs also advertise WhatsApp API service, for example [ProxiReach](https://www.proxireach.com/).

### Inferences
- **Notification cost.** At $0.0091 × 4,000 = **~$36/month** in Meta fees (about $56/month through Twilio at +$0.005). The same 4,000 as single-segment international SMS through Twilio at $0.3619 = ~$1,448/month. Arabic SMS uses UCS-2 encoding: 70 characters for one segment, about 67 per segment when concatenated (standard GSM behaviour, not separately sourced here). A 2-3 segment Arabic notice therefore costs ~$2,900-4,300/month over SMS. WhatsApp is 40-120x cheaper for notifications.
- **OTP cost.** Each WhatsApp authentication OTP costs $0.0091, so ~$9.10 per 1,000 in Meta fees, plus any BSP fee. WhatsApp bills only on delivery, so a failed WhatsApp attempt that then falls back to SMS costs nothing on the WhatsApp side.
- **After 1 Oct 2026, do not plan on free notifications.** Utility templates are charged even inside the service window. Budget every notification at the $0.0091 utility rate.
- **Authentication-international should not apply** as long as the WABA's business portfolio is the Lebanese municipality (or another Lebanon-based entity). If the portfolio belongs to a foreign vendor or parent company and Lebanon joins the expanded 18-market list, auth-international rates could apply. The portfolio should sit with the municipality.
- **A municipality looks eligible** as a "government entity". It is not law enforcement, military or political. It must go through a BSP, not a direct Cloud API signup, and should budget 3-5 weeks for pre-approval and Classic verification.
- **Policy fit for this system.** Do not build any WhatsApp flow that asks the citizen to type a national ID number into the chat; the policy forbids it. Keep notification bodies generic ("you have a new notice from the municipality, log in to view it"). Refugee or residency status and addresses should never be in a template, because Meta hosts the Cloud API and message text shows on lock screens. Collect explicit WhatsApp opt-in at registration and store proof of it.
- **The messaging limit could bite.** 4,000 notifications/month is fine on average, but sending all 4,000 in one day needs the portfolio at the 10K tier. Until it scales, the unverified 250/day and post-verification 2,000/day limits require throttled batch sends.

### Gaps
- I could not open Meta's official rate-card CSV/PDF directly (the links are rendered dynamically). The $0.0091 figure is corroborated by two independent secondary sources (Twilio's CSV and SleekFlow), not by Meta's file.
- I did not confirm whether Lebanon is among the new markets added to authentication-international on 1 Oct 2026.
- The 1,000 free service messages per number per month is not confirmed on Meta's page.
- I found no documented Lebanon-specific restriction on Meta Business Verification, and no confirmed case of a Lebanese municipality with an approved government WABA.
- I did not confirm that Arabic is a supported language for authentication templates. Meta generally supports Arabic templates, but the fetched page did not list languages.

---

## Q2. WhatsApp adoption in Lebanon

### Takeaway
WhatsApp is the dominant messaging app in Lebanon. The best hard figure is Pew's 84% of adults, from 2018. Current DataReportal reports do not break out WhatsApp for Lebanon. Adoption is lower among people aged 50+ (60% in 2018), and that group needs a non-WhatsApp fallback.

### Cited Findings
- "More than four-in-five Lebanese adults (84%) said they use WhatsApp, the highest rate among 11 emerging economies included in the survey." By age: 98% of 18-29, 94% of 30-49, 60% of 50+. The survey ran in fall 2018. WhatsApp was the most-used social or messaging platform, ahead of Facebook. — [Pew Research Center (2019)](https://www.pewresearch.org/short-reads/2019/11/19/protests-in-lebanon-highlight-ubiquity-of-whatsapp-dissatisfaction-with-government/)
- In a UNDP-associated survey, 78% of refugee households in Lebanon use WhatsApp (search-result summary). — [Jadaliyya: Qualitative WhatsApp Survey in Lebanon](https://www.jadaliyya.com/Details/40378) (not opened in full; treat as indicative)
- DataReportal Digital 2026 (October 2025 data): population 5.86M; 5.38M internet users (91.8%); 4.76M cellular connections (81.3% of population); 4.58M social-media identities (78.1%); Messenger ad reach 1.65M (28.2%); Facebook ad reach 3.45M (58.9%). **No WhatsApp or Telegram figure is reported.** — [DataReportal: Digital 2026 Lebanon](https://datareportal.com/reports/digital-2026-lebanon)
- DataReportal Digital 2025: 5.83M population; 91.6% internet penetration; 4.68M mobile connections. — [DataReportal: Digital 2025 Lebanon](https://datareportal.com/reports/digital-2025-lebanon)
- Sensor Tower Q1 2024: WhatsApp Messenger was the #1 communication app by downloads in Lebanon and WhatsApp Business #2. — [Sensor Tower Q1 2024](https://sensortower.com/blog/2024-q1-unified-top-5-communication%20apps-units-lb-6070aae1241bc16eb81f5bab)

### Inferences
- WhatsApp can serve as the primary channel for most citizens. Around one in ten or more, concentrated among older residents, will not be reachable on it, so SMS or voice fallback remains mandatory, not optional.

### Gaps
- There is no recent (2024-2026) primary survey of WhatsApp penetration in Lebanon. The 84% figure is eight years old, and the 2019-2024 crisis years may have changed usage.

---

## Q3. Telegram Gateway API

### Takeaway
Telegram Gateway costs $0.01 per delivered code and refunds automatically if the code is not delivered within the TTL. Lebanese reach is low: about 0.72M weekly active users in Q1 2024, roughly 12% of the population. It is only useful as a cheap opportunistic channel, checked with `checkSendAbility` before sending.

### Cited Findings
- "Authenticate users for just $0.01 per verification code", with "automatic refunds for undelivered codes". Users need an active Telegram account. Businesses may only message numbers that users "voluntarily shared" with consent. — [Telegram Gateway](https://core.telegram.org/gateway)
- API: `sendVerificationMessage` accepts `code_length` 4-8 (Telegram generates the code) or your own `code` of 4-8 digits, `ttl` of 30-3600 s, and a `callback_url` for delivery reports. "If a message is not delivered within the specified ttl, the request fee will be refunded automatically." `checkSendAbility` is charged, but its `request_id` covers one subsequent free send. Statuses: sent, delivered, read, expired, revoked, plus an `is_refunded` flag. — [Telegram Gateway API](https://core.telegram.org/gateway/api)
- Lebanon: Telegram was the #5 communication app by downloads in Q1 2024 (about 12-16K weekly downloads). Weekly active users fell from 740K to 717K over the quarter. — [Sensor Tower Q1 2024](https://sensortower.com/blog/2024-q1-unified-top-5-communication%20apps-units-lb-6070aae1241bc16eb81f5bab)

### Inferences
- About 717K WAU against a 5.86M population is roughly 12%, an order of magnitude below WhatsApp. Telegram could be an optional "send via Telegram" button for users who have it. It is not a fallback that closes WhatsApp's coverage gap: people without WhatsApp are unlikely to have Telegram.
- Telegram itself generates and verifies codes (`checkVerificationStatus`), so the OTP would not be under the municipality's own verifier. A system that wants one code store across channels should pass its own `code`.

### Gaps
- There is no DataReportal or survey figure for Telegram penetration in Lebanon; the only data point is Sensor Tower's app WAU. Telegram does not publish per-country delivery-success rates.

---

## Q4. Voice OTP (text-to-speech call) to Lebanon

### Takeaway
Voice OTP to Lebanese mobiles is supported by the major CPaaS vendors but costs about as much as SMS: Twilio charges $0.3718/min to Lebanese mobiles, and Twilio Verify adds $0.05. It is a last-resort channel for users with no WhatsApp whose SMS did not arrive. Twilio's Fraud Guard does not cover voice.

### Cited Findings
- Twilio outbound voice to Lebanon: mobile $0.3718/min, landline $0.1643/min. The billing increment was not stated on the page. — [Twilio Voice pricing: Lebanon](https://www.twilio.com/en-us/voice/pricing/lb)
- Twilio Verify voice: "$0.05 per successful verification", plus the underlying voice channel cost. — [Twilio Verify pricing](https://www.twilio.com/en-us/verify/pricing)
- Twilio Fraud Guard covers SMS only: "The Voice channel is not supported." — [Twilio: SMS Fraud Guard](https://www.twilio.com/docs/verify/preventing-toll-fraud/sms-fraud-guard)
- Vonage Verify v2 includes a `voice` channel in its workflows. — [Vonage Verify v2 API reference](https://developer.vonage.com/en/api/verify.v2)
- Infobip offers "Voice OTP": a configurable voice message read aloud when the user picks up. — [Infobip Voice OTP](https://www.infobip.com/voice/otp); [Infobip 2FA API](https://www.infobip.com/docs/2fa-service/using-2fa-api)
- Plivo Verify supports voice (example rates only; its Lebanon rate was not visible). — [Plivo Verify pricing](https://www.plivo.com/verify/pricing/)

### Inferences
- A voice OTP to a Lebanese mobile costs about $0.37-0.42 per call on Twilio (one minute plus the Verify fee). It is also a landline-capable channel for households without a smartphone.
- Voice is a known pumping vector (IRSF) and Twilio's Fraud Guard does not protect it. Voice should only be offered after an SMS attempt, only to pre-registered numbers, and with a tight per-number cap (for example one call per login challenge).

### Gaps
- Voice pricing to Lebanon from Vonage, Infobip, Sinch and Telesign is not public. Billing increments (per-second or per-minute) to Lebanon were not found.

---

## Q5. Firebase Phone Authentication / Google Identity Platform

### Takeaway
Firebase / Identity Platform delivers to Lebanon at **$0.28 per SMS** (first 10 SMS per day free). That is cheaper than Twilio's $0.3619 list SMS but still SMS-only, and there is no control over routes. Google strongly recommends an explicit SMS-region allowlist and requires reCAPTCHA. Search snippets from Firebase's own docs say new projects allow no SMS regions by default; I did not open those docs to confirm.

### Cited Findings
- Identity Platform phone-auth SMS pricing, read from the raw pricing page: **Lebanon (LB) $0.28**, Jordan $0.25, Iraq $0.23, Kuwait $0.24, UAE $0.09, Syria $0.09, US $0.01 per SMS. "The first ten SMS that you send per day are not billed." — [Google Cloud Identity Platform pricing](https://cloud.google.com/identity-platform/pricing)
- **Conflict:** a search-engine summary quoted Lebanon at $0.38/SMS, but the raw pricing page reads $0.28. The primary page is authoritative.
- The same page says: "If verification rates are very low in some regions, use SMS regions to create an allow or deny list". — [Google Cloud Identity Platform pricing](https://cloud.google.com/identity-platform/pricing)
- "SMS abuse typically happens when a malicious actor causes a service to send SMS through a carrier that they have a revenue sharing agreement with… we strongly recommend configuring an explicit SMS region policy that limits traffic to your specific operating regions." — [Identity Platform: SMS regions](https://docs.cloud.google.com/identity-platform/docs/admin/sms-regions)
- Firebase uses a reCAPTCHA verifier before sending phone-auth SMS. Search snippets say new projects allow no regions by default, and error 17006 ("region not enabled") is a common failure. — [Firebase: Phone auth (web)](https://firebase.google.com/docs/auth/web/phone-auth); [Firebase Auth FAQ](https://firebase.google.com/docs/auth/faq-and-troubleshooting); [Medium: Error 17006](https://medium.com/@fathyhafsa/firebase-sms-verification-failed-fix-error-17006-region-not-enabled-8c6fe8cf0763)
- Developer issue trackers show recurring "SMS code not sent" and reCAPTCHA / SMS-defense failures with Firebase Phone Auth. — [flutterfire #11565](https://github.com/firebase/flutterfire/issues/11565); [FlutterFlow #7264](https://github.com/FlutterFlow/flutterflow-issues/issues/7264)

### Inferences
- Firebase does not solve the "SMS is unreliable in Lebanon" problem. It is still SMS over routes Google chooses, and it adds a client-side Firebase SDK plus a Google-held phone-number store to a NestJS system that already owns its own auth.
- It is also a single-channel product with no WhatsApp fallback. In this architecture it only makes sense as a secondary SMS provider, and it is awkward for that role because Firebase owns the code lifecycle.

### Gaps
- There is no public data on Firebase SMS delivery success rates to Alfa or Touch subscribers. I did not confirm whether the SMS template text can be localised to Arabic, or whether a sender ID can be set.

---

## Q6. Aggregated multi-channel "Verify" services

### Takeaway
Every major verify product can reach +961. Only Twilio, Vonage and Prelude publish their verification-fee structure, and none publishes a Lebanon-specific all-in price on the pages I could read. Vonage Verify v2 has the most explicit built-in failover: a workflow of up to 3 channels with a configurable timeout. Twilio has a WhatsApp→SMS "Optimal Channel Selection" pilot that keeps the same code. The per-verification platform fee ($0.05-0.06) is 5-6x the WhatsApp message cost itself. For a WhatsApp-first design, integrating the WhatsApp Cloud API through a BSP directly is much cheaper than a Verify product.

### Cited Findings

**Twilio Verify**
- Pricing: "$0.05 per successful verification plus standard channel fees". WhatsApp adds the Meta authentication fee. Push and TOTP channel fees are bundled. Volume discounts are by contract. — [Twilio Verify pricing](https://www.twilio.com/en-us/verify/pricing)
- On most channels the $0.05 applies only to successful verifications, while channel fees apply to every send, including resends. — [EngageLab: Twilio Verify pricing](https://www.engagelab.com/blog/twilio-verify-pricing-what-100-000-verifications-really-cost)
- Twilio SMS to Lebanon: $0.3619 per segment. — [Twilio SMS pricing: Lebanon](https://www.twilio.com/en-us/sms/pricing/lb)
- WhatsApp channel: "Effective March 1, 2024, you must bring your own brand and phone number (Sender) to send WhatsApp OTP messages." Twilio auto-creates authentication templates with a copy-code button. A "Verify WhatsApp to SMS Optimal Channel Selection" pilot "will automatically send an SMS" if WhatsApp fails, and "the generated OTP code is the same". — [Twilio Verify WhatsApp](https://www.twilio.com/docs/verify/whatsapp)
- Limits: "Max (5) verification check attempts reached"; verifications expire after 10 minutes; max 5 send attempts. — [Twilio error 60202](https://www.twilio.com/docs/api/errors/60202); [Twilio error 60203](https://www.twilio.com/docs/api/errors/60203)
- Fraud Guard is on by default at no extra charge, for SMS only. It has Basic, Standard and Max levels (<1% and <2% false positives for Standard and Max) and works by blocking destination prefixes. — [Twilio: SMS Fraud Guard](https://www.twilio.com/docs/verify/preventing-toll-fraud/sms-fraud-guard)

**Vonage Verify v2**
- The workflow can use `sms`, `whatsapp`, `whatsapp_interactive`, `voice`, `email` and `silent_auth`, with a maximum of 3 sequential steps. `channel_timeout` defaults to 180 s (range 15-900 s; fixed minimum 60 s on the Verify Success pricing model). `code_length` is 4-10. A `fraud_check` flag is available. — [Vonage Verify v2 API reference](https://developer.vonage.com/en/api/verify.v2)
- Pricing: under the "Verify Conversion" model (the default), a fee of **€0.052 / $0.06084 per successful verification** applies, plus channel fees on every attempt. Under the "Verify Success" model, unsuccessful attempts are not charged, except Silent Auth rejections. — [Vonage support: charges for Verify v2](https://api.support.vonage.com/hc/en-us/articles/14842100202268-What-are-the-charges-for-using-Verify-API-V2) (returned 403 to fetch; figures are from the search-result snippet of this page)

**Prelude (formerly Ding)**
- Pay-as-you-go from **€0.032 per verification**, priced by country. Channels: SMS, WhatsApp, RCS, Telegram and Viber. Basic fraud protection on PAYG and "advanced antifraud" on higher plans. "Our revenue comes from the verification. Not from inflating your SMS bill." — [Prelude pricing](https://prelude.so/pricing)

**Plivo Verify**
- "$0 OTP Verification costs" and "$0 Fraud Shield cost". You pay channel fees only (SMS, voice, WhatsApp). The Lebanon rate was not visible in the fetched page. — [Plivo Verify pricing](https://www.plivo.com/verify/pricing/)

**Infobip, Sinch, Telesign**
- Infobip 2FA API: SMS, email and voice, with "smart routing" (for example, email or push first with SMS as backup) and an always-on failover channel. Infobip Authenticate also supports WhatsApp, RCS and Viber. — [Infobip 2FA API](https://www.infobip.com/docs/2fa-service/using-2fa-api); [Infobip Authenticate](https://www.infobip.com/authentication)
- Sinch Verification offers flash call and data verification in addition to SMS. Telesign offers SMS and voice verify. — [Mobile Text Alerts: Twilio competitors](https://mobile-text-alerts.com/articles/twilio-competitors-for-sms-2fa-api) (secondary)

### Inferences
- **Cost per 1,000 successful WhatsApp OTPs:**
  - Direct Meta through a BSP: about $9 plus the BSP fee.
  - Twilio Verify: $50 + $9.10 = ~$59.
  - Vonage: ~$61 plus channel fees.
- **Cost per 1,000 SMS OTPs to Lebanon:**
  - Firebase: $280.
  - Twilio Programmable SMS: ~$362.
  - Twilio Verify SMS: ~$412.
- The Verify fee buys managed code lifecycle, fraud tooling and multi-channel orchestration. For a system that already has a NestJS backend and wants the code stored hashed under its own control, a thin in-house orchestrator is simpler: WhatsApp Cloud API through a BSP, then an SMS provider, then a voice provider.
- Vonage's `workflow` (whatsapp → sms → voice, `channel_timeout` about 60-120 s) is the closest ready-made match if the team prefers to buy the failover rather than build it.

### Gaps
- There are no published Lebanon-specific rates for Prelude, Plivo, Infobip, Sinch, Telesign or Vonage channel fees; all need a sales quote or a logged-in console. I could not open Vonage's pricing pages (HTTP 403).

---

## Q7. Email OTP as a zero-cost fallback

### Takeaway
Email OTP costs next to nothing, but NIST SP 800-63B-4 says email "SHALL NOT" be used for out-of-band authentication, and OWASP notes it is only as strong as the mailbox. For a login that exposes national ID and refugee status, email should be a recovery or notification channel, not a primary login factor. I found no data on how many Lebanese citizens, especially older ones, actively use email.

### Cited Findings
- "Email SHALL NOT be used for out-of-band authentication" (NIST SP 800-63B-4, §3.1.3.1). — [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)
- Email verification "relies entirely on the security of the email account, which often lacks MFA". — [OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- Twilio Verify email channel: $0.05 per successful verification, with no separate channel fee listed. — [Twilio Verify pricing](https://www.twilio.com/en-us/verify/pricing)
- Lebanon internet penetration is 91.8% (Oct 2025) — [DataReportal 2026](https://datareportal.com/reports/digital-2026-lebanon). 12% of Lebanese say they never use the internet (Arab Barometer, c. 2019-2020) — [Arab Barometer](https://www.arabbarometer.org/2020/09/the-mena-digital-divide/).

### Inferences
- Email works as an opt-in secondary channel for notifications (for example, a copy of a notice) and for users who register an address. It should not stand in for a phone-possession factor at login. If used for OTP at all, restrict it to low-risk actions or pair it with another factor.

### Gaps
- There is no Lebanon-specific statistic on email-account ownership or active use by age.

---

## Q8. SMS pumping / toll fraud (AIT)

### Takeaway
SMS pumping happens when bots flood a public OTP endpoint with numbers in operator ranges that share termination revenue with the fraudster. Lebanon's high termination price ($0.28-0.36 per SMS) makes each fraudulent send expensive. The strongest single mitigation for this system is structural: **send OTPs only to numbers already stored on a registered citizen record**, never to a number typed in by an anonymous user. Add a +961-only allowlist, CAPTCHA, per-number and per-IP limits, a daily spend cap, and send-to-verify ratio alarms on top.

### Cited Findings
- Mechanism: fraudsters "take advantage of a phone number input field to receive a one-time passcode". Traffic is aimed at consecutive numbers of one operator, which either shares revenue knowingly or is duped. Sign of an attack: "a spike of messages sent to a block of adjacent numbers…controlled by the same MNO" with no completed verifications. Mitigations: Verify Fraud Guard, disabling every country you do not send to (geo permissions), sending only to mobile line types (Lookup), and Programmable Messaging SMS Pumping Protection. — [Twilio: What is SMS pumping fraud](https://www.twilio.com/docs/glossary/what-is-sms-pumping-fraud)
- Prelude cites global losses of **$1.2B (2025)**, an average major incident of $380,000, and Twitter's ~$60M/year. Controls: daily volume or spend caps (e.g. $300/day), pre-send classification, geo-restriction to active markets, send-to-verify ratio monitoring ("ratios above 2:1 signal fraud"), provider route intelligence, and real-time scoring. "The first sign is typically a billing anomaly, often days or weeks after the attack ran." — [Prelude: Preventing SMS pumping](https://prelude.so/blog/preventing-sms-pumping-fraud)
- Telnyx recommends:
  - a CAPTCHA (reCAPTCHA, hCaptcha or Turnstile) before the phone input;
  - per-phone limits of 3 per 10 min and 5 per hour, 10 per hour per IP, and 5 per hour per account;
  - destination allowlists and alerts on sequential numbers;
  - a uniform response ("If this number is registered, you'll receive a verification code");
  - never exposing the verification endpoint to unauthenticated users.

  — [Telnyx: Verify security best practices](https://developers.telnyx.com/docs/identity/verify/security-best-practices)
- Google recommends an explicit SMS region allowlist for the same reason. — [Identity Platform: SMS regions](https://docs.cloud.google.com/identity-platform/docs/admin/sms-regions)
- Twilio Fraud Guard is free and default, blocks by prefix, and does not cover voice. — [Twilio: SMS Fraud Guard](https://www.twilio.com/docs/verify/preventing-toll-fraud/sms-fraud-guard)

### Inferences
- **Pumping to +961 is an economic risk even with a Lebanon-only allowlist.** The allowlist stops international pumping (the common case), but a Lebanese route at about $0.36 per message is itself worth pumping if an attacker can choose Lebanese destination numbers.
- **Binding OTP sends to the phone number already on the citizen's record removes attacker-chosen destinations entirely.** The login flow asks for an identifier and sends to the number on file, returning the same response whether or not a record exists. What remains is harassment or cost from triggering sends to real citizens. Per-record and per-IP limits plus a daily spend cap bound that.
- WhatsApp authentication templates are billed only on delivery to a real WhatsApp account and do not route through premium-rate operator ranges. The pumping incentive is structurally much weaker on WhatsApp than on SMS or voice, which is another argument for WhatsApp first and SMS second.

### Gaps
- I found no source naming Lebanon specifically as a common AIT destination. A search snippet claimed pumping is "more prevalent" in Africa and the Middle East, but I could not pin that to a fetched primary page, so it is unverified.

---

## Q9. OTP best practices and failover architecture

### Takeaway
Standards converge on these parameters:
- **Code:** at least 6 random digits, single-use, overwritten on resend.
- **Validity:** 10 minutes at most; 5 minutes is common.
- **Attempts:** about 5 wrong entries per code.
- **Resends:** about 3 per 10 minutes per number, with a cooldown.
- **Rate limits:** per number, per IP and per account.
- **Alternatives:** SMS and voice are NIST "restricted" authenticators, so a non-PSTN alternative must exist.

For provider failover, treat "not delivered" (webhook failed, or no delivered status within N seconds) as the trigger to try the next channel. Do not fail over on "delivered but the user hasn't typed it yet". Make every send idempotent per login challenge.

### Cited Findings
- NIST SP 800-63B-4 §3.1.3.2: the verifier "SHALL generate random authentication secrets that are at least six decimal digits"; authentication is "invalid unless completed within 10 minutes"; rate limiting is required when the secret is under 64 bits. §3.2.2: no more than 100 consecutive failed attempts. §3.1.3.3: PSTN (SMS and voice) is "restricted", and "Verifiers SHALL ensure that alternative authenticator types are available to all subscribers". — [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)
- OWASP: SMS is "restricted" due to "SS7 interception, SIM-swap, and number-porting attacks". "Consider 8-digit or longer codes where usability allows." "Enforce a short time-to-live", make OTPs "single use", "apply strict attempt limits", "invalidate the OTP on successful verification", and on resend "generate a new OTP and overwrite the old record". — [OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- Twilio Verify defaults: 5 check attempts, 5 send attempts, 10-minute expiry (HTTP 429 when exceeded). — [Twilio error 60202](https://www.twilio.com/docs/api/errors/60202); [Twilio error 60203](https://www.twilio.com/docs/api/errors/60203)
- Telnyx: 6 digits; a 5-minute timeout "works well for most applications" and 120 s adds security; lock out after 5 wrong entries; the rate limits listed under Q8; "Never trust client-reported verification status". — [Telnyx: Verify security best practices](https://developers.telnyx.com/docs/identity/verify/security-best-practices)
- **Conflict on resend semantics.** OWASP says generate a new OTP on resend. Twilio's WhatsApp→SMS fallback deliberately keeps "the generated OTP code … the same" so either channel's code works. — [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html); [Twilio Verify WhatsApp](https://www.twilio.com/docs/verify/whatsapp)
- Vonage failover model: up to 3 workflow steps with `channel_timeout` 15-900 s (default 180). — [Vonage Verify v2 API reference](https://developer.vonage.com/en/api/verify.v2)
- WhatsApp charges only on delivered template messages, so a WhatsApp failure that falls back costs nothing on that leg. — [Meta for Developers: Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- Telegram refunds automatically if a code is not delivered within the TTL, and provides delivery-status callbacks. — [Telegram Gateway API](https://core.telegram.org/gateway/api)
- Prelude: cap daily spend and alert when the send-to-verify ratio exceeds 2:1. — [Prelude](https://prelude.so/blog/preventing-sms-pumping-fraud)

### Inferences (recommended architecture for this system)

1. **Login challenge object.** One row per login attempt holds:
   - `challengeId`, used as the idempotency key for every send;
   - the citizen record;
   - a hashed 6-digit code (8 if usability allows);
   - `expiresAt` = now + 5 min, with a hard maximum of 10;
   - `checkAttempts` (max 5);
   - `sendAttempts` (max about 3-5);
   - the list of channels tried, each with provider message ID and status.

   A client retry with the same `challengeId` never triggers a second paid send.
2. **Destination = number on file only.** Never send to a user-typed number at login. Return a uniform response ("if this record exists, a code has been sent") and show a masked number (+961 7x xxx x12).
3. **Channel order for OTP: WhatsApp → SMS → voice.**
   - **WhatsApp:** authentication template with copy-code, at $0.0091 per delivery.
   - **Automatic fallback to SMS** if the WhatsApp webhook reports `failed` (not a WhatsApp user, undeliverable), or no `delivered` status arrives within about 30-60 s.
   - **Voice** only on explicit user request ("call me instead"), because it is the most fraud-prone leg and Fraud Guard-style tools do not cover it.
   - **Telegram** can be an extra user-selectable option.
   - **Email** is not a login factor, per NIST.
4. **Same code across channels versus a new code.** Keeping one code per challenge (Twilio's approach) avoids "which code is valid?" confusion when WhatsApp arrives late after SMS. Issuing a new code (OWASP) is stricter. A defensible middle: one code per challenge, a user-requested resend creates a new challenge and invalidates the old one, and automatic channel fallback reuses the same code.
5. **Provider failover within SMS.** Primary: a local Lebanese aggregator or a route with direct Alfa/Touch connectivity (see the companion notes on local providers). Secondary: an international provider. Fail over on API errors, timeouts or failed/undelivered DLRs. Do not fail over merely because the DLR is late: Lebanese DLRs may be unreliable, and a double send doubles cost. A circuit breaker should mark a provider unhealthy after N consecutive failures.
6. **Cost and abuse controls.**
   - +961-only destination allowlist at every provider.
   - CAPTCHA or Turnstile before "send code".
   - Per-record limits (3 per 10 min, 5 per hour) and per-IP limits (10 per hour).
   - A global daily SMS and voice spend cap with an alert.
   - A send-to-verify ratio alarm (alert above about 2:1).
   - Masked phone numbers and no codes in logs, codes stored hashed.
7. **Reduce OTP volume structurally.** Daily OTPs can be cut sharply with a remembered-device or session lifetime policy. NIST requires a non-PSTN alternative, so passkeys or TOTP for staff, and optionally for citizens, cover that requirement and cut SMS spend.
8. **Notifications (about 4,000 per month).** Use WhatsApp utility templates with generic Arabic text and no sensitive data, about $36/month in Meta fees. Fall back to SMS only for numbers WhatsApp reports as undeliverable. Throttle sends to stay under the portfolio's messaging limit, and collect and store opt-in at registration.

### Gaps
- There is no published Meta SLA or typical delivery latency for authentication templates in Lebanon to calibrate the fallback timeout. The 30-60 s figure is an engineering judgement, not sourced.
- I found no published measurements of SMS DLR reliability specifically on Alfa or Touch.
