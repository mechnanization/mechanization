import { Banknote, HandCoins, Landmark, Smartphone, Wallet, type LucideIcon } from 'lucide-react';
import type { TreasuryAccountType } from '@mechanization/shared-schemas';

/**
 * Which picture a wallet gets, by what it is — on the balances page and in the
 * record forms' wallet picker alike, so a wallet looks the same wherever it is
 * chosen or read (UX-1).
 *
 * Whish has no mark of its own here on purpose: its logo is a third party's
 * trademark, and drawing it from memory would put a wrong version of somebody
 * else's brand on a municipal screen. A phone-wallet says what it is. If the
 * municipality supplies the official mark, it replaces `Smartphone` here.
 */
export const WALLET_ICON: Record<TreasuryAccountType, LucideIcon> = {
  CASH_SAFE: Banknote,
  WHISH_ACCOUNT: Smartphone,
  BANK_ACCOUNT: Landmark,
  COLLECTOR_CUSTODY: HandCoins,
  PETTY_CASH: Wallet,
};

/** The icon for a wallet type, with a plain wallet for a type this build does not know. */
export function walletIcon(type: TreasuryAccountType): LucideIcon {
  return WALLET_ICON[type] ?? Wallet;
}
