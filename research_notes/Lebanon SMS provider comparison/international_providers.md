# International CPaaS / SMS API providers: A2P delivery to Lebanese mobiles (+961, Alfa and touch), 2025–2026

Research date: 2026-09-26. Unless noted otherwise, prices were read on 2026-09-26 from each provider's own public pricing page or from the JSON/CSV feed behind it. Prices are USD per outbound SMS **segment**. Arabic (UCS-2) text allows 70 characters in a single segment and 67 per segment once concatenated, so a typical Arabic notification bills as 2 segments.

Two kinds of evidence are kept apart throughout:
- **"Listed"** means the provider publishes a Lebanon price or rule.
- **"Delivers"** means there is an independent or field report of delivery succeeding or failing.

---

## 1. Listed price per SMS segment to Lebanon, by provider

### Takeaway
All major international CPaaS providers publish a Lebanon rate, and the rates are close together: about **$0.28–$0.44 per segment**, with most between $0.30 and $0.38. Only Plivo prices Alfa and touch separately, and on its list touch costs more. Lebanon is one of the more expensive SMS destinations: the rate is about 35–45× Infobip's US rate. At 4,000 two-segment Arabic messages a month, the notification traffic alone would cost about **$2,200–$3,500 a month** through any tier-1 provider.

### Cited Findings

**Price table (read 2026-09-26 unless stated)**

| Provider | Lebanon price / segment (USD) | Alfa vs touch split? | Source |
|---|---|---|---|
| Bird (ex-MessageBird) | $0.28 (alphanumeric; long code, toll-free and short code "not published") | No | [Bird LB pricing](https://bird.com/sms-api/pricing/lb) (Markdown version at bird.com/sms-api/pricing/lb.md) |
| Infobip | ~$0.303 (EUR 0.2607), described as the "average price across all supported networks"; per-network price only inside the Portal | Not public | [Infobip SMS pricing](https://www.infobip.com/sms/pricing): embedded data `{"country":"LB","currency":"USD","price":30.3}`. Unit is US cents: the US entry on the same page is 0.818 and GB is 4.4 |
| Plivo | **Alfa $0.3154, MTC touch $0.3522**, "Others" $0.3354 | **Yes** | [Plivo LB SMS pricing](https://www.plivo.com/sms/pricing/lb/) |
| D7 Networks | $0.32 ("Local SMS" and "International SMS" both $0.32) | No | [D7 Lebanon page](https://d7networks.com/sms/lebanon/) |
| Sinch | $0.34055 (EUR 0.2655, GBP 0.2535); Alfa and touch rows both $0.34055; `priceDate` 2026-09-25 | Rows exist, same price | [Sinch SMS pricing](https://sinch.com/pricing/sms/): embedded `pricingData`, keys `/LB/522/` "Alfa" and `/LB/523/` "Touch" |
| AWS End User Messaging SMS | $0.34985 ("All Networks, All number types") | No | [AWS SMS price CSV](https://d1.awsstatic.com/onedam/marketing-channels/website/aws/en_US/business-applications/approved/documents/End-User-Messaging-SMS-Prices.ebc340b4d416d90832dd59629c4792b0deb6f8bc.csv), linked from [AWS End User Messaging pricing](https://aws.amazon.com/end-user-messaging/pricing/) |
| Twilio Programmable SMS | $0.3619 outbound (inbound also listed at $0.3619); plus a $0.001 fee per message that ends in "Failed" status | No | [Twilio LB SMS pricing](https://www.twilio.com/en-us/sms/pricing/lb) |
| Vonage (Nexmo) | $0.37944 outbound | No | Vonage pricing JSON [LB.messaging.USD.json](https://www.vonage.com/bin/vonage/communications-api/messaging/LB.messaging.USD.json), which feeds [vonage.com SMS pricing](https://www.vonage.com/communications-apis/sms/pricing/) |
| ClickSend | $0.4405 (lowest volume tier) → $0.4162 → $0.3965 → $0.3807 (highest tier); `reply_possible: 0`; minimum top-up $20 | No | ClickSend public pricing API [rest.clicksend.com/v3/pricing/LB?currency=USD](https://rest.clicksend.com/v3/pricing/LB?currency=USD) |
| Unimatrix (unimtx; not on the required list, but advertises Lebanon) | $0.1340 per message | Page says it has per-carrier tables | [Unimatrix LB](https://www.unimtx.com/sms/lb) |

- Twilio does not break its Lebanon rate down by carrier. It lists "International Numbers" and "Alphanumeric Sender IDs" as the sender types. — [Twilio LB SMS pricing](https://www.twilio.com/en-us/sms/pricing/lb)
- Infobip says the exact price "may vary based on the destination country, network and applicable discounts," and that large campaigns may be spread over several networks. — [Infobip SMS pricing](https://www.infobip.com/sms/pricing)
- A third-party comparison page from Sent (sent.dm) says Twilio was $0.3619, "verified January 2025". This matches Twilio's current price, so the Lebanon rate appears not to have moved since at least January 2025. The same page's other figures are unreliable: see the Sent entry under Gaps. — [Sent: Lebanon SMS pricing](https://www.sent.dm/en/resources/sms-pricing/lebanon-sms-pricing)
- Bird notes: "Prices are charged per message segment. A longer message is split into several segments and each one bills at the rate above." — [Bird LB pricing](https://bird.com/sms-api/pricing/lb)

### Inferences
- Monthly notification cost for 4,000 messages × 2 UCS-2 segments = 8,000 segments. This is simple arithmetic on the listed rates, before volume discounts:
  - Bird: $2,240
  - Infobip: ~$2,424
  - D7: $2,560
  - Plivo: ~$2,690, assuming D7's market-share figures (touch 55%, Alfa 42%)
  - Sinch: $2,724
  - AWS: $2,799
  - Twilio: $2,895
  - Vonage: $3,036
  - ClickSend: $3,046 at the top tier, $3,524 at the lowest
- Keeping each Arabic notification to **one segment (≤70 characters)** halves the bill. That design lever is worth more than the price differences between the tier-1 providers.
- The tier-1 providers cluster at $0.28–$0.38. Unimatrix is ~2.5× cheaper at $0.134. A gap that large usually means a different, often non-sanctioned ("grey") route, and that is risky given Alfa's anti-bypass gateway (Section 5). Treat it as unverified until tested on both networks.
- Plivo is the only provider that publishes a per-operator split, and there touch is ~12% dearer than Alfa. That suggests the two operators charge different international A2P termination rates.

### Gaps
- **No public Lebanon price found** for Telnyx, Textmagic, Routee, Msg91, Clickatell, Kaleyra, 8x8 or Unifonic:
  - Telnyx: its messaging pricing page shows only US rates for this destination and says "Rates may vary by destination and volume tier" ([Telnyx messaging pricing](https://telnyx.com/pricing/messaging)).
  - Textmagic, Routee, Msg91 and Clickatell: the pages load prices dynamically and no public data endpoint was found.
  - Kaleyra and 8x8: pricing is behind a login or sales contact.
  - Unifonic: its docs portal returned a login screen ([Unifonic docs](https://docs.unifonic.com/docs/understanding-sms-delivery-current-system)).
- The Sent page is unreliable on several points. It gives Plivo "approximately $0.23" and Infobip "approximately $0.23", which contradicts both providers' own pages ($0.3154–0.3522 and ~$0.303). It also gives Alfa "LBP 100–200 per message", which is a retail person-to-person price, not an A2P termination rate. Do not use its figures other than as a date anchor. — [Sent](https://www.sent.dm/en/resources/sms-pricing/lebanon-sms-pricing)

---

## 2. Country guidelines: sender ID, pre-registration, overwriting, content, two-way

### Takeaway
The providers **contradict each other** on the most important point, whether an alphanumeric sender ID must be pre-registered for Lebanon:
- **Not required:** Twilio (both its guidelines page and its help article, updated 2026-08-25), AWS's country table, Messente and D7.
- **Required, unregistered traffic rejected:** Telnyx.
- **Not guaranteed to survive:** Vonage and Plivo both say the sender may be overwritten; Plivo says it becomes a random number.

A field report from October 2025 (Section 3) supports Telnyx: traffic to **Alfa** with an unregistered sender ID failed on AWS. Everyone agrees that two-way SMS and short codes are not available.

### Cited Findings

**Twilio**
- Guidelines page for Lebanon:
  - Alphanumeric pre-registration is "Not Required", dynamic senders are "Supported", and "Sender ID preserved: Yes".
  - Domestic long codes are "Not Supported". International long codes are supported but "Numeric sender ID to Lebanon would be overwritten with generic alphanumeric sender ID", and numeric-sender delivery is "best effort basis only".
  - Two-way SMS: "No". Short codes: "Not Supported". Concatenated messages: "Yes".
  - "Twilio highly recommends sending messages with alphanumeric sender ID."
  - The page shows no last-updated date.
  — [Twilio Lebanon SMS guidelines](https://www.twilio.com/en-us/guidelines/lb/sms)
- Help article "International Support for Alphanumeric Sender ID" (updated 2026-08-25) lists Lebanon as "Yes". Neighbours such as Kuwait and Liberia are marked "Yes – Registration Required". The article warns that in registration-required countries "carriers … often impose carrier filtering on non-registered message traffic." — [Twilio help article 223133767](https://help.twilio.com/articles/223133767) (read via the Zendesk API)
- Since 13 August 2025, Twilio returns clearer error codes and statuses when an alphanumeric sender ID is not registered or authorised in a country. — [Twilio changelog](https://www.twilio.com/en-us/changelog/updates-to-alphanumeric-sender-id-compliance-checks-and-error-co) (from the search summary; the full page text was not extractable)

**Vonage** (support article updated 2025-07-17)
- "Sender IDs are case-sensitive and must contain the brand name. Alpha senders may also be overwritten to ensure delivery."
- "Numeric Sender IDs are not supported unless offered by Vonage's 2-way service. Numeric Sender IDs may be overwritten to ensure delivery."
- "Generic sender IDs such as INFO, SMS, NOTICE etc are prohibited."
- "P2P traffic is prohibited. No political, religious, unsolicited promotion, or gambling content."
- Marketing traffic needs opt-in.
- The article says nothing about pre-registration.
— [Vonage Lebanon SMS Features and Restrictions](https://api.support.vonage.com/hc/en-us/articles/204017663-Lebanon-SMS-Features-and-Restrictions) (read via the Zendesk JSON API; the HTML page is behind a Cloudflare challenge)

**Telnyx**
- "Alphanumeric Sender ID registration is required. All messages from unregistered Sender IDs will be rejected."
- To register, email alpha_sender_id@telnyx.com with the sender ID, content type, a content example, company name, brand, website, country of origin, expected monthly volume and account email, plus "a copy of your Business Registration".
- "Companies must have a valid business case for the requested Alphanumeric Sender ID."
- No turnaround time and no last-updated date are given.
— [Telnyx Lebanon SMS guidelines](https://support.telnyx.com/en/articles/6674807-lebanon-sms-guidelines)

**Plivo**
- Coverage page:
  - Numeric sender "Supported": "To ensure higher delivery, sender IDs in Lebanon are changed to random numeric sender IDs."
  - On registration: "Contact Plivo support for registration requirements".
  - Two-way: "Not Supported". Concatenation: "Yes". Deliverability is labelled "Reliable", with handset-level delivery receipts.
  — [Plivo SMS coverage – Lebanon](https://www.plivo.com/sms/coverage/lb/)
- A search summary of Plivo's support articles says Lebanon is "fully dynamic", that registration is "recommended, but not mandatory", that messages "will be delivered with a generic sender ID, such as 'SMS' or 'INFO', if no custom sender ID is preregistered", and that alphanumeric sending is not enabled on Plivo accounts by default. — [Plivo: Country Requirements for Sender ID Registration](https://support.plivo.com/hc/en-us/articles/360041448032-Country-Requirements-for-Sender-ID-Registration). This comes from the search-engine summary; the article itself was not opened, and the wording may merge several Plivo pages.

**AWS End User Messaging SMS**
- Supported-countries table, Lebanon row: short codes "No", long codes "No", Sender IDs "Yes" (not "Registration required"), two-way "No", international sending "Yes". — [AWS supported countries](https://docs.aws.amazon.com/sms-voice/latest/userguide/phone-numbers-sms-by-country.html)
- AWS provisions SMS "through a single carrier partner in each region/country. This creates a single point of failure", and recommends redundant channels such as WhatsApp. — [AWS supported countries](https://docs.aws.amazon.com/sms-voice/latest/userguide/phone-numbers-sms-by-country.html)

**Other providers**
- Messente: "Alpha sender names are available". "Network operators do not require sender name pre-registration". Handset-based delivery reports. The same content restrictions as Vonage (no political, religious, unsolicited promotion or gambling content). — [Messente Lebanon](https://support.messente.com/lebanon-sms-regulations)
- D7 Networks:
  - "SenderID Registration Required: No", but "Sender ID registration and message content approval are managed through their [operators'] platforms".
  - "Separate rules apply for domestic messaging and for international SMS traffic".
  - Two-way "No". Concatenation "Yes". Regulator: Telecommunications Regulatory Authority (TRA).
  - Market share: touch 55.0%, Alfa 42.0%.
  — [D7 Lebanon](https://d7networks.com/sms/lebanon/)
- Clickatell (all countries, not Lebanon-specific): it "cannot guarantee" delivery with the specified alphanumeric sender ID, because carriers may change it, and it "may attempt to change the Sender ID to a local or otherwise acceptable number". — [Clickatell: Does Clickatell support Sender ID?](https://www.clickatell.com/help-center/sms/country-regulations/clickatell-support-sender-id/)
- Sinch publishes its Lebanon rules only inside the logged-in "Country Information" pages of the Sinch Build Dashboard. — [Sinch Community](https://community.sinch.com/t5/Developer-Forum/Where-can-I-find-information-about-sending-messages-to-different/td-p/12706)

### Inferences
- The conflict most likely reflects **different routes into different operators**. The failure report is specific to Alfa, and Alfa put an exclusive international A2P gateway (VOX) in front of its network in December 2023 (Section 5). Providers whose Alfa route enforces registration (Telnyx, and apparently AWS's partner) say it is required. Providers that rewrite the sender (Plivo to a random number, Vonage "may overwrite") or use a pre-approved route (Twilio) say it is not.
- For a municipal system the **sender name is part of trust**: citizens should see the municipality's name. Plivo's random numeric rewrite and Vonage's overwriting defeat that, and anti-phishing guidance would tell citizens to ignore a random number asking them to log in.
- The safe plan is to **register an alphanumeric sender ID wherever the provider allows it**, even if its page says "not required", and to test delivery to both an Alfa (03/70/71/76/78/79/81 ranges) and a touch number with the chosen sender before launch.
- Every provider says two-way is unsupported. Citizens therefore cannot reply STOP by SMS, so opt-out has to go through the web app or a call centre.

### Gaps
- No provider states a **turnaround time** for Lebanon sender-ID registration. Telnyx and AWS only say to email or open a support case. The documents required: Telnyx wants business registration; AWS asks for company details, message templates and the opt-in process (from an AI-generated re:Post answer, so lower confidence).
- Infobip's Lebanon country-regulation page could not be retrieved: the URL guessed returned 404, and the coverage page is a dynamic country picker.
- No official Lebanese TRA rule on A2P sender-ID registration was found. D7's claim that registration is "managed through operators' platforms" has no primary source.

---

## 3. Documented delivery failures and successes to Lebanon

### Takeaway
Public evidence is **thin, and what exists is mostly failures**:
- **AWS End User Messaging** failed to deliver to **Alfa** with an unregistered sender ID (October 2025), and Lebanon was missing from the console's registration list.
- A Lebanese developer could not get an OTP from NVIDIA (September 2026) and blamed international-gateway filtering; the vendor behind NVIDIA's SMS is unknown.

No independent report was found of Twilio, Vonage, Sinch, Infobip, Plivo or Bird succeeding or failing to Lebanon. Every "reliable" or "95–98% delivery" claim comes from a provider's own marketing or from a low-quality aggregator. Deliverability therefore has to be **tested directly**.

### Cited Findings
- **AWS re:Post, 8 October 2025** (question status: not accepted):
  - The user wrote: "My messages are not being delivered to Lebanon for a specific mobile carrier (Alfa) via AWS end user messaging although I set up a sender ID. However, the sender ID is not yet registered."
  - "The AWS support team has informed me to … Create a new 'Service Limit Increase' case … SMS – New Sender ID Registration."
  - "My issue is that I cannot see the region Middle East Lebanon in the list to register a sender ID."
  - The only answer came from the AI "re:Post Agent", not AWS staff. It said Lebanon (Alfa) registration "is not available directly through the console registration options" and must go through a support case under "AWS End User Messaging SMS (Pinpoint)" → "Sender ID Registration".
  - The thread was last updated 2025-10-12 and shows no resolution.
  — [AWS re:Post: Sender ID Registration for Lebanon – SMS Delivery Issue](https://repost.aws/questions/QUvy69dPE9QUOvoYM6lJU5-Q/sender-id-registration-for-lebanon-sms-delivery-issue)
- This contradicts AWS's own country table, which marks Lebanon sender IDs as plain "Yes" (not "Registration required"). — [AWS supported countries](https://docs.aws.amazon.com/sms-voice/latest/userguide/phone-numbers-sms-by-country.html)
- **NVIDIA developer forum, 14 September 2026:** a user with a Lebanese +961 number never received the OTP for build.nvidia.com and wrote "It appears to be an international SMS gateway filtering issue". The moderator sent them to email support. The operator and SMS vendor are not stated. — [NVIDIA forum](https://forums.developer.nvidia.com/t/manual-account-verification-request-lebanon-961-otp-not-received/383223)
- **Firebase Phone Auth (GitHub issue #7810):** a Lebanon (+961) developer reports errors 39 (TOO_MANY_ATTEMPTS) and 17028 (INVALID_APP_CREDENTIAL) after development testing. From the search snippet this looks like rate limiting or app configuration, not a route failure. — [firebase-android-sdk #7810](https://github.com/firebase/firebase-android-sdk/issues/7810) (not opened; snippet only)
- Twilio's generic advice for undelivered error 30008 includes the case where "the destination network does not accept the sender you used, especially when you send with an alphanumeric sender ID". — [Twilio error 30008](https://help.twilio.com/articles/115005750588) (search summary)
- Self-reported delivery claims:
  - Plivo labels Lebanon deliverability "Reliable". — [Plivo coverage LB](https://www.plivo.com/sms/coverage/lb/)
  - Sent.dm claims 95–97% for Plivo and 96–98% for Sinch to Lebanon, with no methodology. — [Sent](https://www.sent.dm/en/resources/sms-pricing/lebanon-sms-pricing)

### Inferences
- The only concrete provider-level failure report involves **Alfa + unregistered sender**. That fits the Alfa/VOX gateway being the choke point (Section 5). touch may behave differently, so any pilot has to test both operators.
- The user's report that "many providers do not work in Lebanon" is consistent with this picture. Providers that route Lebanon traffic through cheap or unsanctioned routes, or send unregistered senders into Alfa, are likely to see silent drops, and the delivery receipt can still show "delivered" or "unknown".
- AWS is attractive because the app already runs on AWS (eu-west-3), but it has the **highest documented risk**: a user-reported Alfa failure, a registration flow that has no Lebanon option in the console, and a single carrier partner per country.

### Gaps
- No StackOverflow, Reddit (r/lebanon, r/twilio) or Twilio Community thread was found that documents a success or failure to Lebanon for Twilio, Vonage, Infobip, Sinch, Plivo, Bird or Telnyx. Several searches returned only generic troubleshooting pages. This absence is not evidence either way.
- The delivery rate broken down by operator (Alfa vs touch) is not published by any provider.

---

## 4. Verify / OTP products for Lebanon: price and automatic fallback

### Takeaway
Twilio Verify and Vonage Verify V2 are the two mature OTP products that clearly cover Lebanon.
- **Twilio Verify:** $0.05 per successful verification plus the Lebanon SMS channel fee (~$0.36), so about **$0.41 per SMS OTP**. It falls back automatically from **WhatsApp to SMS** (not the other way round).
- **Vonage Verify V2:** workflows that **fail over automatically** between SMS, WhatsApp and voice. Its public pricing feed shows **$0.052 per verification** for Lebanon; whether channel fees come on top depends on the pricing model.

Because a Lebanese SMS costs so much and Alfa delivery is uncertain, an OTP flow that starts on WhatsApp (far cheaper, delivered over data) with SMS as the fallback is worth evaluating. The WhatsApp side belongs to the OTP-channels research.

### Cited Findings

**Twilio Verify**
- Pricing: "$0.05 per successful verification plus standard channel fees". The SMS channel is "$0.05 per successful verification + $0.0083 per SMS (US). See international SMS pricing". WhatsApp is "$0.05 … + $0.0034 per authentication template message (US)". Volume discounts via sales. — [Twilio Verify pricing](https://www.twilio.com/en-us/verify/pricing)
- The Lebanon SMS rate the channel fee refers to is $0.3619. — [Twilio LB SMS pricing](https://www.twilio.com/en-us/sms/pricing/lb)
- Fallback:
  - "When using WhatsApp, Verify will automatically send your OTP message via SMS as a fallback in the event of an outage, degradation, destination country/region unavailability, or missing/misconfigured WhatsApp Sender"; fallback SMS are protected by Fraud Guard.
  - RCS→SMS and SNA→SMS automatic fallback are in **Pilot** (contact sales).
  — [Twilio Verify fallback scenarios](https://www.twilio.com/docs/verify/fallback-scenarios), [Twilio changelog](https://www.twilio.com/en-us/changelog/Verify_Fallback_Scenarios), [Automatic channel selection](https://www.twilio.com/docs/verify/automatic-channel-selection) (from search summaries)

**Vonage Verify V2**
- Workflows can chain silent auth, SMS, WhatsApp, voice and email with "automatic failover". Workflows "auto-advance on channel timeout" (for example, from SMS to a voice call without a second API call). — [Vonage Verify overview](https://developer.vonage.com/en/verify/overview), [Vonage Verify V2](https://www.vonage.com/about-us/vonage-stories/early-access-verify-2/) (search summary)
- Two pricing models (support article updated 2025-10-22):
  - **"Verify Conversion (Default Model)":** "A fixed platform fee is charged for successful conversions" and "Channel fees (SMS, TTS, WhatsApp, Email, Silent Authentication) are applied based on usage, regardless of conversion outcome".
  - **"Verify Success":** charged only on success, priced per destination country regardless of channel, and "available exclusively to enterprise customers".
  - Both say "Traffic to high-risk countries is not supported."
  — [Vonage: What are the charges for using Verify API V2?](https://api.support.vonage.com/hc/en-us/articles/14842100202268-What-are-the-charges-for-using-Verify-API-V2)
- Vonage's public Verify pricing feed for Lebanon: `{"title":"Lebanon","flatPushPrice":"0.05200000","flatFailPrice":"0","flatPrice":"0.05200000","restricted":null}`. — [Vonage LB.verify.USD.json](https://www.vonage.com/bin/vonage/communications-api/verify/LB.verify.USD.json)

**Other providers**
- AWS: recommends WhatsApp, push, voice or email as redundant channels for business-critical messaging, because SMS in each country depends on one carrier partner. — [AWS supported countries](https://docs.aws.amazon.com/sms-voice/latest/userguide/phone-numbers-sms-by-country.html)
- Unimatrix advertises "OTP SMS", "Omnichannel 2FA" and WhatsApp for Lebanon. — [Unimatrix LB](https://www.unimtx.com/sms/lb)

### Inferences
- **Twilio Verify, SMS only:** about $0.41 per successful Lebanon verification ($0.05 + $0.3619), assuming a single-segment code message and one send. Each resend adds $0.36, and the channel fee is charged whether or not the user completes the verification.
- **Vonage Verify:** "$0.052 flat" with `flatFailPrice 0` looks like a price per successful verification. Under the default V2 model, SMS channel fees (~$0.38 for Lebanon) would probably come on top; under the enterprise "Verify Success" model they might not. **Confirm with Vonage before relying on $0.052.** It is also unknown whether Lebanon counts as a "high-risk country" and is therefore excluded.
- Rolling your own OTP (generate the code in NestJS, send over plain SMS) costs only the SMS fee ($0.28–$0.38) but gives up fraud protection (SMS-pumping / AIT guards) and managed fallback. SMS-pumping fraud matters for an expensive destination like Lebanon: every fraudulent request costs about $0.35.

### Gaps
- No Lebanon-specific Verify prices were found for Plivo (the Verify pricing URL for LB returned 404), Sinch Verification, Infobip 2FA, Telnyx Verify, Msg91 OTP, Kaleyra or 8x8.
- Whether Vonage Verify's Lebanon price includes the SMS channel is unconfirmed.
- Whether WhatsApp authentication templates are allowed or priced for Lebanon under each provider was not researched here; it belongs to the OTP-channels notes.

---

## 5. Direct operator connections to Alfa and touch, versus aggregators

### Takeaway
No international provider publicly claims a **direct** connection to Alfa or touch. The decisive fact is on the operator side:
- **Alfa (MIC1)** signed a **3-year exclusive agreement with VOX Solutions** (announced 5 December 2023) for all international A2P SMS and OTP-voice traffic. Every international CPaaS reaches Alfa through VOX's gateway, and grey or bypass routes are what it is built to block.
- **touch (MIC2)** published a tender on 15 May 2025 for a **joint international A2P SMS arrangement for MIC2 and MIC1**, so both operators appear to be consolidating international A2P behind one controlled gateway.

### Cited Findings
- Alfa and VOX Solutions:
  - Announced 5 December 2023: a "3-year exclusive interworking agreement" covering "international A2P SMS and OTP voice traffic".
  - It covers protection against "messaging bypass", flash-call fraud and Artificially Inflated Traffic (AIT), on the "VOX-360 platform in A2P Voice and SMS traffic monetization".
  - Alfa CEO Jad Nassif: it will "help make Alfa network more secure against the increasing menace of A2P Voice (flash calling) volumes, A2P messages spam and Artificial Inflated Traffic".
  — [PR Newswire: Alfa selects VOX Solutions](https://www.prnewswire.co.uk/news-releases/alfa-selects-vox-solutions-as-its-exclusive-partner-for-international-a2p-sms-and-otp-voice-traffic-gateway-control-and-optimization-302002624.html); also [GSMA membership news](https://www.gsma.com/get-involved/gsma-membership/gsma_resources/alfa-selects-vox-solutions-as-its-exclusive-partner-for-international-a2p-sms-and-otp-voice-traffic-gateway-control-and-optimization/)
- MIC2 tender: Mobile Interim Company No.2 S.A.L. published "General Bood [sic] for the International A2P SMS Joint for Mic2 and Mic1" on 15 May 2025 (deadline 27 May 2025, notice 5065ppa_lb). The full scope is behind the aggregator's registration wall. — [Tender Impulse](https://tenderimpulse.com/government-tenders/lebanon/general-bood-for-the-international-a2p-sms-joint-for-mic2-and-mic1-7957168)
- Infobip claims "800+ direct operator connections" across 190+ countries but lists nothing for Lebanon. Its pricing page warns that "lowest-priced SMS provider[s] … might use inferior routes". — [Infobip international SMS](https://www.infobip.com/sms/international), [Infobip SMS pricing](https://www.infobip.com/sms/pricing)
- AWS: "Phone numbers for SMS delivery are provisioned through a single carrier partner in each region/country." — [AWS supported countries](https://docs.aws.amazon.com/sms-voice/latest/userguide/phone-numbers-sms-by-country.html)
- Sinch's price feed has separate network keys for Alfa (`/LB/522/`) and Touch (`/LB/523/`), and Plivo prices the two separately. Both route per operator, but neither says the connection is direct. — [Sinch pricing](https://sinch.com/pricing/sms/), [Plivo LB pricing](https://www.plivo.com/sms/pricing/lb/)

### Inferences
- The Alfa/VOX agreement ran for 3 years from about December 2023, so it **expires around December 2026**. The joint MIC1/MIC2 tender suggests the arrangement for both operators may change around then. Routes, prices and registration rules for Lebanon could shift in late 2026 or early 2027, so the SMS integration should be provider-agnostic: an adapter interface in the NestJS backend, with the ability to switch providers.
- Given the anti-bypass gateway, the dependable providers will be those that buy **sanctioned** international A2P termination into Alfa and touch. The cluster of tier-1 prices at $0.30–$0.38 is consistent with that, while $0.13 (Unimatrix) and €0.05-class offers (e.g. BudgetSMS, seen only in a search snippet) are not.
- A Lebanese municipality could also buy **local A2P** directly from Alfa or touch, or through a local aggregator, which avoids international termination entirely. That is covered in the companion local-providers notes.

### Gaps
- No public document names which international aggregators hold sanctioned interconnects into VOX (Alfa) or into touch.
- The outcome and winner of the MIC2/MIC1 tender (May 2025) were not found.

---

## 6. Account, KYC and payment problems for a Lebanese customer

### Takeaway
No provider was found that explicitly refuses Lebanese customers: Lebanon is not a sanctioned country. The practical barriers are **payment** and **sender-ID KYC**.
- Lebanese bank cards often fail on international online payments. Pre-2019 "old dollar" accounts are restricted, and only "fresh dollar" cards reliably work.
- Most CPaaS providers are prepaid by card, so a working foreign-currency card or a foreign entity may be needed.
- Registering a sender ID (Telnyx, AWS) needs business registration documents and a clear brand link. For a municipality that means official papers showing the municipality's name matches the sender ID.

### Cited Findings
- Payment environment in Lebanon:
  - Visa and Mastercard are widely accepted, but international payments were restricted after the 2019 crisis and "fresh USD cards" were introduced.
  - "Since 2022, 'fresh dollar' credit cards linked to accounts regained their function."
  - On 1 July 2025, Banque du Liban Basic Decision No. 13729 restricted payments from pre-17-November-2019 foreign-currency accounts.
  — [PayAtlas Lebanon](https://payatlas.com/countries/lebanon-lb), [LCPS: Central Bank circulars 2025](https://www.lcps-lebanon.org/en/articles/details/5004/central-bank-circulars-and-deposit-access-in-2025), [HSF Kramer on BdL decision](https://www.hsfkramer.com/notes/arbitration/2025-06/foreign-currency-foreign-litigation-lebanon) (from search summaries)
- Twilio's card-decline guidance (all countries): declines come from credit limits, from debit cards run as credit, and from AVS address-verification mismatches ("Twilio's payment processor uses AVS … for all charges"). Twilio also accepts PayPal. — [Twilio: Why doesn't my credit card work?](https://support.twilio.com/hc/en-us/articles/223183308-Why-doesn-t-my-credit-card-work), [Twilio: Adding a credit card or PayPal](https://support.twilio.com/hc/en-us/articles/223135627-Adding-a-new-credit-card-or-Paypal-account-to-your-Twilio-project)
- ClickSend: prepaid, minimum top-up $20, maximum $10,000. — [ClickSend pricing API](https://rest.clicksend.com/v3/pricing/LB?currency=USD)
- Telnyx sender-ID KYC for Lebanon: a copy of the business registration, a valid business case, and extra documentation "if the relationship between your company/brand and the requested Alphanumeric Sender ID is not clear". — [Telnyx Lebanon guidelines](https://support.telnyx.com/en/articles/6674807-lebanon-sms-guidelines)
- AWS sender-ID registration goes through a support case. The AI answer on re:Post lists: sender ID, templates, messages per recipient per month, opt-in process, and company name, address, country, phone and website. It also says "your request might be denied if your use case doesn't align with AWS policies." — [AWS re:Post](https://repost.aws/questions/QUvy69dPE9QUOvoYM6lJU5-Q/sender-id-registration-for-lebanon-sms-delivery-issue)
- Vonage requires the sender ID to "contain the brand name" and prohibits generic senders (INFO, SMS, NOTICE). — [Vonage Lebanon](https://api.support.vonage.com/hc/en-us/articles/204017663-Lebanon-SMS-Features-and-Restrictions)

### Inferences
- AWS has the smoothest billing path for this project: SMS charges land on the existing AWS invoice with no separate card. That advantage has to be weighed against the documented Alfa registration problem.
- For a government or municipal sender, the sender ID should be the municipality's name, transliterated to 11 Latin characters or fewer. The KYC evidence is then municipal registration or decree documents. Whether international providers accept a Lebanese municipality (rather than a company) as the registrant was not documented.
- If Lebanese cards fail, the realistic options are: a fresh-dollar card; paying through a foreign entity such as a developer or contractor company abroad; a provider that invoices by bank transfer (usually after a sales-led contract, as at Infobip, Sinch and Vonage enterprise); or AWS consolidated billing.

### Gaps
- No provider-specific evidence was found (forum posts or policy pages) that Twilio, Vonage, Plivo, Telnyx, Infobip or Sinch reject **Lebanese-issued** cards or Lebanon-based sign-ups.
- The claim that Stripe does not support Lebanon was not checked here; it came from the task context.
- Whether any provider offers postpaid or bank-transfer billing to Lebanese public bodies at ~$3k/month volume was not found. It needs a sales enquiry.
