/**
 * The wallets a treasury form may offer: the active ones.
 *
 * The overview lists every municipal wallet, a retired one included, because
 * its balance and its statement are still facts to read. Acting on one is
 * another matter, and the server holds the line: activation takes the opening
 * balance of every active wallet and of no other
 * (`TREASURY_OPENING_BALANCES_INCOMPLETE`), and an expense is paid only from an
 * active one (`TREASURY_ACCOUNT_NOT_FOUND`). A form that offered a retired
 * wallet could only be refused.
 */
export function activeAccounts<T extends { active: boolean }>(overview: { accounts: readonly T[] }): T[] {
  return overview.accounts.filter((account) => account.active);
}
