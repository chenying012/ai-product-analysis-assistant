import { AppError } from "../errors";
import type { AccountStore } from "./store";

/** Credits granted when an account is created. */
export const SIGNUP_BONUS = 10;
/** Cost of one analysis request. */
export const ANALYSIS_COST = 1;

export type CreditHold = {
  /** Releases the charge when the work it paid for did not produce a result. Safe to call more than
   * once; only the first effective call returns a credit. */
  refund(): Promise<void>;
  /** Balance immediately after the charge, shown to the caller without a second read. */
  balance: number;
};

/**
 * Charges for one analysis before any work starts.
 *
 * The charge has to happen up front: the analysis replies as a stream, and once the first byte is
 * written the response status can no longer become 402. Reserving the credit first means an
 * overdrawn account is refused with a proper status code instead of mid-stream.
 *
 * The counterpart is that a failed analysis must give the credit back, which is what the returned
 * hold does. Both directions are keyed on the same reference so a retry can neither double-charge
 * nor double-refund.
 */
export async function holdCredit(store: AccountStore, userId: string, reference: string): Promise<CreditHold> {
  const charge = await store.spendCredit(userId, reference);
  if (!charge.ok) {
    throw new AppError(
      "INSUFFICIENT_CREDITS",
      `积分不足，当前余额 ${charge.balance}。每次分析消耗 ${ANALYSIS_COST} 积分。`,
      402,
    );
  }
  let settled = false;
  return {
    balance: charge.balance,
    async refund(): Promise<void> {
      if (settled) return;
      settled = true;
      await store.refundCredit(userId, reference);
    },
  };
}
