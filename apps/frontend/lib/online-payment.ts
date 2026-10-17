/**
 * Whether the citizen portal offers paying online through Whish.
 *
 * Paused by the product owner's decision of 2026-10-13 (docs/open-decisions.md
 * §21) until Whish gives the municipality its API: citizens pay at the
 * municipality's cash office or to a collector. While this is false the portal
 * shows no «ادفع عبر Whish» or «ادفع الآن», and its copy says where to pay
 * instead (the request messages take `online` as an ICU `select`, through
 * `onlineCopy`). The server refuses regardless: `FeesService.startWhishCheckout`
 * and a citizen's own request bill answer `ONLINE_PAYMENT_UNAVAILABLE` until the
 * Whish gateway is live.
 *
 * Not the manual report: a transfer the citizen makes in their own Whish app to
 * the municipality's number and declares on `/payments` («أبلغ عن الدفع») needs
 * no Whish API and stays (the owner's choice, the same day).
 *
 * To reopen: write `WhishGatewayService.postCheckout` against Whish's contract,
 * declare `WHISH_*` in the backend's env schema and set them, then set this to
 * true — in that order, or the button reaches a server that refuses it.
 */
export const ONLINE_PAYMENT_OPEN = false;

/** The `online` argument of the messages that read differently while online payment is paused. */
export function onlineCopy(): { online: 'yes' | 'no' } {
  return { online: ONLINE_PAYMENT_OPEN ? 'yes' : 'no' };
}
