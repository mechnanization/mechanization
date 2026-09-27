# Keep Lebanese SMS on domestic routes

The best setup is two SMS routes, which the backend already has room for. The **primary route should be a Lebanese aggregator with its own domestic connections to Alfa and touch**, carrying both login codes and the 4,000+ monthly owner and tenant notices. The **fallback route should be Twilio Programmable SMS with a registered alphanumeric sender**; the code already switches to the fallback on a citizen's second attempt. ProxiReach S.A.R.L. (which also sells as BestSmsBulk) leads the local field because it is the only seller with public API documentation and a public price, "from $0.02/SMS". Lebanon SMS provides the second quotation that procurement law requires anyway. WhatsApp templates at $0.0091 each belong in a second phase, for owners on foreign numbers and as a hedge on price, not as the backbone.

The case rests on routes, not brands. Every international provider enters Lebanon through gateways the operators put out to tender. Those gateways blocked WhatsApp and X login codes on both networks in early 2025, and they are being re-tendered now. Their wholesale rate of €0.075–0.105 per SMS keeps every global provider at $0.28–0.38 per segment. For the notices alone that is $1,100–2,900 a month, which is above the roughly $16,760 limit for buying on two quotations.

**No provider, local or international, has independent proof of delivery to Lebanon.** The local price and "direct route" claims are marketing, so a pilot with Alfa and touch SIM cards has to confirm the choice. Integration should also wait on one code fix. Today the OTP endpoint texts a code to any Lebanese mobile number a stranger types in, and lets the caller choose the expensive route.

## Every global provider buys the same contested gateway into Alfa and touch

Lebanon's two mobile operators, Alfa (MIC1) and touch (MIC2), are state-owned. The Ministry of Telecommunications has run them since the Orascom and Zain management contracts ended in 2020 ([Mobile World Live](https://www.mobileworldlive.com/featured-content/top-three/government-takes-control-of-lebanon-operators/)). Each operator gave all *international* business SMS (A2P) traffic to one exclusive gateway partner, chosen by tender:

- **Alfa** signed with VOX Solutions on 7 June 2023.
- **touch** signed with In Mobiles on 22 May 2023. In January 2024 Lebanon's Audit Bureau found the touch contract "unlawful" and a cause of "significant financial losses to the public treasury" ([SMEX, Feb 2024](https://smex.org/lebanese-telecom-minister-favors-unlawful-bid-for-a2p-services/)).

VOX announced its deal as a **three-year exclusive** for international A2P SMS and OTP voice. It markets its platform as protection against "messaging bypass" and artificially inflated traffic ([VOX Solutions](https://voxsolutions.co/alfa-selects-vox-solutions-as-its-exclusive-partner-for-international-a2p-sms-and-otp-voice-traffic-gateway-control-and-optimization/)). The wholesale terms set the price floor for every provider downstream: **€0.105 per SMS through VOX and €0.075 through In Mobiles** ([SMEX, Feb 2025](https://smex.org/lebanons-telecom-feud-disrupts-sms-verification-system/)).

That arrangement has already failed at exactly what this app needs. In early 2025, during the dispute over the gateway contracts, "subscribers to both providers couldn't receive SMS verification codes" for WhatsApp, X and other services. Alfa had also reportedly gone about a year without payment from VOX ([SMEX, Feb 2025](https://smex.org/lebanons-telecom-feud-disrupts-sms-verification-system/)).

The underlying problem is not settled. In May 2025 touch tendered a joint international A2P arrangement for both operators ([TenderImpulse](https://tenderimpulse.com/government-tenders/lebanon/general-bood-for-the-international-a2p-sms-joint-for-mic2-and-mic1-7957168)). In February 2026 a single set of terms for re-tendering both was still with the Public Procurement Authority ([Kataeb.org](https://www.kataeb.org/articles/%D8%AE%D8%AF%D9%85%D8%A9-%D8%A7%D9%84%D8%B1%D8%B3%D8%A7%D8%A6%D9%84-%D8%A7%D9%84%D8%B0%D9%83%D9%8A%D8%A9-%D9%81%D9%8A-%D8%A7%D9%84%D8%AE%D9%84%D9%8A%D9%88%D9%8A-%D8%A3%D9%85%D8%A7%D9%85-%D8%AA%D9%84%D8%B2%D9%8A%D9%85-%D8%AC%D8%AF%D9%8A%D8%AF)). Three years from the June 2023 signing or the December 2023 announcement puts the **end of Alfa's exclusive between June and December 2026**. International routing, prices and sender rules for Lebanon could therefore change in the same months this system goes live.

Published prices fit this picture: every tier-1 provider sits in a narrow band above the wholesale floor.

| Provider | USD per segment to Lebanon | Sender-ID position for Lebanon | Fit as the fallback route |
|---|---|---|---|
| Bird | $0.28 ([Bird](https://bird.com/sms-api/pricing/lb)) | Not published | Cheapest reserve |
| Infobip | ~$0.303, average across networks ([Infobip](https://www.infobip.com/sms/pricing)) | Country page not retrievable | Viable. Infobip is EU-based, so it applies stricter checks to Lebanese customers (see below) |
| Plivo | Alfa $0.3154, touch $0.3522 ([Plivo](https://www.plivo.com/sms/pricing/lb/)) | Senders "changed to random numeric sender IDs" ([Plivo](https://www.plivo.com/sms/coverage/lb/)) | Reject: citizens would see an anonymous number |
| Sinch | $0.34055, same price for Alfa and touch ([Sinch](https://sinch.com/pricing/sms/)) | Behind a login | Viable. Also EU-based |
| AWS End User Messaging | $0.34985 ([AWS price list](https://d1.awsstatic.com/onedam/marketing-channels/website/aws/en_US/business-applications/approved/documents/End-User-Messaging-SMS-Prices.ebc340b4d416d90832dd59629c4792b0deb6f8bc.csv)) | Country table says no registration; a field report shows Alfa failing unregistered senders | Reject for now |
| Twilio | $0.3619 ([Twilio](https://www.twilio.com/en-us/sms/pricing/lb)) | Pre-registration "Not Required"; sender ID "preserved" ([Twilio](https://www.twilio.com/en-us/guidelines/lb/sms)) | **Recommended fallback** |
| Vonage | $0.37944 ([Vonage](https://www.vonage.com/bin/vonage/communications-api/messaging/LB.messaging.USD.json)) | Senders "may also be overwritten"; must contain the brand name ([Vonage](https://api.support.vonage.com/hc/en-us/articles/204017663-Lebanon-SMS-Features-and-Restrictions)) | Second choice |
| Telnyx | Not public | "All messages from unregistered Sender IDs will be rejected" ([Telnyx](https://support.telnyx.com/en/articles/6674807-lebanon-sms-guidelines)) | Viable if its checks accept a municipality |
| ClickSend | $0.3807–0.4405 by volume tier ([ClickSend](https://rest.clicksend.com/v3/pricing/LB?currency=USD)) | Not stated | Most expensive |

The cheapest and dearest tier-1 providers are only about 35% apart. Offers far below that band are a warning sign, not a bargain:

- **BudgetSMS** advertises Lebanon "from €0.05" ([BudgetSMS](https://www.budgetsms.net/sms-gateway-pricing/lb/lebanon/)). That is below both operators' contracted wholesale rates, so it cannot be buying approved international delivery.
- **Unimatrix** charges $0.134 ([Unimatrix](https://www.unimtx.com/sms/lb)), which leaves almost no margin over VOX's €0.105.
- **Infobip** itself warns that the lowest-priced providers "might use inferior routes" ([Infobip](https://www.infobip.com/sms/pricing)).

What no one can show is that messages actually arrive. Every "reliable" or "95–98% delivery" figure for Lebanon comes from a provider or an aggregator's marketing page ([Plivo](https://www.plivo.com/sms/coverage/lb/); [Sent](https://www.sent.dm/en/resources/sms-pricing/lebanon-sms-pricing)). No independent report of success turned up for Twilio, Vonage, Sinch, Infobip, Plivo or Bird. The field reports that exist are failures:

- **October 2025, AWS.** A customer reported that messages to **Alfa** subscribers were not delivered while the sender ID was unregistered, and that Lebanon was missing from the console's registration list. The thread ends unresolved ([AWS re:Post](https://repost.aws/questions/QUvy69dPE9QUOvoYM6lJU5-Q/sender-id-registration-for-lebanon-sms-delivery-issue)).
- **September 2026, NVIDIA.** A developer with a Lebanese number never received NVIDIA's sign-up code and blamed filtering at the international gateway ([NVIDIA forum](https://forums.developer.nvidia.com/t/manual-account-verification-request-lebanon-961-otp-not-received/383223)).

The AWS case matters most, because it contradicts AWS's own country table. That table lists Lebanese sender IDs as plain "Yes", not "Registration required" ([AWS](https://docs.aws.amazon.com/sms-voice/latest/userguide/phone-numbers-sms-by-country.html)). The failure matches Telnyx's rule that unregistered senders are rejected. Twilio says the opposite: registration is not required, alphanumeric senders are preserved, and numeric senders are overwritten and delivered "best effort" only ([Twilio](https://www.twilio.com/en-us/guidelines/lb/sms)). The likeliest explanation is that providers reach Alfa's gateway over different routes, each with its own rules.

The practical conclusion is the same whichever provider wins:

- **Register a sender name with every provider**, even where it says registration is "not required". Use the municipality's name in Latin letters, at most 11 characters.
- **Test that name on Alfa specifically.**
- **Put opt-out in the web app.** Every source agrees that Lebanon has no two-way SMS or short codes ([Twilio](https://www.twilio.com/en-us/guidelines/lb/sms); [D7](https://d7networks.com/sms/lebanon/)), so citizens cannot reply STOP.

AWS needs a direct verdict because it is tempting. The backend already runs on an AWS Lightsail host in eu-west-3 and already uses the AWS SDK, so SMS charges would land on an existing invoice ([database-environments.md](../docs/database-environments.md); [AWS IP ranges](https://ip-ranges.amazonaws.com/ip-ranges.json); [package.json](../apps/backend/package.json)). Against that, AWS sends each country's traffic "through a single carrier partner" and calls this "a single point of failure" ([AWS](https://docs.aws.amazon.com/sms-voice/latest/userguide/phone-numbers-sms-by-country.html)). And the Alfa report above is the only documented failure of a named provider.

Plivo fails a different test. A random number asking a citizen to log in looks like the fake SMS that has already impersonated OMT in Lebanon ([Al Jadeed](https://www.aljadeed.tv/news/%D9%85%D8%AD%D9%84%D9%8A%D8%A7%D8%AA/585591/omt-%D8%A7%D8%AD%D8%B0%D8%B1%D9%88%D8%A7-%D8%B1%D8%B3%D8%A7%D8%A6%D9%84-%D8%A7%D9%84%D8%A7%D8%AD%D8%AA%D9%8A%D8%A7%D9%84-%D8%B5%D9%88%D8%B1%D8%A9/ar)).

Twilio earns the fallback slot despite a mid-band price, for three reasons:

- It documents that the sender name is preserved for Lebanon.
- Since August 2025 it returns explicit error codes when a sender is unregistered ([Twilio changelog](https://www.twilio.com/en-us/changelog/updates-to-alphanumeric-sender-id-compliance-checks-and-error-co)).
- It accepts PayPal as well as cards ([Twilio](https://support.twilio.com/hc/en-us/articles/223135627-Adding-a-new-credit-card-or-Paypal-account-to-your-Twilio-project)).

## A domestic connection costs cents, if the aggregators' claims survive a test

Both operators also sell a domestic bulk-SMS product that does not pass through the international gateway. Alfa's "Bulk SMS" is an SMPP connection over a fixed IP with "Dynamic Sender ID", billed monthly "according to its relative rate". It explicitly lets partners resell to "banks, educational institutions, malls, and shops" ([Alfa](https://www.alfa.com.lb/en/business/sms-short-code)). touch sells the same kind of connection, with "a trial amount of 1000 Free SMS" ([touch](https://legacy.touch.com.lb/autoforms/portal/touch/business/bulk-sms)). D7 confirms that "separate rules apply for domestic messaging and for international SMS traffic" ([D7](https://d7networks.com/sms/lebanon/)).

Neither operator publishes a price, a minimum volume or who is eligible. Going direct would mean:

- two SMPP contracts, one per operator;
- a fixed public IP;
- an SMPP client or bridge in the backend.

That is a lot of machinery for about 5,000 messages a month. It is worth revisiting if several municipalities later buy together.

A direct contract with an operator would also probably still need a tender. The procurement law's direct-contracting exception covers "public law entities", but the operators are commercial S.A.L. companies ([TenderImpulse](https://tenderimpulse.com/government-tenders/lebanon/general-bood-for-the-international-a2p-sms-joint-for-mic2-and-mic1-7957168); [Law 244/2021](https://institutdesfinances.gov.lb/sites/default/files/2024-12/PP%20Law-unofficial%20translation-dec24-en_1.pdf)). Whether the exception applies is a question for a lawyer.

The practical way onto those domestic connections is a local aggregator. Four Lebanese sellers turned up; only two are credible for a backend integration.

**ProxiReach S.A.R.L.** is based in Beirut and also trades as BestSmsBulk; the two websites belong to one company ([BestSmsBulk](https://www.bestsmsbulk.com/sms/countries/lebanon)).

- **Routes:** "Touch, Alfa, and international routes" ([BestSmsBulk](https://www.bestsmsbulk.com/sms-lebanon)).
- **Price:** **"Lebanon starts at $0.02/SMS"** ([BestSmsBulk](https://www.bestsmsbulk.com/)).
- **API:** it is the only local seller with public documentation ([API docs](https://www.bestsmsbulk.com/pro-support/api_documentation_bsb)).
  - Requests carry an `api_key`, an `api_secret`, a `senderid` and semicolon-separated destinations.
  - A send returns a confirmation ID and the number of billed parts.
  - Delivery status must be *polled*, for up to 500 messages per call.
  - Documented errors include "Sender ID is not authorized" and "No credits".
- **WhatsApp:** it also sells WhatsApp API access ([ProxiReach](https://www.proxireach.com/)).

**Lebanon SMS** is based in Fanar and was founded in 2009 ([Lebanon SMS](https://www.lebanon-sms.com/about)).

- It claims "Direct routes to Alfa and Touch networks", REST and SMPP access, and custom sender IDs of up to 11 characters.
- It states that an Arabic SMS holds 70 characters.
- It publishes no API documentation and no price ([Lebanon SMS](https://www.lebanon-sms.com/)).

The other two are not usable. Asmar Pro publishes nothing technical ([Asmar Pro](https://www.asmarpro.com/Bulk-SMS-Advertising)), and GlobeSMS's newest news item dates from February 2021 ([GlobeSMS](http://globesms.net/)).

Every one of these claims is marketing:

- Neither credible aggregator appears as a partner on either operator's site.
- Neither names a government, municipal or bank client, and no independent review of either exists.
- No public source says which SMS provider IMPACT, OMT, Whish or any Lebanese bank uses ([CIB: IMPACT](https://www.cib.gov.lb/en/impact-inter-ministerial-and-municipal-platform-assessment-coordination-and-tracking)).
- $0.02 is a "starts at" price, probably for high volumes. Nothing says how Arabic (UCS-2) segments are billed or whether failed messages are charged.

The gap between $0.02 and the €0.075–0.105 international wholesale rate makes sense only because domestic traffic is not charged the international delivery rate. That gap is also why the operators police "bypass" (foreign traffic disguised as domestic). An aggregator that also pushes foreign customers' traffic through its domestic connections is exactly what VOX's platform is built to catch ([VOX Solutions](https://voxsolutions.co/alfa-selects-vox-solutions-as-its-exclusive-partner-for-international-a2p-sms-and-otp-voice-traffic-gateway-control-and-optimization/)). If caught, it could lose those connections overnight. That is the strongest reason to keep an international fallback even when the local route works.

Before signing, get these answers in writing from each aggregator:

- the price per Arabic segment at this volume, and whether undelivered messages are charged;
- whether Lebanese traffic goes over its own connections to both operators or over its "international routes";
- where its gateway is hosted and how it rides out power cuts;
- how long it keeps message text and numbers;
- how long sender-name registration takes;
- whether it can push delivery receipts instead of requiring polling;
- payment terms.

Segment length matters more than the choice of provider. Bird bills "per message segment", and a longer message bills as several ([Bird](https://bird.com/sms-api/pricing/lb)). An Arabic segment holds 70 characters ([Lebanon SMS](https://www.lebanon-sms.com/)). The current OTP text is 37 characters and fits in one ([otp.service.ts](../apps/backend/src/application/features/identity/otp.service.ts)). Keeping each notice to one segment halves the bill on any route:

| Route for 4,000 notices a month | One segment (≤70 Arabic characters) | Two segments |
|---|---|---|
| Local aggregator at the advertised $0.02 | $80 | $160 |
| Bird at $0.28 | $1,120 | $2,240 |
| Twilio at $0.3619 | $1,448 | $2,895 |
| Vonage at $0.37944 | $1,518 | $3,035 |
| WhatsApp utility template, $0.0091 Meta fee | $36 | Billed per message, not per segment |

## WhatsApp buys reach, not savings, once a domestic SMS price holds

Meta has charged per delivered template message since 1 July 2025. Lebanon falls in Meta's "Rest of Middle East" pricing market ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)). There, utility and authentication templates cost **$0.0091 each** ([Twilio rate CSV](https://www.twilio.com/content/dam/twilio-com/pricing-data/en/WhatsAppPricing-pricing-details.csv); [SleekFlow](https://sleekflow.io/blog/whatsapp-business-price)), roughly forty times less than one international SMS segment.

Pricing changes again on **1 October 2026**, five days from now. Utility templates sent inside an open customer-service window stop being free, and service messages become billable ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages)). Budget every notice at the full utility rate. Authentication templates offer a "copy code" button that works in an ordinary web app ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates)), which suits this app's Next.js frontend.

The obstacles are eligibility and reach, not price.

- **Government accounts.** Meta allows government entities only "through a Solution Provider". It forbids asking people to share "personal ID card numbers", and requires recorded opt-in ([WhatsApp Business Policy](https://whatsappbusiness.com/policy/)).
- **Approval time and cost.** A government sender needs extra Meta approval plus Classic business verification, typically 3–5 weeks. One Solution Provider's government plan costs €99 a month per number before message fees ([360dialog](https://docs.360dialog.com/docs/resources/government-agencies)).
- **Sending limits.** A new business account can message only 250 unique users a day until verification raises the limit to 2,000 ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits)). The first monthly batch of 4,000 would take at least two days.
- **Reach.** The best hard figure is Pew's 2018 survey: 84% of Lebanese adults use WhatsApp, but only **60% of those over 50** ([Pew](https://www.pewresearch.org/short-reads/2019/11/19/protests-in-lebanon-highlight-ubiquity-of-whatsapp-dissatisfaction-with-government/)). Fee notices go to property owners and household heads, a group that plausibly skews older. The channel is weakest for exactly this audience.

Putting the numbers together: if the local SMS quote lands near $0.02, WhatsApp saves about $44 a month on 4,000 notices. One €99 Solution Provider plan wipes that out. Twilio adds $0.005 per WhatsApp message instead of a monthly fee ([Twilio](https://www.twilio.com/en-us/whatsapp/pricing)), which cuts the saving to about $24.

The case for WhatsApp then rests on two things SMS does badly:

- **Owners abroad.** It reaches owners on foreign numbers. The citizen schema accepts those numbers ([primitives.ts](../packages/shared-schemas/src/primitives.ts)), but a Lebanese aggregator may not deliver to them.
- **A second path.** It keeps working when the Lebanese SMS route fails.

If the local quote instead comes back near international prices, WhatsApp-first becomes unavoidable: $36 a month against $1,448 or more.

Either way, start Meta's government approval now, because both outcomes depend on it. The business account should belong to the municipality. Meta charges a higher "authentication-international" rate only when the business is based outside the recipient's country, and Lebanon is not on that list today ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/authentication-international-rates/)).

For login codes the cost gap between channels widens:

| Channel | Cost per 1,000 codes to Lebanon | Catch |
|---|---|---|
| WhatsApp authentication template | $9.10 Meta fee, charged only on delivery | Needs a WhatsApp user and prior approval |
| Telegram Gateway | $10, refunded if undelivered ([Telegram](https://core.telegram.org/gateway)) | About 717K weekly users in Lebanon ([Sensor Tower](https://sensortower.com/blog/2024-q1-unified-top-5-communication%20apps-units-lb-6070aae1241bc16eb81f5bab)), roughly 12% of the population |
| Local aggregator at $0.02 | About $20 | Price unverified |
| Firebase / Identity Platform | $280 ([Google Cloud](https://cloud.google.com/identity-platform/pricing)) | Google generates the code; needs a client SDK and reCAPTCHA |
| Twilio Programmable SMS | $362 | None beyond price |
| Twilio Verify over SMS | $412 ($0.05 fee plus the SMS) ([Twilio](https://www.twilio.com/en-us/verify/pricing)) | Duplicates the backend's own OTP logic |
| Twilio voice call | $372 per minute ([Twilio](https://www.twilio.com/en-us/voice/pricing/lb)), plus $50 through Verify | Twilio's fraud protection does not cover voice ([Twilio](https://www.twilio.com/docs/verify/preventing-toll-fraud/sms-fraud-guard)) |

Managed "Verify" products are the mainstream answer, and the wrong one here.

- **Twilio Verify** adds $0.05 per successful verification. Its WhatsApp-to-SMS fallback that keeps the same code is still a pilot ([Twilio](https://www.twilio.com/docs/verify/whatsapp)).
- **Vonage Verify v2** is the closest ready-made fit: it chains up to three channels and moves to the next after a timeout ([Vonage](https://developer.vonage.com/en/api/verify.v2)). But its Lebanon price is ambiguous. Its public price list shows $0.052 per verification ([Vonage](https://www.vonage.com/bin/vonage/communications-api/verify/LB.verify.USD.json)). Its support article describes a fee per successful verification plus channel fees on every attempt under the default model ([Vonage](https://api.support.vonage.com/hc/en-us/articles/14842100202268-What-are-the-charges-for-using-Verify-API-V2)).

Both products would move code generation and storage to the vendor. This backend already generates six-digit codes with `crypto.randomInt`, stores them bcrypt-hashed with a five-minute lifetime, and destroys them after five wrong guesses ([otp.service.ts](../apps/backend/src/application/features/identity/otp.service.ts); [app.config.ts](../apps/backend/src/presentation/config/app.config.ts)). Paying $50 per 1,000 to duplicate that mostly buys fraud protection, and the destination lock described below gets most of that benefit for one database query.

The remaining channels each fall short:

- **Firebase** has the same problem of owning the code, and it is still SMS over routes Google chooses.
- **Telegram** is cheap but reaches too few people to cover those WhatsApp misses.
- **Voice** costs as much as SMS and is a classic target for fraud that inflates traffic. It belongs behind an explicit "call me" button, if anywhere.
- **Email** is out as a login factor. NIST says email "SHALL NOT be used for out-of-band authentication" ([NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)), and this system stores email addresses only for staff ([schema.prisma](../apps/backend/src/infrastructure/prisma/tenant/schema.prisma)).

The same NIST standard classes SMS as "restricted" and requires "alternative authenticator types" to be available to all users. The existing رقم مرجعي (reference-number) login already gives every citizen a way in that does not depend on SMS ([fee.schema.ts](../packages/shared-schemas/src/fee.schema.ts)).

## Procurement, payment and Law 81 all reward the domestic route

**Procurement.** Public Procurement Law 244/2021 covers "municipalities and federations of municipalities" and makes an open tender the default ([Law 244/2021](https://institutdesfinances.gov.lb/sites/default/files/2024-12/PP%20Law-unofficial%20translation-dec24-en_1.pdf)).

- Below **LBP 1.5 billion**, a municipality may buy on quotations ("procurement by invoice"): at least two suppliers, and the lowest compliant offer wins.
- Up to LBP 15 billion, a request for quotations is allowed.
- Splitting a purchase to stay under a threshold is prohibited.

At the official rate of about 89,500 lira to the dollar ([Wikipedia](https://en.wikipedia.org/wiki/Lebanese_pound)), the lower limit is about **$16,760**. That turns the price gap into a legal constraint:

- A year of one-segment notices through Twilio (48,000 × $0.3619 ≈ $17,370) crosses the limit before a single login code is sent.
- The same year at the local aggregator's advertised price costs about $960.

The two credible local aggregators are also the two quotations the law requires. Using the international provider only as a fallback keeps its annual spend low enough not to force a tender.

Each municipality buys for itself under the law. Alternatively, the software team could buy SMS centrally and bill it as part of its service. That moves both the procurement question and the payment problems below onto the vendor contract.

**Payment.** International card payment is its own obstacle.

- After the 2019 crisis, Lebanese cards backed by pre-crisis deposits lost online use. Online payment abroad works with "fresh dollar" cards funded with new money ([The961](https://www.the961.com/netflix-credit-cards-online-payments-lebanon/)).
- Lebanon has been on the FATF grey list since October 2024 ([FATF](https://www.fatf-gafi.org/en/countries/detail/Lebanon.html)) and on the EU's list of high-risk countries since June 2025 ([European Commission](https://finance.ec.europa.eu/news/commission-updates-list-high-risk-countries-strengthen-international-fight-against-financial-crime-2025-06-10_en)). EU-regulated companies must therefore apply enhanced customer checks, which adds friction with EU-based Infobip and Sinch.
- No provider was found that refuses Lebanese customers outright.

Nothing found says whether a municipality can pay a foreign vendor in fresh dollars from its own funds at all. A local vendor can issue the Lebanese invoice that procurement by invoice assumes.

**Data protection.** Lebanon's data law, Law 81/2018, does not block foreign processors. DLA Piper reads it as "silent on cross-border data transfers", with no independent regulator and no administrative enforcement ([DLA Piper](https://www.dlapiperdataprotection.com/?t=law&c=LB)). Its duties still bind the municipality ([Law 81/2018](https://smex.org/wp-content/uploads/2018/10/E-transaction-law-Lebanon-Official-Gazette-English.pdf)):

- **Article 88:** people must be told at collection the "persons to whom the data is to be sent". The registration notice must therefore name the SMS providers, and Meta if WhatsApp is added.
- **Article 93:** security measures must match the sensitivity of the data.
- **Article 106:** it is a crime, punishable by three months to three years, for anyone who "even if negligently, discloses personal data under processing to unauthorized persons". The maximum fine is LBP 30 million (about $335), but the prison term is real.

SMS text can be read by carriers, gateway operators such as VOX, and anyone holding the phone. So no message may contain a national ID number, residency or refugee status, an address or household details. The same applies to the رقم مرجعي: on the reference-only login route it is the whole credential ([auth.controller.ts](../apps/backend/src/presentation/controllers/auth.controller.ts)). A notice should say only that something new is waiting, and send the citizen to log in.

No Lebanese rule on business SMS sender names, content, opt-out or sending hours was found. The telecom regulator was only revived in October 2025 and has issued no SMS rules yet ([The Beiruter](https://www.thebeiruter.com/article/lebanon-revives-its-telecom-regulator-after-13-years-of-silence/253)). Binding requirements are most likely to come from it or from the gateway re-tender. Law 81's opt-out article covers marketing email, not official notices, but offering an opt-out for non-essential notices costs little. Because Lebanese SMS is one-way, that opt-out has to live in the web app.

## The backend already has two routes; it needs locks before it needs a vendor

The existing SMS adapter was built with this answer in mind:

- Every message goes through one `SmsSender` interface with a `PRIMARY` and a `FALLBACK` route.
- `OtpService` switches to the fallback from the second attempt, when one is configured.
- The only missing piece is `deliver()`, which throws "SMS provider not yet wired" ([sms-provider.service.ts](../apps/backend/src/infrastructure/sms/sms-provider.service.ts); [otp.service.ts](../apps/backend/src/application/features/identity/otp.service.ts)).

The open decision "which two providers" ([open-decisions.md](../docs/open-decisions.md)) resolves to the local aggregator as `PRIMARY` and Twilio as `FALLBACK`. With that mapping, the expensive international route carries only resends, and those are the codes most likely to follow a local-route failure.

**The first job is not the integration; it is closing a hole the integration would open.**

- **Any number gets a code.** `issue()` parses the typed number, checks a per-phone hourly cap, and sends. It never checks that a citizen record holds that number ([otp.service.ts](../apps/backend/src/application/features/identity/otp.service.ts)). A code sent to an unregistered number is pure cost: verification then fails with "no registration with this number" ([identity.service.ts](../apps/backend/src/application/features/identity/identity.service.ts)).
- **The caller picks the route.** The route depends on an `attempt` value from 1 to 6 that the client sends ([auth.schema.ts](../packages/shared-schemas/src/auth.schema.ts)), so a script can go straight to the expensive fallback.
- **The per-IP limit is really a global limit.** The throttler sees nginx's address, not the caller's, because Express has no `trust proxy` setting ([metrics.controller.ts](../apps/backend/src/presentation/controllers/metrics.controller.ts)). The three-requests-a-minute limit on the OTP route ([app.config.ts](../apps/backend/src/presentation/config/app.config.ts)) is therefore one budget shared by everyone. It is the only thing capping abuse, and at busy times it will also turn away real citizens.
- **The per-phone cap leaks.** The hourly cleanup deletes expired codes that the per-phone hourly cap counts ([otp.repository.ts](../apps/backend/src/infrastructure/repositories/otp.repository.ts); [otp-cleanup.job.ts](../apps/backend/src/application/background-jobs/otp-cleanup.job.ts)).
- **The resend wait is not enforced.** Only the client enforces the 30-second wait between resends ([otp.service.ts](../apps/backend/src/application/features/identity/otp.service.ts)).

Once `deliver()` works, a bot can buy about 4,320 sends a day per backend process at the current limit. That is roughly $86 a day on the local route and $1,560 on Twilio. On a prepaid account, draining the balance is also a login outage for every citizen; the local API even has a "No credits" error ([API docs](https://www.bestsmsbulk.com/pro-support/api_documentation_bsb)). Prelude, an OTP vendor, estimates that fraud of this kind, which floods OTP endpoints to earn a share of SMS fees ("SMS pumping"), cost $1.2 billion worldwide in 2025. It adds that "the first sign is typically a billing anomaly" ([Prelude](https://prelude.so/blog/preventing-sms-pumping-fraud)).

The fixes must go in this order:

1. **Send only to numbers on a citizen record.** Send only when a `CITIZEN` record holds the number, and keep the same response either way so the endpoint does not reveal which numbers are registered.
2. **Count attempts on the server.** Derive the attempt count from the phone's recent codes instead of trusting the client.
3. **Only then set `trust proxy`.** Doing it earlier gives an attacker spread across many IPs a separate budget per IP.
4. **Tighten the remaining limits.** Keep code rows for at least an hour before cleanup, enforce the resend wait on the server, add a daily spending cap per route, and alert when sends exceed successful verifications by more than 2:1 ([Prelude](https://prelude.so/blog/preventing-sms-pumping-fraud)).
5. **Restrict both provider accounts to +961** wherever the provider offers country restrictions ([Twilio](https://www.twilio.com/docs/glossary/what-is-sms-pumping-fraud)).

With those locks in place, the integration itself is a set of additive changes:

| Area | Today | Change |
|---|---|---|
| `deliver()` | Throws on every call; outside production, the no-key path logs the unmasked phone and the code ([sms-provider.service.ts](../apps/backend/src/infrastructure/sms/sms-provider.service.ts)) | Two adapters behind `SmsSender`: an HTTP client for the local aggregator as `PRIMARY`, and Twilio as `FALLBACK`. Each returns the provider, message ID and segment count, and logs only the masked phone, since [AGENTS.md](../AGENTS.md) forbids citizen data in logs |
| `env.schema.ts` | One optional key per route, deliberately not required in production ([env.schema.ts](../apps/backend/src/presentation/config/env.schema.ts)) | A key and secret for the local aggregator, and an account SID and token for Twilio. Restore the production requirement in the same change, as the schema's own comment asks. Back it with a check that proves the credentials work, such as a balance call at boot, so the check can fail for the right reason ([AGENTS.md §8.7](../AGENTS.md)) |
| Sender name | Not modelled | A per-municipality setting, stored next to the office's contact and WhatsApp numbers ([schema.prisma](../apps/backend/src/infrastructure/prisma/tenant/schema.prisma)). Each municipality registers its own name with each provider |
| Delivery status | No message log and no delivery-receipt model | An additive tenant migration for an `outbound_messages` table (route, provider message ID, status, attempts), applied before the code that writes to it. A scheduled job polls the local provider for statuses, 500 at a time, walking every municipality the way `OtpCleanupJob` does |
| Notices | No citizen notification feature exists | Queue notices in an outbox, filled after `RecurringBillingJob` or on `fee.issued`, and send them from a scheduled job in daytime batches. Do not send inside the event handler: the event bus is synchronous and tied to the request's municipality on purpose ([app.module.ts](../apps/backend/src/app.module.ts)). The `fee.issued` event carries no per-citizen list ([fees.service.ts](../apps/backend/src/application/features/fees/fees.service.ts)), so the job reads `CitizenPayment` rows and sends once per phone number, because households share phones ([schema.prisma](../apps/backend/src/infrastructure/prisma/tenant/schema.prisma)). A failed delivery gets one retry on the fallback, within the spending cap |
| Phone numbers | OTP accepts Lebanese mobiles only, and the pattern accepts all of 70–79 ([phone-number.vo.ts](../apps/backend/src/domain/value-objects/phone-number.vo.ts)) | Tag each send with its operator using the three-digit number blocks ([Wikipedia](https://en.wikipedia.org/wiki/Telephone_numbers_in_Lebanon)), so dashboards show Alfa and touch delivery separately. Tighten validation to Google's libphonenumber mobile pattern, which excludes 72–75 and 77 ([libphonenumber](https://github.com/google/libphonenumber/blob/master/resources/PhoneNumberMetadata.xml)). Send notices for owners on foreign numbers over the international route or WhatsApp |

**Coverage in the South and the Bekaa is unreliable, and no SMS provider fixes a dead cell.**

- The 2024 war took about 175 touch and 161 Alfa sites out of service ([TIMEP](https://timep.org/2024/12/04/israels-digital-assault-on-lebanon/)).
- In June 2025, parts of Nabatieh district still had no coverage ([SMEX](https://smex.org/telecommunications-in-south-lebanon-has-the-network-recovered-after-the-ceasefire/)).
- The war that began in March 2026 displaced over 1.2 million people ([Wikipedia](https://en.wikipedia.org/wiki/2026_Lebanon_war)). Southern sites ran short of fuel because repair crews could not reach them ([SMEX](https://smex.org/lebanons-telecom-preparedness-falls-short-amid-a-dangerous-escalation-with-israel/)).

The رقم مرجعي login should therefore stay as the way in that does not need SMS. The open question of whether a staff-assisted path is needed ([open-decisions.md](../docs/open-decisions.md)) has a clear answer: yes. Clerks should also see "not delivered" for each citizen instead of assuming every message arrived.

**The pilot is where the provider actually gets chosen, because no provider's claims have been independently checked.** Run it this way:

1. **Buy SIM cards from both operators, spread across number blocks.** For example, Alfa's 031–035, 716–719 and 812–814, and touch's 036–039, 766–769 and 816–818 ([Wikipedia](https://en.wikipedia.org/wiki/Telephone_numbers_in_Lebanon)).
2. **Send the real templates.** Send the actual OTP and notice texts, under the registered sender name, through ProxiReach, Lebanon SMS and Twilio, with Bird as a reserve.
3. **Measure against the handset.** Compare what reached each phone with what each provider's delivery report claimed. Record delay, the sender name shown, how the Arabic displays, and how many segments were billed.

The pass mark is a judgement call, but a route that loses more than a few percent on either operator should not carry login codes. Repeat the pilot whenever the international gateway contracts change; the adapter design keeps switching providers cheap.

## Conclusion

This turned out to be a question about routes more than providers. Choosing among global SMS brands changes the bill by about a third. Choosing a domestic connection over the international gateway changes it roughly tenfold. It also steps around a gateway contract that has already failed Lebanese login codes once and is being re-tendered now. That reverses the usual advice. In most countries a tier-1 verification product is the safe default and a small local aggregator the risky one. In Lebanon in 2026, the international path carries the political and contractual risk, and the local vendor carries the operational risk. Pairing them spreads the two risks, and the code's existing `PRIMARY`/`FALLBACK` split is already the right shape for that pairing.

The most urgent finding is not about vendors. As soon as `deliver()` stops throwing, the OTP endpoint becomes a paid SMS sender that anyone can aim at any Lebanese number, choosing the expensive route. Its only brake is a rate limit that works by accident. Restricting sends to numbers already on a citizen record costs one database query. It removes attacker-chosen destinations and stops strangers from spamming real citizens, and it should ship before the first provider credential is set. The findings also age quickly: Alfa's gateway exclusive ends this year, Meta changes WhatsApp prices every quarter, and the telecom regulator has only just restarted. Treat a pilot measured in autumn 2026 as a snapshot to re-run, not a final verdict.
