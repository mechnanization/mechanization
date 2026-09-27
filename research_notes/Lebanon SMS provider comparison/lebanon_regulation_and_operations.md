# Regulatory, legal and operational context for A2P SMS to Lebanese citizens from a municipal system (2025–2026)

Research date: 2026-09-26. Source-quality legend used below: **[primary]** = statute text, operator or regulator page, provider's own docs; **[press]** = named news or NGO outlet; **[aggregator]** = SMS-vendor marketing or AI-wiki page; treat as a lead, not a fact.

## 1. Who regulates A2P / bulk SMS in Lebanon, and what rules apply (licensing, sender ID, content, opt-out, time of day, Arabic)

### Takeaway
No published Lebanese regulation specific to A2P SMS was found: nothing on sender-ID registration, content, time-of-day windows or opt-out. In practice the rules come from the two state-owned operators' commercial terms and from the exclusive international A2P gateway contracts the operators sign under the Ministry of Telecommunications. The Telecommunications Regulatory Authority (TRA) was dormant for about 13 years. It was revived only in September–October 2025 and has not yet issued SMS rules. The only statutory hooks are in Law 81/2018: labelling of electronic ads, an opt-out for marketing *emails*, and a right to object to processing for commercial promotion. A municipality's transactional notices and OTPs are not marketing.

### Cited Findings
**Regulator status**
- The TRA was created by Law 431/2002 and started operating when its board was named in February 2007. The board lapsed around 2012, leaving the TRA dormant for over 13 years — [Wikipedia: TRA of Lebanon](https://en.wikipedia.org/wiki/Telecommunications_Regulatory_Authority_of_Lebanon) (search-result summary).
- The Council of Ministers approved a new TRA board on 11 September 2025, and the TRA was formally relaunched on 6 October 2025 under chair Jenny Gemayel. Its announced plans cover market organisation, licensing, broadband and fibre, and Starlink. No SMS or A2P rules and no timelines were announced — [The Beiruter](https://www.thebeiruter.com/article/lebanon-revives-its-telecom-regulator-after-13-years-of-silence/253) [press].
- Charles Hage (al-Hajj) has been Minister of Telecommunications since 8 February 2025 — [Wikipedia: Ministry of Telecommunications](https://en.wikipedia.org/wiki/Ministry_of_Telecommunications_(Lebanon)). He founded Mada Communications in the US in 2000 and later moved it to Lebanon — [The961](https://the961.com/charles-hajj-minister-of-telecommunications/) [press]. Mada is an international SMS carrier; for example, Telecom Egypt chose it as preferred partner for international SMS — [Telecom Review Africa](https://www.telecomreviewafrica.com/articles/wholesale-and-capacity/4385-telecom-egypt-partners-with-mada-communications-for-international-sms-services/) [press]. *This is context for the pending A2P re-tender (Q2). No source alleging any conflict or impropriety was found.*

**How A2P is actually governed: operator contracts under the Ministry**
- International A2P into Lebanon has been outsourced by each operator through tenders. Touch's tender opened 22 Dec 2021, and it signed with In Mobiles on 22 May 2023. Alfa's tender opened in Nov 2022, and it signed with VOX Solutions on 7 June 2023. On 16 Jan 2024 the Audit Bureau's Second Chamber found Touch's outsourcing to In Mobiles "unlawful" and a cause of "significant financial losses to the public treasury". Only 4 of 10 interested firms had qualified, and In Mobiles lacked the required 5 years of A2P experience — [SMEX, 15 Feb 2024](https://smex.org/lebanese-telecom-minister-favors-unlawful-bid-for-a2p-services/) [press/NGO].
- On 15 May 2025 Touch (MIC2) published a tender, "International A2P SMS Joint for MIC2 and MIC1", with a 27 May 2025 deadline (PPA notice 5065ppa_lb). No award was listed — [TenderImpulse](https://tenderimpulse.com/government-tenders/lebanon/general-bood-for-the-international-a2p-sms-joint-for-mic2-and-mic1-7957168) [aggregator of official notice].
- As of 19 Feb 2026, the Ministry had proposed "a single terms-of-reference for re-tendering the service in both companies". The document was with the Public Procurement Authority for observations, after roughly three years of delay. The same report calls In Mobiles "unqualified" and says VOX won on "best price" but later reneged — [Kataeb.org, 19 Feb 2026](https://www.kataeb.org/articles/%D8%AE%D8%AF%D9%85%D8%A9-%D8%A7%D9%84%D8%B1%D8%B3%D8%A7%D8%A6%D9%84-%D8%A7%D9%84%D8%B0%D9%83%D9%8A%D8%A9-%D9%81%D9%8A-%D8%A7%D9%84%D8%AE%D9%84%D9%8A%D9%88%D9%8A-%D8%A3%D9%85%D8%A7%D9%85-%D8%AA%D9%84%D8%B2%D9%8A%D9%85-%D8%AC%D8%AF%D9%8A%D8%AF) [press, party-affiliated outlet].
- A Legal Agenda article is headlined "The Ministry of Telecommunications and Touch kill the A2P auction: In Mobiles continues depriving the treasury of funds". According to search snippets, the PPA recommended that Touch run a new auction under the procurement law and that the In Mobiles contract be amended retroactively to Alfa's unit price and annual minimum — [Legal Agenda](https://legal-agenda.com/%D9%88%D8%B2%D8%A7%D8%B1%D8%A9-%D8%A7%D9%84%D8%A7%D8%AA%D8%B5%D8%A7%D9%84%D8%A7%D8%AA-%D9%88%D8%AA%D8%A7%D8%AA%D8%B4-%D8%AA%D9%82%D8%AA%D9%84%D8%A7%D9%86-%D9%85%D8%B2%D8%A7%D9%8A%D8%AF%D8%A9-a2p/) [press/legal NGO]. *The page returned 403, so the article date and body were not read.*

**Local (domestic) bulk SMS offered by the operators**
- Alfa sells a "Bulk SMS" service for "business owners, community groups, marketing agencies or anyone wishing to communicate with a large group of people". It includes "Dynamic Sender ID (allow you to create your own sender IDs)", SMPP, fixed IP and high throughput, and is billed "based on the Bulk SMS traffic / month according to its relative rate". Contact: alfaservice.providerteam@alfamobile.com.lb. No public prices, content rules or sender-name rules are given — [Alfa business SMS page](https://www.alfa.com.lb/en/business/sms-short-code) [primary].
- A local aggregator advertises "Direct connections to Alfa & Touch networks", custom sender IDs up to 11 characters, and "160 English Characters / 70 Arabic Characters" per SMS — [Lebanon SMS](https://www.lebanon-sms.com/) [aggregator].

**Sender ID, content and format rules as international providers state them**
- Twilio's Lebanon rules: alphanumeric sender ID pre-registration is "Not Required", dynamic sender IDs are "Supported", and the sender ID is preserved. A numeric sender ID "would be overwritten with generic alphanumeric sender ID outside the Twilio platform and delivery would be attempted on best effort basis only". Twilio "highly recommends sending messages with alphanumeric sender ID". Two-way SMS: "No". UCS-2 (Arabic) is supported. Twilio's general advice (opt-in, daytime sending, HELP/STOP) is generic, not Lebanese law — [Twilio Lebanon SMS guidelines](https://www.twilio.com/en-us/guidelines/lb/sms) [primary-provider].
- Messente says "Network operators do not require sender name pre-registration". It lists content bans ("No political, religious, unsolicited promotion, or gambling content") and says "Marketing messages require opt-in and opt-out" — [Messente KB](https://support.messente.com/lebanon-sms-regulations) [provider policy].
- **Conflicting claim:** Sent.dm says direct operator integration requires "Lebanese business registration or authorized representative", minimum volumes "often 50,000+ messages/month", sender ID registration, and 3–4 months end to end. It also says senders "must comply with the regulations of Lebanon's TRA", although the TRA was dormant until Sept 2025 — [Sent.dm Lebanon guide](https://www.sent.dm/resources/lb-sms-guidance) [aggregator, low confidence].
- An AWS re:Post thread titled "Sender ID Registration for Lebanon – SMS Delivery Issue" exists but returned 403 — [AWS re:Post](https://repost.aws/questions/QUvy69dPE9QUOvoYM6lJU5-Q/sender-id-registration-for-lebanon-sms-delivery-issue).

**Statutory rules that touch messaging (Law 81/2018, English Official Gazette translation)**
- Art. 32: online promotional ads must be labelled as ads and name the advertiser. "It is forbidden to communicate unsolicited marketing and advertising emails (SPAM) using a real person's name and address, unless that person has consented", except where the address was lawfully obtained "through a previous engagement". Every promotional email must offer a free, permanent opt-out — [Law 81/2018 (SMEX-hosted Gazette translation)](https://smex.org/wp-content/uploads/2018/10/E-transaction-law-Lebanon-Official-Gazette-English.pdf) [primary].
- Art. 92: anyone may object "for legitimate reasons" to processing "including … for the purpose of commercial promotion". This right does not apply where "the data-processing officer is obliged to collect the data under the law" or the person consented — [Law 81/2018](https://smex.org/wp-content/uploads/2018/10/E-transaction-law-Lebanon-Official-Gazette-English.pdf) [primary].

### Inferences
- A licence for the *sender* is not the practical barrier. Neither a Lebanese statute nor an operator page found here requires a municipality to hold a licence to *send* A2P SMS, or to pre-register an alphanumeric sender ID. Twilio and Messente both say pre-registration is not required. What limits the sender is the commercial access route, which Q2 covers.
- The Art. 32 opt-out applies only to marketing email by its wording. Municipal notices and OTPs are transactional, so neither Art. 32 nor the Art. 92 commercial-promotion objection squarely applies. Adding an opt-out for non-essential notices would still be prudent and consistent with provider policies.
- No time-of-day restriction exists in any source found. Daytime sending for notices is provider best practice only.
- Arabic works through UCS-2 on both international (Twilio) and local routes. Because the local aggregator's figure is 70 Arabic characters per SMS, Arabic notices will often run to 2–3 billed segments; see Q2 for the cost effect.
- The revived TRA and the joint A2P re-tender are the two places where binding SMS rules could appear in 2026–2027.

### Gaps
- No Ministry of Telecommunications or TRA decision on bulk-SMS sender IDs, content, time windows or spam was found, in English or Arabic.
- It is unconfirmed whether SMS aggregators need any licence under Law 431/2002. The licensing regime was never implemented while the TRA was dormant.
- No official Alfa or Touch rule on sender-name format, reserved names (for example government names), or registration documents was found. The operators' bulk-SMS contract terms are not public.
- Touch's business bulk-SMS terms were not retrieved.

## 2. Mobile market structure, international A2P termination, SMS firewalls and grey-route blocking

### Takeaway
Alfa (MIC1) and Touch (MIC2) are state-owned and have been run under the Ministry since 2020. Each routes international A2P through an exclusive, tendered gateway partner: Alfa with VOX Solutions (a firewall/monetisation platform), Touch with In Mobiles. The contracted wholesale rates are about €0.075–0.105 per SMS, and global CPaaS retail prices to Lebanon are now about **$0.31–0.36 per segment**. The contracts have been mired in audit findings, unpaid invoices and cancelled tenders. In early 2025 this caused real, widespread failures of international OTP delivery (WhatsApp, X) to both networks. That history, together with grey-route blocking, explains why many international providers fail to deliver to Lebanon.

### Cited Findings
- The management contracts with Orascom (Alfa) and Zain (Touch) expired at the end of 2019, and the government asked both to carry on until it decided what to do. Orascom completed the transfer of MIC1 to the government on 8 Sept 2020, and Zain handed over Touch on 30 Oct 2020 — [Mobile World Live](https://www.mobileworldlive.com/featured-content/top-three/government-takes-control-of-lebanon-operators/); [Wikipedia: Alfa](https://en.wikipedia.org/wiki/Alfa_(Lebanon)); [Developing Telecoms](https://developingtelecoms.com/telecom-business/operator-news/10154-lebanon-government-gets-touch-back.html) [press; details from search summaries].
- L'Orient Today reports that Cabinet formed a committee to study the future of the mobile sector — [L'Orient Today](https://today.lorientlejour.com/article/1480928/cabinet-forms-committee-to-study-future-of-lebanons-mobile-network-sector.html) [press; only the headline was seen, date not read].
- The two operators are said to split about 4.7 million subscribers roughly equally — [Sent.dm](https://www.sent.dm/resources/lb-sms-guidance) [aggregator, unverified].
- On 5 Dec 2023 Alfa announced "a 3-year exclusive" direct-connectivity partnership with VOX Solutions for international A2P SMS and OTP voice. The VOX-360 platform protects against "messaging bypass", flash-call fraud, A2P spam and Artificially Inflated Traffic, and is billed as "A2P SMS monetization". The announcement does not mention Touch — [VOX Solutions press release](https://voxsolutions.co/alfa-selects-vox-solutions-as-its-exclusive-partner-for-international-a2p-sms-and-otp-voice-traffic-gateway-control-and-optimization/) [primary-vendor].
- **Contract economics (SMEX, 6 Feb 2025)** [press/NGO] — [SMEX](https://smex.org/lebanons-telecom-feud-disrupts-sms-verification-system/):
  - VOX: €0.105 per SMS in year 1, with a minimum of 46 million messages a year, projected at €17.9M to Alfa over 3 years.
  - In Mobiles: €0.075 per SMS, with a minimum of 31 million, which would have yielded €7.379M.
  - Alfa had reportedly not been paid by VOX for about a year.
  - Touch's replacement tender was delayed six times and cancelled in Sept 2024, amid disagreement between Touch's board and then-Minister Johnny Corm, who favoured In Mobiles.
  - "Subscribers to both providers couldn't receive SMS verification codes" for "WhatsApp, X (formerly Twitter), and others". One user paid a repair shop $40 for workarounds. The dispute was unresolved at publication.
- SMEX (Feb 2024) reported that Touch's In Mobiles contract meant "an additional amount of more than 10 million euros" in losses compared with the Alfa–VOX terms — [SMEX](https://smex.org/lebanese-telecom-minister-favors-unlawful-bid-for-a2p-services/).
- **Current retail pricing (read 2026-09-26):**
  - Twilio: **$0.3619 per message** to Lebanon for alphanumeric sender IDs and international numbers, "charged per segment", with a note that "additional carrier fees may apply" — [Twilio Lebanon pricing](https://www.twilio.com/en-us/sms/pricing/lb) [primary-provider].
  - Plivo: **Alfa $0.3154**, **MTC Touch $0.3522**, others $0.3354 per SMS — [Plivo Lebanon pricing](https://www.plivo.com/sms/pricing/lb/) [primary-provider].
- Globally, international termination rates are reported to have crossed $0.10 per message for the first time in Q1 2025 as operators deploy SMS firewalls — [Cytech Mobile](https://www.cytechmobile.com/how-sms-firewalls-are-reshaping-a2p-economics/) [industry blog; figure from a search snippet, not verified].

### Inferences
- **Why international providers fail.** Every legitimate international route into Alfa must pass the VOX-360 gateway. Touch routes through In Mobiles or its successor. Cheap "international" routes (grey or SIM-box) are what these firewalls exist to block, so low-cost providers either get filtered or deliver intermittently. When the gateway contracts themselves break down, as in early 2025, even premium providers fail. Numeric sender IDs are rewritten and delivered "best effort" (Twilio), which lowers reliability further.
- **Price multiple.** Wholesale €0.075–0.105 becomes $0.31–0.36 retail through global CPaaS, which is 3–4 times the wholesale rate.
  - At 4,000 single-segment notifications a month that is about $1,260–1,450 a month on notifications alone.
  - Arabic notices over 70 characters bill as 2–3 segments, so realistic costs could be 2–3 times higher, before daily OTPs.
  - Domestic A2P through a local aggregator with direct local binds to Alfa and Touch is not subject to the international termination fee.
- **Contract-expiry risk in 2026.** The Alfa–VOX contract was signed 7 June 2023 (announced Dec 2023) for three years, so it expires or has expired around mid-to-late 2026. The joint re-tender was still at the terms-of-reference stage in Feb 2026. Routing and pricing for international A2P into Lebanon may change or be disrupted in late 2026 to 2027, so any international-route provider choice should be revalidated with live delivery tests.
- For a municipal system, a local aggregator with direct Alfa and Touch binds (or a direct Alfa or Touch bulk-SMS contract) avoids the international-gateway politics. It does bring local-vendor, payment and procurement considerations (Q4, Q5).

### Gaps
- It is not known whether Touch has deployed an SMS firewall comparable to VOX-360, or who operates Touch's international A2P gateway in Sept 2026. The Legal Agenda headline suggests In Mobiles was still operating it.
- The outcome of the May 2025 joint tender and the Feb 2026 unified terms of reference is unknown, as is the status of the Alfa–VOX contract in Sept 2026.
- No historical Twilio or Plivo price series for Lebanon could be retrieved (the Wayback Machine was inaccessible), so the size of the price rise since 2023 is unquantified.
- Local domestic A2P rates charged by Alfa, Touch or local aggregators were not found publicly. One aggregator summary claimed "from $0.02/SMS", which is unverified.

## 3. Law No. 81/2018 on Electronic Transactions and Personal Data: processing, cross-border transfer, foreign processors, obligations of a municipality

### Takeaway
Law 81/2018 is a light, declaration-based regime overseen by the Ministry of Economy and Trade (MoET). There is no independent data-protection authority and no administrative enforcement. It **contains no cross-border transfer restriction**. It only requires that a transfer "to another State" be *declared*, and public authorities acting within their remit appear to be exempt from declaring. A municipality sending phone numbers and message text to a foreign SMS API is therefore not prohibited. It is still bound by purpose limitation, information duties, security, and a criminal offence for *negligent disclosure to unauthorised persons*. That offence is the one that matters for a system holding refugee and residency status and national ID numbers.

### Cited Findings
All article quotes below are from the unofficial English Official Gazette translation — [Law 81/2018 (SMEX-hosted)](https://smex.org/wp-content/uploads/2018/10/E-transaction-law-Lebanon-Official-Gazette-English.pdf) [primary].

**Definitions (Art. 1)**
- "Personal Data Processor: The natural or legal person responsible for setting the processing objectives and methods." This is effectively the GDPR "controller"; the law has no separate "processor" concept.
- "Personal Data Recipient: the person authorized to receive the personal data … The public authorities which have a legal mandate to request personal data are not considered as personal data recipients."

**Processing principles (Arts 85–93)**
- Art. 85: the section covers "all automatic and non-automatic processing", and its protections cannot be contracted away.
- Art. 87: data must be "collected faithfully and for legitimate, specific and explicit purposes", adequate, not excessive, and accurate. It may not be reused for incompatible purposes.
- Art. 88: at collection, the controller must tell data subjects its identity, the purposes, whether answers are mandatory, the consequences of not answering, **"Persons to whom the data is to be sent"**, and their access and correction rights. Collection forms must state this explicitly.
- Art. 90: retention is legitimate only for the period stated in the declaration or authorisation.
- Art. 91: health, genetic identity and sexual life are prohibited categories, with exceptions.
- Art. 93: the controller "shall take all measures, in light of the nature of the data and the risks resulting from processing thereof, in order to ensure the integrity and security of the data and to protect the same against being distorted, damaged or accessed by unauthorized persons."

**Declaration, licensing and transparency (Arts 94–98)**
- Art. 94 exempts from any permit or licence, among others: (1) "processing by the common rights officials, each as per his/her jurisdiction". The translation is awkward. DLA Piper renders it as processing by "public authorities, within their prerogatives" — [DLA Piper](https://www.dlapiperdataprotection.com/?t=law&c=LB). Art. 94(7) also exempts processing where "the person concerned agrees in advance".
- Arts 95–96: non-exempt controllers must declare to MoET. The declaration lists, among other things, "Subcontractor, if any" (item 10), "Where appropriate, transfer of personal data to another State in any form" (item 12), and a representative if the controller is outside Lebanon (item 7).
- Art. 97: a *licence* is required only for processing about (1) "External and internal security of the State" (joint decision of the Defence and Interior ministers), (2) penal offences and judicial proceedings (Justice), and (3) health, genetic identity or sexual life (Public Health). If no decision is made within 2 months, the application is deemed denied.
- Art. 98: MoET must publish the list of declared processing, including "personal data intended for transfer to a foreign State".

**Data-subject rights (Arts 99–103)**
- Arts 99–101: access, a copy, and correction or erasure "free of charge within ten (10) days"; recipients must be notified of corrections.
- Art. 103: data subjects need not be informed where state security would be endangered.

**Penalties (Arts 106–107)**
- Art. 106: a fine of LBP 1M–30M and/or imprisonment of 3 months to 3 years for (a) processing without a permit or licence, (b) collecting or processing "without complying with the rules" of Section II (Arts 87–93), or (c) "Anyone who, even if negligently, discloses personal data under processing to unauthorized persons".
- Art. 107: a fine of LBP 1M for failing to answer access or correction requests.

**Secondary sources**
- DLA Piper: "The Law is silent on cross-border data transfers". The regulator is MoET, with "no independent data protection authority". There is "No administrative enforcement"; data subjects go to the Judge of Urgent Matters — [DLA Piper](https://www.dlapiperdataprotection.com/?t=law&c=LB) [law-firm guide].
- **Contradiction:** Clym and ConsentStack claim that transfers need adequacy, safeguards or consent and "PDPC licensing". No such article or authority appears in the statute text above, and DLA Piper contradicts them — [Clym](https://www.clym.io/regulations/law-no-81-on-electronic-transactions-and-personal-data-lebanon) [aggregator, unreliable on this point].
- Morrison Foerster's privacy library lists only Law 81 and 2005-era drafts. No current reform bill was found — [MoFo](https://www.mofo.com/privacy-library/lebanon).
- The official BDL exchange rate has been about 89,500 LBP per USD since 2024 — [Wikipedia: Lebanese pound](https://en.wikipedia.org/wiki/Lebanese_pound).

### Inferences
- **Foreign SMS processors are legal, with duties.** Nothing in Law 81 bars sending phone numbers and message content to a US or EU SMS API. For a municipality:
  - It is probably exempt from MoET declaration under Art. 94(1).
  - It must still tell citizens at collection that their number will be sent to an SMS provider (Art. 88(5)).
  - It must pick a provider with adequate security (Art. 93).
  - It must not put data in the SMS body that would amount to disclosure to an unauthorised person (Art. 106).
- **Content minimisation is the main legal lever.** Carriers, gateway operators, firewall vendors such as VOX, and anyone holding the handset can all see SMS text. National ID numbers, residency or refugee status, and household details should never appear in message bodies. OTPs and "your application X has a new update, log in to view" style notices are low-risk.
- **Refugee and residency status is not a listed Art. 97 licensed category** unless it is characterised as "internal security of the State". Its sensitivity is still very high. The negligent-disclosure offence in Art. 106 is the provision a leak would engage.
- **The penalties have lost their bite, the liability has not.** Art. 106's maximum fine of LBP 30M is about $335 at 89,500 LBP/USD, so the fines are symbolic. The prison term (3 months to 3 years) and the reputational and civil exposure remain real.

### Gaps
- The Arabic original of Art. 94(1) was not checked. "common rights officials" is probably a translation of "public-law persons", but this is unconfirmed.
- No evidence was found on whether any municipality has filed a MoET declaration, or whether MoET has issued implementing decisions or templates.
- No 2025–2026 draft data-protection law or independent authority proposal was found.
- Not researched, and out of scope: whether hosting on AWS in Paris brings EU GDPR processor obligations to the hosting provider or the SMS vendor.

## 4. Payment practicalities: can a Lebanese company or municipality pay international SaaS, and how are local providers paid?

### Takeaway
Since 2019, Lebanese cards backed by pre-crisis ("lollar") deposits have been restricted or stripped of online use. International online payment works with **"fresh USD" cards**, meaning cards funded with new dollars. These include bank fresh-USD cards, some of which are offered to registered companies, and prepaid cards from OMT and Whish. No evidence was found that Twilio, Vonage or Infobip refuse Lebanese customers. However, Lebanon has been on the **FATF grey list since Oct 2024** and on the **EU high-risk third-country list since mid-2025**. EU-regulated financial intermediaries must therefore apply enhanced due diligence, which can add friction to onboarding and payments. For a *municipality*, the harder problem is public-accounting compatibility, not card acceptance.

### Cited Findings
- As early as July 2020, some Lebanese banks removed online capability from cards or cancelled them. Banks began offering internet cards that require "fresh money", which customers had to "buy … from the market at the blazing exchange rates" to fund — [The961, 3 Jul 2020](https://www.the961.com/netflix-credit-cards-online-payments-lebanon/) [press].
- Byblos Bank's "Visa Platinum Fresh USD Card" is offered to individuals and "fully registered companies". Its limits are USD 5,000 a day and USD 25,000 a week, with a $2 monthly fee. The page does not say explicitly whether e-commerce use is allowed — [Byblos Bank](https://www.byblosbank.com/personal/cards/debit/visa-fresh) [primary].
- OMT offers a prepaid, reloadable dual-currency (USD/LBP) Visa card. According to the search snippet, "The fresh USD balance allows you to make online purchases, shop abroad, or withdraw cash from any international ATM" — [OMT news](https://www.omt.com.lb/en/news/meet-omts-prepaid-and-reloadable-dual-currency-card) [primary; the product page returned HTTP 500, so limits and eligibility were not read].
- Whish Money offers a free digital Visa card for online payments — [Whish Money App Store listing](https://apps.apple.com/app/id1284243483) [primary].
- Capital controls on pre-2019 deposits persist. BDL circulars raised the monthly fresh-dollar withdrawal limits from blocked accounts from $800 to $1,000 and from $400 to $500 — [L'Orient Today](https://today.lorientlejour.com/article/1486638/bdl-raises-withdrawal-limits-on-blocked-deposits-adds-safeguard.html) [press].
- Lebanon was placed under FATF "increased monitoring" (the grey list) in October 2024 — [FATF: Lebanon](https://www.fatf-gafi.org/en/countries/detail/Lebanon.html) [primary].
- On 10 June 2025 the European Commission updated its high-risk third-country list, adding Lebanon — [European Commission](https://finance.ec.europa.eu/news/commission-updates-list-high-risk-countries-strengthen-international-fight-against-financial-crime-2025-06-10_en) [primary]. EU obliged entities must apply enhanced due diligence to transactions involving Lebanon — [Fincrime Central](https://fincrimecentral.com/lebanon-eu-high-risk-countries-aml-cft/) [secondary]. Civil-society funding flows were reported to be affected — [Hivos EU SEE](https://eusee.hivos.org/alert/civil-society-funding-affected-as-lebanon-responds-to-eu-high-risk-listing/) [NGO].
- Twilio publishes Lebanon as an ordinary destination with standard guidelines and pricing. No Twilio page restricting Lebanese account holders was found — [Twilio Lebanon guidelines](https://www.twilio.com/en-us/guidelines/lb/sms) [primary-provider].
- A search summary said OMT debit cards cannot be linked to Stripe, citing a Shopify community thread — [Shopify community](https://community.shopify.com/t/what-payment-methods-can-i-use-for-my-store-in-lebanon/292169) [forum; unverified].

### Inferences
- **For an international CPaaS, the realistic payment instrument** is a fresh-USD corporate card from a Lebanese bank, or a card or entity held abroad. Prepaid consumer cards (OMT, Whish) may work for small top-ups, but they are personal products. They are a poor fit for a public body's audited spending.
- EU-headquartered or EU-regulated providers and payment processors may request more KYC for a Lebanon-registered customer since the mid-2025 EU listing. Examples are Infobip (Croatia) and Sinch (Sweden). Onboarding delays or refusals are plausible but not documented.
- Lebanon is not under comprehensive US sanctions; US measures target specific Hezbollah-linked persons. That background was not re-verified in this research. The practical risk is KYC or AML friction, not a legal prohibition.
- **For local providers**, payment in cash USD, bank transfer or local wallets is usual in the Lebanese market. For a municipality this matters because the Procurement Law's "shopping by invoice" method (Q5) needs invoices, and a local vendor can issue Lebanese tax invoices.
- An alternative is for the software vendor (the team) to buy SMS and bill municipalities as part of its service. That moves card or KYC friction to the vendor and changes the procurement question (Q5).

### Gaps
- No provider statement was found confirming or denying that Twilio, Vonage or Infobip onboard Lebanon-registered entities, and no Lebanon-specific KYC document list was found.
- No r/lebanon threads were retrieved; the search tool did not surface them.
- It is unknown whether Lebanese municipalities can hold fresh-USD accounts or cards, or pay foreign vendors in foreign currency from municipal funds, which are largely LBP. No source was found. A search summary suggested municipal fee revenues had collapsed (for example "$5,000 by 2023, down from $200,000 in 2019"), but the source could not be verified.
- Current limits and eligibility for the OMT and Whish cards, including business use, were not read.

## 5. Public procurement: does a municipality need a tender to buy SMS services under Law 244/2021?

### Takeaway
Yes, Law 244/2021 applies to municipalities and federations of municipalities. Open tender is the default. Below **LBP 1.5 billion** (about **$16,760** at 89,500 LBP/USD), a municipality may use "shopping / procurement by invoice". That requires quotations from at least two suppliers, with the lowest compliant price winning. Below **LBP 15 billion** (about $167,600), it may use a request for quotations. Splitting a purchase to reach a lower threshold is prohibited. The thresholds are fixed in LBP and are adjustable only by PPA recommendation plus a Council of Ministers decree; no amendment was found. Direct contracting with another *public-law entity* is a listed exception.

### Cited Findings
All article quotes below are from the IOF unofficial translation, Dec 2024 — [Public Procurement Law 244/2021 (IOF)](https://institutdesfinances.gov.lb/sites/default/files/2024-12/PP%20Law-unofficial%20translation-dec24-en_1.pdf) [primary, unofficial translation].

**Scope and default method**
- The definition of "Procuring entity" includes "The State and the administrations and public institutions thereof … **municipalities and federations of municipalities** … companies where controlling stakes are owned by the State and working in a monopoly environment … and any common law persons spending public funds."
- Art. 42: "Public procurement shall essentially be conducted by means of open tender."

**Thresholds and methods**
- Art. 47, shopping or procurement by invoice: allowed "if the estimated value of the procurement project, including the consulting services, does not exceed (1.5) billion Lebanese pounds". The value is modifiable by PPA recommendation and a Council of Ministers decree.
- Art. 60: the entity "shall request quotations from as many suppliers and contractors as practicable, but from at least two". Each bidder gives one quotation, and there is "No negotiations". "The invoice may also be sufficient when it is not possible to obtain two offers."
- Art. 61: the winner is "the lowest-priced quotation meeting the needs".
- Art. 44, request for quotations: allowed where the estimated value does "not exceed fifteen billion Lebanese pounds" (also modifiable).
- Art. 11: the procurement-planning rules apply to projects over LBP 10 billion. Annual procurement plans are consolidated and published on the PPA central electronic platform.
- Art. 34(2): a performance guarantee is not mandatory under LBP 5 billion.

**Anti-splitting and direct contracting**
- Lots: "Procurement shall not be divided into lots in order to apply specific provisions to each."
- Art. 46 allows direct contracting only in "exceptional circumstances". These include (1) a sole supplier or exclusive rights with "no reasonable alternative", (2) emergency after an "unexpected catastrophic event", and (5) "When contracting public law entities such as public institutions, municipalities or international organizations."
- Art. 62: for direct contracting, the entity must notify the PPA and publish a notice on the PPA central electronic platform "at least (10) ten days prior" to concluding the contract. This does not apply to the emergency and confidential cases.

**Timeline, rate and later guidance**
- The law was published in the Official Gazette on 29 July 2021 and came into force in July 2022 — [LCPS](https://www.lcps-lebanon.org/en/articles/details/3629/transforming-public-procurement-lebanon%E2%80%99s-path-to-efficiency-social-value-and-transparency); [PPA presentation](https://lp.gov.lb/backoffice/uploads/files/Presentation%20-%20Public%20Procurement%20Law%20in%20Lebanon%20-%20Aug2021%20-%20English.pdf) [secondary / primary; dates from search summaries].
- The official exchange rate is about 89,500 LBP/USD — [Wikipedia: Lebanese pound](https://en.wikipedia.org/wiki/Lebanese_pound).
- The IOF published an "Emergency Procurement" guidance note (V3, Oct 2025) — [IOF](https://www.institutdesfinances.gov.lb/sites/default/files/2026-02/Emergency%20Procurement-Guidance%20Note-V3-Oct25-En_0.pdf) [primary; title only, not read].
- LCPS has examined whether municipalities are ready for e-procurement — [LCPS](https://www.lcps-lebanon.org/en/articles/details/4754/what-is-public-e-procurement-and-are-municipalities-ready-for-it) [think tank; title only].

### Inferences
- **Threshold arithmetic at 89,500 LBP/USD.** LBP 1.5bn ≈ $16,760, LBP 15bn ≈ $167,600 and LBP 10bn ≈ $111,700. Because the thresholds are in LBP and were set in 2021, devaluation has made the "by invoice" ceiling much lower in real terms than intended.
- **Estimated annual spend** (48,000 notifications a year plus OTPs):
  - Local domestic route at a few US cents per segment: roughly $1k–5k a year. This sits comfortably within "shopping by invoice", which needs two quotations.
  - International CPaaS at $0.32–0.36 per segment with multi-segment Arabic: roughly $30k–50k+ a year. This would exceed LBP 1.5bn and require a request for quotations under Art. 44 or an open tender. A multi-year contract value would count in full.
- **Who procures matters.** In a multi-municipality system, each municipality (or a federation of municipalities) is its own procuring entity. If the software vendor buys SMS centrally and bills it as part of a service contract, the tender question moves to the municipality–vendor contract and away from SMS itself.
- **Direct contracting with Alfa or Touch is unclear.** MIC1 and MIC2 are state-owned S.A.L. companies, so they are procuring entities under the law. Whether they count as "public law entities" for the Art. 46(5) exception is doubtful, since they are commercial companies. This needs legal advice before relying on it.

### Gaps
- It is unconfirmed whether a decree has revised the Art. 44 or Art. 47 thresholds since 2021 to account for devaluation. No amendment was found in searches.
- No PPA guidance was found on municipal purchases of SaaS or telecom services, or on how to estimate the value of usage-based (per-message) contracts.
- The Arabic official text was not checked. Article numbering follows the unofficial IOF translation.
- The legal status of Alfa and Touch for Art. 46(5), and whether Ogero (a public institution) offers any SMS service, are unresearched.

## 6. Infrastructure reliability: war damage, fuel and power outages, and the 2025–2026 state of mobile networks in the South and Bekaa

### Takeaway
Mobile service in South Lebanon, the Bekaa (especially Baalbek-Hermel) and Beirut's southern suburbs has been repeatedly degraded:
- **2021–2022:** diesel shortages shut down sites.
- **Sept–Nov 2024 war:** about 110–175 sites per operator went out of service, with about $67M in damage.
- **2025:** partial recovery to about 80–90%, with border villages still dark by mid-2025.
- **March–April 2026:** a new war brought over 1.2 million displaced, Israeli ground operations up to the Litani, and fuel supply to southern sites cut. A fragile ceasefire has held since 16 April 2026, and Israel began handing back buffer-zone sections in July 2026.

Deliverability to citizens of southern and Bekaa municipalities must be treated as intermittent.

### Cited Findings
**2021–2022: fuel and power**
- In 2022 the mobile network was "largely disrupted by power outages due to the shortage of diesel necessary to run standby generators". Outages were frequent in "border areas in the Bekaa and North Lebanon" and hit Alfa, Touch and Ogero — [SMEX: Mapping telecom outages](https://smex.org/mapping-the-telecom-outages-in-lebanon/) [NGO; search-snippet].
- In Sept 2022, Alfa internet suffered a "forced outage" after Ogero's Sin el-Fil central station ran out of fuel. Alfa's and Touch's fibre runs through that station — [L'Orient Today](https://today.lorientlejour.com/article/1310592/alfa-internet-services-outage.html) [press; search-snippet].

**2024 war**
- By early Oct 2024, about 113–114 sites per operator were out of service. L'Orient's headline reads "26 Ogero, 114 Touch and 113 Alfa stations out of service". Other reporting gives Touch 113 (61 for security reasons, 15 from theft) and Alfa 114, so the two sources assign the counts to the operators the other way round — [L'Orient Today](https://today.lorientlejour.com/article/1429878/26-ogero-114-touch-and-113-alfa-stations-out-of-service.html); [TIMEP](https://timep.org/2024/12/04/israels-digital-assault-on-lebanon/) [press/think tank].
- Later figures: 175 Touch sites out (9 destroyed, 11 partially damaged) and 161 Alfa sites out, "all situated south of Beirut, southern Lebanon, and Beqaa". Damage reached about $67M by 24 Oct 2024. A Touch technician was killed in a strike on a tower at Tayr Harfa — [TIMEP](https://timep.org/2024/12/04/israels-digital-assault-on-lebanon/) [think tank; via search summary].

**2025: recovery**
- As of 3 June 2025: Ogero had 71 of 82 centres back. Alfa and Touch were at 80–90% capacity. There was no coverage in parts of Nabatieh district and Iqlim al-Tuffah: Arabsalim, Baysariyeh, Jibsheet, Jbaa, Kawthariyat al-Siyad, al-Duwair, al-Sharqiyyeh and al-Ghassaniyeh. "Dozens of network stations remain out of service" because of security risks — [SMEX](https://smex.org/telecommunications-in-south-lebanon-has-the-network-recovered-after-the-ceasefire/) [NGO].
- Search summaries of contemporaneous coverage give Alfa 86 of 109 sites repaired (80%) and Touch 166 of 184 (90%), with 23 Alfa, 18 Touch and 11 Ogero sites still out — [L'Orient Today](https://today.lorientlejour.com/article/1458161/network-coverage-restored-80-in-south-lebanon.html); [This is Beirut](https://thisisbeirut.com.lb/articles/1314211/telecom-coverage-restored-in-80-of-south-lebanon) [press; figures from search summaries].
- Alfa reported on 28 June 2025:
  - South: 80 of 107 partially damaged sites restored, 23 destroyed sites under reconstruction, 3 temporary sites deployed.
  - Baalbek-Hermel: 7 restored.
  - Dahieh: 23 restored.
  - "33% of the network (444 stations) is equipped with solar power" — [Alfa press release](https://www.alfa.com.lb/en/media-center/press-releases/clarification-by-alfa-we-are-close-to-the-completion-of-the-largest-restoration-project-of-our-mobile-sites-damaged-by-the-war) [primary].

**2026 war**
- The war began 2 March 2026, after US–Israeli strikes on Iran on 28 Feb 2026. Israeli ground operations began 16 March, Litani bridges were destroyed, evacuation orders were issued for the whole area south of the Litani, and over 1.2 million people were displaced — [Wikipedia: 2026 Lebanon war](https://en.wikipedia.org/wiki/2026_Lebanon_war) [encyclopedia on a fast-moving event; verify].
- Ceasefire timeline: a temporary ceasefire from 16 April 2026, extended several times, then agreements on 3 June and 15–19 June. Israel began handing over buffer-zone sections on 20 July 2026, but the situation remains "fragile" — [Wikipedia: 2026 Lebanon war](https://en.wikipedia.org/wiki/2026_Lebanon_war).
- The Soufan Center described "Conflict Grinds on in Lebanon Despite a 'Ceasefire'" (22 May 2026) — [Soufan Center](https://thesoufancenter.org/intelbrief-2026-may-22/) [think tank; title only].
- On 8 April 2026 Israel struck more than 100 targets (Beirut, Sidon, Tyre, Bekaa), killing 357 — [Wikipedia: 8 April 2026 attacks](https://en.wikipedia.org/wiki/8_April_2026_Israeli_attacks_on_Lebanon).
- SMEX (19 Mar 2026) on the 2026 fighting:
  - "No direct targeting of transmission stations" had been reported in the South at that point.
  - Southern stations were "beginning to run out of fuel, as technical teams were unable to reach them", and diesel supply was being coordinated with the army.
  - Touch said the network was "in a better condition compared to the previous war".
  - SMEX says national roaming and SMS emergency alerts were **not** implemented — [SMEX](https://smex.org/lebanons-telecom-preparedness-falls-short-amid-a-dangerous-escalation-with-israel/) [NGO].
- **Contradiction:** the same day, The Beiruter reported that "Data National Roaming" was automatically activated across 110 stations (34 Alfa, 76 Touch). About 93,000 Touch users used Alfa's network and 58,000 Alfa users used Touch's. The Beiruter also said Touch had restored about 90% of services post-ceasefire and was prioritising diesel for generators — [The Beiruter](https://www.thebeiruter.com/article/telecommunications-sector-under-threat-again/1330) [press]. The two reports may be describing different things (data-only roaming versus full national roaming).

### Inferences
- **Deliverability by region.** Municipalities in Nabatieh, Tyre and Bint Jbeil districts, border villages, and Baalbek-Hermel should expect periods of no delivery. Messages sent while a handset is unreachable depend on the SMS validity period and retry policy. The system should record delivery receipts, retry within a sensible validity window, and show the citizen or clerk an "undelivered" status rather than assuming success.
- **Displacement does not break SMS.** Mobile numbers are not tied to location, so displaced residents usually still receive SMS wherever they are. The risk is to people who stayed in areas with damaged or unfuelled sites.
- **Daily login OTPs cannot be the only way in.** A citizen in a dead zone would be locked out, so an assisted or alternative login path (staff-verified at the municipality, or a longer-lived credential) is warranted. A second route to both operators, such as two aggregators, reduces single-gateway failure.
- **Weak networks still carry SMS.** SMS is more robust than data on congested or degraded networks, so SMS remains preferable to app push or WhatsApp in the worst-affected areas.

### Gaps
- No Sept 2026 figures were found for sites still out of service after the 2026 war, nor whether sites were directly destroyed in 2026.
- No Bekaa-specific 2026 network data was found.
- No SMS delivery-rate statistics per region were found.

## 7. Number formats: mobile prefixes, Alfa versus Touch allocation, and mobile number portability

### Takeaway
Lebanese mobile numbers have two shapes:
- **03 numbers** have a 7-digit national significant number: +961 3 XXXXXX, written nationally as 03 XXX XXX.
- **70, 71, 76, 78, 79 and 81 numbers** have 8 digits: +961 7X XXX XXX, written nationally as 71 XXX XXX with no trunk 0.

Operator allocation is by sub-block, not by two-digit prefix; both operators hold parts of 03, 70, 71, 76, 79 and 81. Mobile number portability does not appear to be implemented. Only low-grade sources say so explicitly, but no launch or regulation was found.

### Cited Findings
**Number patterns (Google libphonenumber metadata, territory LB)** — [libphonenumber PhoneNumberMetadata.xml](https://github.com/google/libphonenumber/blob/master/resources/PhoneNumberMetadata.xml) [primary-reference, widely used for validation]
- Mobile `nationalNumberPattern`: `(?:(?:3|81)\d|7(?:[01]\d|6[013-9]|8[7-9]|9[0-4]))\d{5}`.
- Possible national lengths are 7 and 8. The example number is 71123456.
- The file's own comment: "We only validate the first three digits here, since the ranges are growing rapidly. The 79[02-9] prefixes were added from bug reports and numbers found online."
- Fixed-line patterns overlap with the same leading digits but at 7-digit length: `7(?:62|8[0-6]|9[04-9])\d{4}` (South region, 07) and `8[02-9]\d{5}` (Bekaa, 08).
- The national prefix is "0". The formatting rule prepends 0 only to single-digit-led numbers such as 3, giving "03 123 456", and not to two-digit mobile prefixes, giving "71 123 456".

**Sub-block allocation (Wikipedia list; the page itself contains typos such as "MIC2 (to)")** — [Wikipedia: Telephone numbers in Lebanon](https://en.wikipedia.org/wiki/Telephone_numbers_in_Lebanon) [encyclopedia]

| Prefix | Touch (MIC2) | Alfa (MIC1) |
|---|---|---|
| 03 | 030, 036–039 | 031–035 |
| 70 | 700, 706–709 | 701–705 |
| 71 | 711–715 | 710, 716–719 |
| 76 | 760, 766–769 | 761, 763–765 |
| 78 | 787–789 | — |
| 79 | 790 | 791–793 |
| 81 | 816–818 | 812–814 |

**Mobile number portability**
- Sent.dm says "as of 2025 Lebanon is not yet implementing mobile number portability, so prefixes are generally a reliable clue for the issuing network" — [Sent.dm numbering guide](https://www.sent.dm/en/resources/phone-number-standards/lb) [aggregator].
- Grokipedia says "no full MNP" with "discussions on limited portability ongoing" — [Grokipedia](https://grokipedia.com/page/Telephone_numbers_in_Lebanon) [AI-generated wiki, low confidence].
- The revived TRA's announced agenda (Oct 2025) did not mention MNP — [The Beiruter](https://www.thebeiruter.com/article/lebanon-revives-its-telecom-regulator-after-13-years-of-silence/253).
- **Conflicting or unverified claims:**
  - Sent.dm states that Alfa uses "03, 70, 71" and Touch "76, 78, 79", which contradicts the sub-block allocation above.
  - Sent.dm also states that "76, 78, 79, and 81 were added in May 2025 per ITU", with 79 "allocated in September 2025". This is unverified and conflicts with these prefixes already being in libphonenumber's mobile pattern.

### Inferences
- **Validation and normalisation.** Validate against the libphonenumber pattern, or use the library directly, and store E.164 (+9613XXXXXX or +9617XXXXXXX / +96181XXXXXX). Lebanese users often write "03/123456", "71-123456" or "0096171…". A 7-digit number starting 7 or 8, such as "07 62xxxx" or "08 xxxxxx", is a South or Bekaa *landline*, not a mobile. This matters for municipal data entry in exactly those regions.
- **Operator routing.** Identifying the operator needs 3-digit sub-block lookup, which will drift as new blocks open. It only matters when using per-operator direct binds or reading per-operator pricing such as Plivo's Alfa/Touch split. With no MNP, the prefix-derived operator is currently reliable.
- New ranges keep being added (79x, 81x), so a hard-coded prefix whitelist will go stale. Prefer the library's pattern plus periodic updates.

### Gaps
- No official Ministry, TRA or ITU numbering-plan document was retrieved to confirm the sub-block allocations and their dates.
- No authoritative (regulator or operator) statement on MNP status was found.
- The allocation of 794 and of the 78 blocks below 787 is unknown. libphonenumber treats 794 as mobile, while Wikipedia lists no operator for it.
