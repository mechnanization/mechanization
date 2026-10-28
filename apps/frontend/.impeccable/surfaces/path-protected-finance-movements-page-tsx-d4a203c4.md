---
version: 1
slug: "path-protected-finance-movements-page-tsx-d4a203c4"
primary_target: "apps/frontend/app/[tenant]/[locale]/[adminPath]/(protected)/finance/movements/page.tsx"
related_targets: []
---

# Surface brief: الإيرادات والنفقات (/finance/movements)

Scope: the treasury's income and expense registers merged into one Operate-mode page, with the record forms inline. Audience: the accountant (records all day), the head of the municipality (orders, cancels), the auditor and view-only staff (read). Constraints: PRODUCT.md and DESIGN.md unchanged in identity; vouchers only (no citizen payments); a new read-only `GET treasury/movements` feeds the register.

## Direction contract

THESIS: The register never leaves the screen. Beside it sits a pane that is always one of two things, the next entry or the voucher just picked, so recording, checking, printing and cancelling happen without a page change. It refuses the category default of two separate registers, each with its own "new" page.

OWN-WORLD: The Modern Civic Ledger. Warm near-black or cream surfaces, with one cedar-blue accent for the selection and the primary action. Money received is success green with a «+», and money paid out is foreground with a U+2212 minus; the sign and an arrow tile always travel with the colour. Awaiting-order and cancelled show as warning text chips. Plex Arabic with tabular figures, 1px borders, rounded-lg panels.

STORY: The accountant sees what moved this period in both currencies, records the next receipt or payment without leaving the page, and opens, prints or cancels any voucher in place. The head of the municipality sees what is waiting on his order.

FIRST VIEWPORT:
- The header «الإيرادات والنفقات» with «بنود الإيرادات».
- A period strip: the period select, in, out and net per currency, and the voucher count.
- The register on the reading side (about 58%): «الدفتر | بانتظار الأمر (n)», then search and filters, then the day groups with 52px rows.
- The pane opposite (about 42%, sticky, full height):
  - «حركة جديدة» and «قبض | صرف»;
  - for an accountant's expense, request or urgent;
  - a large amount field and wallet tiles showing the balance now and after;
  - category, party, description and «تفاصيل إضافية»;
  - a full-width submit button at its foot.

FORM: Register + work pane, position 7 on the ordered list, seed key f68ddee5. Signature interaction: the new voucher lands in today's group, briefly highlighted, while the pane resets for the next entry. Picking a row turns the pane into that voucher. On a phone, the pane takes the whole screen and a bottom bar holds «قبض» and «صرف».

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Revision 2026-10-12: split into two pages

On review the register and the pane were split. This route, `/finance/movements` («الإيرادات والنفقات»), is now the recording page only: one centred card (`max-w-4xl`) with «قبض | صرف», the form in two columns from `md`, the wallet as `WalletSelect` (a dropdown whose items carry the balance), the confirmation above the next fresh form. The register by day, its period block, filters, queue and a voucher pane that shows only while a voucher is open moved to `/finance/transactions` («الحركات المالية»). The thesis above ("the register never leaves the screen") no longer holds for recording; each page links to the other, and «عرض» on a recorded voucher opens it in the register.
