# Local Lebanese SMS providers/aggregators and direct Alfa/Touch A2P offerings (researched 2026-09-26)

Scope note: this covers Lebanon-based companies and the two operators (Alfa = MIC1, Touch = MIC2). International platforms that only publish a "Lebanon" landing page (SMS.to, EasySendSMS, Releans, BudgetSMS, D7, BulkSMS.com, ExpertTexting, Messaggio, Unimatrix) are mentioned only where they make claims about Alfa/Touch routes; they are not profiled. About 30 searches and fetches. Several operator and regulator pages were unreachable (403/404). Where that happened it is noted below.

## Q1. Which Lebanese companies sell bulk/transactional SMS with an HTTP API?

### Takeaway
Four Lebanon-based sellers turned up and could be checked. Only two are credible for a backend integration: **Lebanon SMS** (lebanon-sms.com, Fanar) and **ProxiReach S.A.R.L.**, which sells under two brands, proxireach.com and **BestSmsBulk.com**. ProxiReach is the only local provider found with **public API documentation** and a **public price** (from $0.02/SMS). Both claim direct Alfa and Touch routes. Neither names any government, municipal or bank client. No provider publishes payment methods, sender-ID lead times or DLR webhook specs.

### Cited Findings

**Summary table (verified on provider sites unless marked)**

| Provider | Location / contact | Alfa+Touch direct? | API | Public docs | Public price | Named clients |
|---|---|---|---|---|---|---|
| Lebanon SMS (lebanon-sms.com) | Fanar, Mount Lebanon; +961 3 572 478 | Claimed: "Direct routes to Alfa and Touch networks" | REST + SMPP (claimed) | None found | No: quote only | None ("500+ Happy Clients") |
| ProxiReach S.A.R.L. / BestSmsBulk.com | Beirut; +961 76 515481 (ProxiReach), +961 3 645875 (BestSmsBulk) | Claimed: "Direct telecom connections"; routes "Touch, Alfa, and international" | REST (HTTP GET/POST + JSON) | **Yes**, public | "Lebanon starts at $0.02/SMS" | None |
| Asmar Pro (asmarpro.com) | Hadat (Baabda), Bassil Center; +961 70 967050 | Not stated | "SMS Gateway API" mentioned | None found | No: quote only | Wooden Bakery, Hopital Libanais Geitaoui, Dalbani, Kama Plast, others |
| GlobeSMS (globesms.net) | Lebanon (no address found) | Not stated | Not described | None | No | None; possibly stale (latest news Feb 2021) |

**Lebanon SMS (lebanon-sms.com)**
- Address "Fanar, Mount Lebanon, Lebanon", phone "+961 3 572 478" — [Lebanon SMS](https://www.lebanon-sms.com/)
- Claims "Direct routes to Alfa and Touch networks ensure your messages are delivered within seconds" and a "99.9% delivery rate" — [Lebanon SMS](https://www.lebanon-sms.com/)
- Integration: "REST API and SMPP connections". No public documentation link was found on the homepage — [Lebanon SMS](https://www.lebanon-sms.com/)
- Custom sender ID: "Request your custom sender ID (up to 11 characters)". No timeline is given — [Lebanon SMS](https://www.lebanon-sms.com/)
- Languages: "Send messages in English, French, Arabic, and more". The site describes segments as "160 English Characters" and "70 Arabic Characters", but shows no per-SMS price or currency — [Lebanon SMS](https://www.lebanon-sms.com/)
- Use cases: "promotions, alerts, and OTP verification". Offers "Real-Time Analytics" on delivery rates — [Lebanon SMS](https://www.lebanon-sms.com/)
- "Est. 2009", "15+ Years in Business", founders described as "Telecommunications and Computer engineers". Hours Mon–Fri 8:00–18:00, with "24/7 Support Available" claimed. The legal entity name is not stated — [Lebanon SMS About](https://www.lebanon-sms.com/about)
- Clients: only the generic claim "500+ Happy Clients" / "500+ businesses in Lebanon". None are named — [Lebanon SMS About](https://www.lebanon-sms.com/about)
- The same company also sells SEO, web development, email marketing and a "Business Intelligence Platform", so SMS is one line of a broader agency business — [Lebanon SMS About (search summary)](https://www.lebanon-sms.com/about)
- The footer reads "© 2026 Lebanon SMS", which is consistent with a site maintained in the current year — [Lebanon SMS](https://www.lebanon-sms.com/)

**ProxiReach S.A.R.L. (proxireach.com) = BestSmsBulk.com**
- BestSmsBulk is "by PROXIREACH S.A.R.L." / "Operated by PROXIREACH S.A.R.L.". These are **one company with two brands**, not two independent providers — [BestSmsBulk Lebanon](https://www.bestsmsbulk.com/sms/countries/lebanon); [BestSmsBulk home](https://www.bestsmsbulk.com/)
- ProxiReach: "Beirut, Lebanon", "+961 76 515481", copyright "© 2009 -", calls itself "Lebanon's #1 messaging platform" for SMS, WhatsApp API and OTP. Claims "Direct telecom connections" but does not name Alfa or Touch on that page. Offers "RESTful API with SDKs for PHP, Python, Node.js", "Real-time delivery reports", "OTP & Verification" with "Auto-retry on failure" — [ProxiReach](https://www.proxireach.com/)
- BestSmsBulk Lebanon page: routes via "Touch, Alfa, and international routes", "bank-grade OTP", separate "transactional alerts", phone "+961 3 645875" — [BestSmsBulk Lebanon SMS](https://www.bestsmsbulk.com/sms-lebanon)
- "OTP, 2FA, alerts and transactional SMS are supported via our SMS gateway and REST API" — [BestSmsBulk Lebanon](https://www.bestsmsbulk.com/sms/countries/lebanon)
- **Public API docs** (the only local provider found with them):
  - Base URL `https://www.bestsmsbulk.com/bestsmsbulkapi`. Send via GET/POST `/sendSmsAPI.php` with `api_key`, `api_secret`, `message`, `senderid`, `destination` (semicolon-separated), plus optional `date`/`time` scheduling. There is also a JSON bulk endpoint, `/sendSmsAPIJson.php`.
  - The plain-text response is `confirmationID;recipientNumber;numSMSParts`.
  - Delivery status is **polled**: `/getMessageStatusJson.php` returns `opstatus` values such as DELIVERED, PENDING or FAILED, and a batch lookup handles up to 500 IDs.
  - Balance endpoints: `/getbalance.php` and `/getBalanceJson.php`.
  - Documented errors include "Sender ID is not authorized" and "No credits".
  - The docs mention no SMPP, no documented rate limits, and no explicit Unicode/Arabic flag.
  - Code samples are provided in PHP, Python, Node.js and C#.
  - — [BestSmsBulk API docs](https://www.bestsmsbulk.com/pro-support/api_documentation_bsb)
- "Custom Sender IDs are available in most countries - check availability for your region". No process or timeline is given — [BestSmsBulk home](https://www.bestsmsbulk.com/)
- No named clients. "Banking" appears only as an industry use case ("OTP, transactions, fraud alerts") — [BestSmsBulk home](https://www.bestsmsbulk.com/)

**Asmar Pro (asmarpro.com)**
- "Lebanon, Hadat, Bassil Center, GF" / "Baabda, Po Box: 40-208", phone "+96170967050", email support@asmar-pro.com. Offers an "SMS Gateway API for developers" but publishes no documentation, pricing, Arabic, DLR or operator-route details — [Asmar Pro Bulk SMS](https://www.asmarpro.com/Bulk-SMS-Advertising)
- Named clients: Wooden Bakery, NIIAR, Dalbani, New Lebanon, Hopital Libanais Geitaoui, Kama Plast S.A.R.L. All are private sector; none are government. The company is primarily a web developer "Since 2008" — [Asmar Pro Bulk SMS](https://www.asmarpro.com/Bulk-SMS-Advertising)

**GlobeSMS (globesms.net)**
- Titled "Lebanon SMS Services". It claims to serve "SME, large corporate, public sector and IoT segments" and mentions "Two ways SMS and micropayment". It publishes no API, pricing or operator details. **The newest news item is dated February 01, 2021**, so the business may be inactive — [GlobeSMS](http://globesms.net/)

**International platforms claiming direct Lebanese routes (context only, not local)**
- EasySendSMS claims "direct access to... Touch Lebanon and Alfa" — [EasySendSMS Lebanon](https://www.easysendsms.com/gateway/Lebanon)
- Releans claims "only direct connections" covering all Lebanon networks — [Releans Lebanon](https://releans.com/sms/gateway/lebanon)
- BudgetSMS advertises Lebanon "from € 0.05" with "High Quality routes or Direct Connections" — [BudgetSMS Lebanon](https://www.budgetsms.net/sms-gateway-pricing/lb/lebanon/)

### Inferences
- In practice the market for a backend integration comes down to Lebanon SMS and ProxiReach/BestSmsBulk. ProxiReach is easier to evaluate before contract because its API and a starting price are public. Lebanon SMS advertises SMPP, which ProxiReach's docs do not.
- ProxiReach's API has DLR **polling** and no documented push webhook. A NestJS integration would likely need a scheduled job to reconcile status, unless the provider confirms callbacks on request.
- "Direct routes to Alfa and Touch" is a marketing claim on every site. The operators' own pages say bulk-SMS partners may "sell" SMS to third parties (Q2), so a local reseller holding its own SMPP bind to each operator is plausible. None of these companies is listed by the operators as a partner, though.
- Neither Arabic encoding behaviour nor per-segment billing for UCS-2 (70 chars) is documented by ProxiReach. Test it before relying on it. Lebanon SMS at least acknowledges the 70-char Arabic segment.

### Gaps
- No Lebanese provider publishes payment methods (cash, OMT, Whish, bank transfer, card), whether prices are in "fresh dollars", contract terms, minimum commitments or SLAs. Getting these requires contacting sales.
- Lebanon SMS's legal entity name, API documentation and pricing could not be found.
- No provider names a government, ministry, municipality or bank client. The search found no independent reviews (Reddit, forums, press) of any local provider.
- The market has other B2B aggregators that don't market online. I could not verify any by name, so none are listed. Search results that surfaced unrelated or foreign-registered companies (e.g., "Cyberscape Telecommunications") were not verified as Lebanese and are excluded.

## Q2. Do Alfa and Touch sell A2P/bulk SMS directly to businesses, and on what terms?

### Takeaway
Yes. Both operators publish a "Bulk SMS" business product: an **SMPP bind over a fixed IP** with **dynamic (self-managed) sender IDs**. They explicitly allow partners to **resell** SMS to banks, schools, malls and shops. Touch advertises **1,000 free trial SMS**. Neither publishes prices, minimum volumes or eligibility rules. Alfa bills monthly on traffic "according to its relative rate". Terms are available only by contacting the corporate teams.

### Cited Findings
- **Alfa** Bulk SMS is for "Business owners, community groups, marketing agencies or anyone wishing to communicate with a large group of people". Features: "Dynamic Sender ID, which will allow you to create your own sender IDs", high throughput, SMPP protocol, fixed IP — [Alfa Business: SMS & Short Code](https://www.alfa.com.lb/en/business/sms-short-code)
- Alfa invoicing is "based on the Bulk SMS traffic / month according to its relative rate". Partners can "create, manage and send multiple SMSes to other companies or individuals such as banks, educational institutions, malls, and shops". Contact: alfaservice.providerteam@alfamobile.com.lb — [Alfa Business: SMS & Short Code](https://www.alfa.com.lb/en/business/sms-short-code)
- Alfa also offers routing short codes (E1 link required) and Premium SMS/Voice with "Revenue share between Service provider and MIC1" — [Alfa Business: SMS & Short Code](https://www.alfa.com.lb/en/business/sms-short-code)
- **Touch** Bulk SMS: "enables your company to send a large number of targeted text messages to customers using a standard SMPP Protocol and a fixed IP". Benefits: "A fast and reliable connection", "A high throughput", "A dynamic Sender ID which will allow you to create your own sender IDs", "A trial amount of 1000 Free SMS" — [Touch Bulk SMS (legacy site)](https://legacy.touch.com.lb/autoforms/portal/touch/business/bulk-sms)
- Touch partners may "create, manage and sell multiple SMS for other companies or individuals such as banks, educational institutions, malls, shops, etc." Contact: Corporate Services "+9613 791236" or corporateservices@touch.com.lb — [Touch Bulk SMS (legacy site)](https://legacy.touch.com.lb/autoforms/portal/touch/business/bulk-sms)
- The same Touch bulk-SMS page also exists at payment.touch.com.lb and www.touch.com.lb. Fetching the www URL returned only the consumer homepage, which suggests the product page may have been moved in a site redesign — [Touch Bulk SMS (payment mirror)](https://payment.touch.com.lb/autoforms/portal/touch/business/bulk-sms); [Touch www URL](https://www.touch.com.lb/autoforms/portal/touch/business/bulk-sms)
- Market share: Touch ~55%, Alfa ~42% (from a search-engine summary of provider pages; not primary) — [Sent.dm Lebanon pricing (via search summary)](https://www.sent.dm/en/resources/sms-pricing/lebanon-sms-pricing)
- One unverified secondary claim: direct operator integration requires "Lebanese business registration or authorized representative, minimum volume commitments (often 50,000+ messages/month), sender ID registration, and compliance documentation". This came from a search snippet of Sent.dm's Lebanon guide. **The page returned 404 when fetched**, the claim cites no operator source, and Sent.dm pages read as generic generated content — [Sent.dm Lebanon SMS guide (404 on fetch)](https://www.sent.dm/resources/lb-sms-guidance)

### Inferences
- Going direct would mean two separate SMPP contracts, one each with Alfa and Touch, plus a fixed public IP and an SMPP client in the backend (or an SMPP-to-HTTP bridge such as Kannel/Jasmin). At ~4,000 notifications per month plus OTPs, that is probably below the scale the operators design this product for. A local aggregator already bound to both is the pragmatic route.
- Both operators are state-owned (Ministry of Telecommunications). A municipality is a public body, so it might get a direct arrangement or a government rate. That is speculative and not documented anywhere I found.
- Number portability between Alfa and Touch: I found nothing on whether it exists. If it does not, routing by prefix (03/70/71/76/78/79/81) is deterministic. Confirm this with the aggregator.

### Gaps
- No price per SMS, minimum volume, deposit, contract length, eligibility (Lebanese CR required?) or currency (fresh USD vs LBP) is published by either operator.
- I could not confirm whether the operators separate OTP/transactional traffic from promotional traffic (different routes or prices).
- I could not confirm whether the operator pages are current (the Touch page lives on a "legacy" subdomain).

## Q3. How does sender ID registration work in Lebanon? Who approves it, how long does it take, and is a municipality name possible?

### Takeaway
International gateways state that Lebanon **requires alphanumeric sender ID registration** and **rejects unregistered IDs**. Registration needs a business-registration document and a business case. The operators' bulk-SMS products let the connected partner **define its own sender IDs** ("dynamic Sender ID"). The practical approver is therefore the operator, through the aggregator. I found **no Ministry of Telecommunications or TRA rule** and **no published timeline**. An 11-character alphanumeric ID such as a municipality name is technically supported. Approval of a government-sounding name is unverified.

### Cited Findings
- Telnyx: "Alphanumeric Sender ID registration is required. All messages from unregistered Sender IDs will be rejected." — [Telnyx Lebanon SMS Guidelines](https://support.telnyx.com/en/articles/6674807-lebanon-sms-guidelines)
- Telnyx requires "a copy of your Business Registration" plus the sender ID, message type, content example, company/brand name, website, country of origin and expected monthly volumes. Where the link between company and sender ID is unclear, it asks for "additional supporting documentation detailing your business case". No provisioning time is stated — [Telnyx Lebanon SMS Guidelines](https://support.telnyx.com/en/articles/6674807-lebanon-sms-guidelines)
- Telnyx also requires opt-in consent and "clear Opt-Out options" for marketing SMS — [Telnyx Lebanon SMS Guidelines](https://support.telnyx.com/en/articles/6674807-lebanon-sms-guidelines)
- Conflicting claim: a search summary of Sent.dm says alphanumeric IDs "do not require pre-registration" and are "preserved". This conflicts with Telnyx. Sent.dm's own page 404'd, so the claim is unverified — [Sent.dm Lebanon SMS guide (404 on fetch)](https://www.sent.dm/resources/lb-sms-guidance); contradicted by [Telnyx](https://support.telnyx.com/en/articles/6674807-lebanon-sms-guidelines)
- An AWS re:Post thread is titled "Sender ID Registration for Lebanon - SMS Delivery Issue". The title shows that international senders hit delivery problems linked to Lebanese sender ID registration. The thread content was not fetched — [AWS re:Post](https://repost.aws/questions/QUvy69dPE9QUOvoYM6lJU5-Q/sender-id-registration-for-lebanon-sms-delivery-issue)
- The Vonage "Lebanon SMS Features and Restrictions" article exists but returned 403 when fetched — [Vonage support](https://api.support.vonage.com/hc/en-us/articles/204017663-Lebanon-SMS-Features-and-Restrictions)
- Operators: Alfa and Touch both advertise "Dynamic Sender ID... create your own sender IDs" for bulk-SMS partners — [Alfa](https://www.alfa.com.lb/en/business/sms-short-code); [Touch](https://legacy.touch.com.lb/autoforms/portal/touch/business/bulk-sms)
- Local provider: Lebanon SMS says "Request your custom sender ID (up to 11 characters)" — [Lebanon SMS](https://www.lebanon-sms.com/)
- ProxiReach/BestSmsBulk's API returns the error "Sender ID is not authorized", so sender IDs are pre-authorized per account — [BestSmsBulk API docs](https://www.bestsmsbulk.com/pro-support/api_documentation_bsb)
- A search summary says the TRA regulates SMS and that "specific SMS marketing laws are still evolving". This comes from Sent.dm, not from a TRA document — [Sent.dm FR guide (search summary)](https://www.sent.dm/fr/resources/sms-compliance/lb-sms-guidance)
- Brand impersonation by SMS is a live problem. OMT publicly warned that SMS claiming to come from OMT are fake and used for fraud — [Al Jadeed](https://www.aljadeed.tv/news/%D9%85%D8%AD%D9%84%D9%8A%D8%A7%D8%AA/585591/omt-%D8%A7%D8%AD%D8%B0%D8%B1%D9%88%D8%A7-%D8%B1%D8%B3%D8%A7%D8%A6%D9%84-%D8%A7%D9%84%D8%A7%D8%AD%D8%AA%D9%8A%D8%A7%D9%84-%D8%B5%D9%88%D8%B1%D8%A9/ar)

### Inferences
- The likely route: the aggregator submits the requested ID (e.g., a Latin transliteration of the municipality name, max 11 characters) to Alfa and Touch under its SMPP accounts, with a municipal letter or registration document as the business case. Expect the aggregator to handle it. Get the timeline in writing.
- Arabic-script sender IDs are generally not supported in alphanumeric fields worldwide, so plan for a Latin sender name. This is general industry knowledge and was not verified for Lebanon.
- The OMT smishing case shows that a registered, consistent sender ID matters for citizen trust. OTP messages should always come from the same registered ID.

### Gaps
- I found no official Ministry of Telecommunications or TRA decision, circular or register of sender IDs. I could not establish whether the TRA is still functional in practice. That claim is unverified.
- There is no published approval timeline (days or weeks) from any operator or local provider.
- It is unknown whether a government or municipal name needs extra authorization, or whether operators block IDs that look official.

## Q4. What prices do local providers quote? Are there public price lists?

### Takeaway
Only one local provider publishes a price: **BestSmsBulk/ProxiReach, "Lebanon starts at $0.02/SMS"** (USD). Lebanon SMS, Asmar Pro, GlobeSMS, Alfa and Touch are **quote only**. International gateways publish higher list prices for Lebanon (e.g., BudgetSMS from €0.05). No source says whether local prices are in fresh dollars or LBP, or how volume tiers work.

### Cited Findings
- "Lebanon starts at $0.02/SMS, while international rates depend on the destination" — [BestSmsBulk home](https://www.bestsmsbulk.com/)
- Lebanon SMS shows segment lengths (160 Latin / 70 Arabic) but no price or currency — [Lebanon SMS](https://www.lebanon-sms.com/)
- Asmar Pro publishes no pricing — [Asmar Pro](https://www.asmarpro.com/Bulk-SMS-Advertising)
- Alfa bills bulk SMS monthly "according to its relative rate", with the rate unpublished. Touch publishes no tariff beyond the 1,000-SMS trial — [Alfa](https://www.alfa.com.lb/en/business/sms-short-code); [Touch](https://legacy.touch.com.lb/autoforms/portal/touch/business/bulk-sms)
- International comparison: BudgetSMS advertises Lebanon "from € 0.05" — [BudgetSMS](https://www.budgetsms.net/sms-gateway-pricing/lb/lebanon/)
- A search-engine summary claimed "local SMS rates in Lebanon are approximately LBP 100–200 per message (~$0.001–0.002)". **No source page was attached, and I treat it as unreliable.** It is not usable as a price — (unsourced search summary, excluded)

### Inferences
- A rough budget at $0.02 per segment: 4,000 single-segment notifications cost ≈ $80/month. Arabic messages over 70 characters split into multiple segments (67 chars each when concatenated, general GSM rule), which multiplies the cost. For example, a 140-character Arabic notice ≈ 3 segments ≈ $0.06 at the BestSmsBulk entry price. OTPs add to this. These are illustrative figures from a "starts at" price, not a quote.
- "Starts at" usually means the high-volume tier, so a 4k/month buyer may pay more. Ask for the rate at this volume, the segment billing for UCS-2, and whether failed or undelivered messages are charged.

### Gaps
- There are no public volume tiers and no information on fresh USD vs LBP billing, prepaid-credit vs postpaid terms, credit expiry, separate OTP vs promotional prices, or charging for undelivered messages. All require quotes.

## Q5. Known reliability problems (economic crisis, fuel and electricity, 2024 war in the south)

### Takeaway
Lebanese mobile networks have had **fuel- and power-driven outages since the 2019–2022 crisis**. Alfa and Touch depend on shared Ogero infrastructure such as the Sin el-Fil central station. The **2024 war knocked out hundreds of Alfa and Touch sites** in the south, the southern suburbs and the Bekaa. As of **June 2025**, parts of the south (notably Nabatieh district and Iqlim al-Tuffah) still had poor coverage. SMS to recipients in affected southern villages may be delayed or undelivered whichever provider is used.

### Cited Findings
- 2024 war: Alfa had 161 transmission stations out of service "south of Beirut, southern Lebanon, and Beqaa". Touch had 175 out, "including 9 completely destroyed and 11 partially damaged". Earlier reports cited 4 Touch and 6 Alfa stations damaged, 2 of them destroyed — [The New Arab](https://www.newarab.com/news/will-lebanon-face-internet-blackout-war-damages-telecoms)
- The telecoms ministry estimated losses at ~$67 million — [L'Orient Today](https://today.lorientlejour.com/article/1432390/lebanons-telecom-network-nearly-67-million-in-damage-since-start-of-war.html)
- The headline "26 Ogero, 114 Touch and 113 Alfa stations out of service". The article was not accessible (403), so its date and context are unverified — [L'Orient Today](https://today.lorientlejour.com/article/1429878/26-ogero-114-touch-and-113-alfa-stations-out-of-service.html)
- Service declines were reported in Marjayoun, Sour, Hasbaya and Nabatieh districts. The percentages in the search summary (e.g., "Marjayoun (2 percent)", "Nabatieh (59 percent)") are ambiguous as to whether they measure availability or decline — [The New Arab (via search summary)](https://www.newarab.com/news/will-lebanon-face-internet-blackout-war-damages-telecoms)
- Repairs were blocked by "the dangerous security situation", and some stations that power other stations were destroyed — [The New Arab (via search summary)](https://www.newarab.com/news/will-lebanon-face-internet-blackout-war-damages-telecoms)
- **June 3, 2025 (six months after the ceasefire):** the Minister of Telecommunications said Alfa and Touch were back to "around 80–90% capacity", but "ground reality contradicts these figures". Outages persisted in Nabatieh District and Iqlim al-Tuffah, 71 of 82 Ogero centers were operational, and "dozens" of stations were still non-functional — [SMEX](https://smex.org/telecommunications-in-south-lebanon-has-the-network-recovered-after-the-ceasefire/)
- September 2022: Alfa had forced outages after fuel ran out at the Sin el-Fil central station during an Ogero strike. Alfa and Touch both depend on that station because their optical fibres run through it — [L'Orient Today](https://today.lorientlejour.com/article/1310592/alfa-internet-services-outage.html)
- Telecom outages across Lebanon linked to fuel shortages and deferred maintenance after the 2019 currency collapse — [SMEX: Mapping the telecom outages](https://smex.org/mapping-the-telecom-outages-in-lebanon/)
- Diesel shortages threatened the telecom sector — [The961](https://www.the961.com/diesel-fuel-threatens-lebanese-telecoms/)
- Nationwide grid blackouts in 2021 and 2024 — [Wikipedia: 2021 Lebanon blackout](https://en.wikipedia.org/wiki/2021_Lebanon_blackout); [Wikipedia: 2024 Lebanon blackout](https://en.wikipedia.org/wiki/2024_Lebanon_blackout)

### Inferences
- For South Lebanon municipalities, the last-mile radio network is a bigger risk than the choice of aggregator. The design should assume some OTPs will not arrive. Useful measures: resend with cooldown, a longer OTP validity window, an alternative such as WhatsApp or voice OTP or an in-person or staff-assisted path, and DLR tracking so staff can see "not delivered" per citizen.
- A local aggregator's own uptime depends on Lebanese power and connectivity. Ask where its SMPP gateway is hosted (in Lebanon vs abroad) and what failover it has.

### Gaps
- There are no SMS-specific outage statistics (vs data or voice) for 2024–2026, and no 2026 status of southern coverage was found. The latest found is June 2025.
- No published uptime or SLA figures exist for any local aggregator. Their "99.9% delivery" claims are marketing and unaudited.

## Q6. What do Lebanese banks, ministries and government apps (IMPACT, OMT, Whish) use for SMS/OTP?

### Takeaway
**Not found.** No public source names the SMS/OTP provider behind IMPACT, any ministry, OMT, Whish Money or a Lebanese bank. No local provider names any such client. Treat any claim that "the government uses X" as unverified unless the provider shows a reference letter.

### Cited Findings
- IMPACT is the Central Inspection Bureau's "Inter-Ministerial and Municipal Platform for Assessment, Coordination and Tracking". It was used for COVID vaccine registration, traveller tracking and lockdown permits. Its SMS provider is not disclosed — [CIB: IMPACT](https://www.cib.gov.lb/en/impact-inter-ministerial-and-municipal-platform-assessment-coordination-and-tracking); [World Bank blog](https://blogs.worldbank.org/arabvoices/lebanons-covid-19-vaccination-digital-platform-promotes-transparency-public-trust)
- SMEX has scrutinized IMPACT's data handling. Its article is relevant to the privacy expectations for a municipal platform, but the provider is again not named — [SMEX: Is Lebanese citizens' data safe on IMPACT's platforms?](https://smex.org/is-lebanese-citizens-data-safe-on-impacts-platforms/)
- The operators' own pages list "banks, educational institutions, malls, and shops" as typical end customers of bulk-SMS partners. This is a generic description, not a client list — [Alfa](https://www.alfa.com.lb/en/business/sms-short-code); [Touch](https://legacy.touch.com.lb/autoforms/portal/touch/business/bulk-sms)
- BestSmsBulk lists "Banking" as an industry solution but names no bank — [BestSmsBulk](https://www.bestsmsbulk.com/)
- IMPACT is explicitly an inter-ministerial *and municipal* platform, which makes it a precedent for municipal digital services in Lebanon — [CIB: IMPACT](https://www.cib.gov.lb/en/impact-inter-ministerial-and-municipal-platform-assessment-coordination-and-tracking)

### Inferences
- Asking the CIB/IMPACT team, or a bank's IT department, which aggregator they use would be the fastest way to get a vetted reference. It is also worth asking shortlisted providers for government or bank references under NDA.
- Citizen phone numbers and OTPs will pass through the aggregator. The data-processing terms matter: retention of message content and logs, and where servers are located. This is a question for procurement, not something any provider publishes.

### Gaps
- No public information exists on OTP providers for OMT, Whish Money, Lebanese banks or government apps.
- No press coverage (Executive Magazine, L'Orient-Le Jour, The961) of the Lebanese A2P SMS market was found, and no forum or Reddit discussion comparing local providers was found.
