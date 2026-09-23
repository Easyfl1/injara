import { Decimal } from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };
export const INJ_DECIMALS = 18;
export const INJ_DENOM = "inj";
export const KOBO_PER_NGN = 100n;

export type InjBase = string;
export type NgnKobo = bigint;

export function injHumanToBase(human: string): InjBase {
  const d = new Decimal(human);
  if (d.isNeg()) throw new Error("INJ amount cannot be negative");
  if (d.decimalPlaces() > 8) throw new Error("INJ amount has too many decimal places");
  const factor = new Decimal(10).pow(INJ_DECIMALS);
  const base = d.mul(factor);
  if (!base.isInteger()) throw new Error("INJ base conversion resulted in non-integer");
  return base.toFixed();
}

export function injBaseToHuman(base: InjBase, dp = 6): string {
  const factor = new Decimal(10).pow(INJ_DECIMALS);
  const human = new Decimal(base).div(factor);
  return human.toFixed(dp).replace(/\.?0+$/, "");
}

export function ngnHumanToKobo(human: string): NgnKobo {
  const d = new Decimal(human);
  if (d.isNeg()) throw new Error("NGN amount cannot be negative");
  if (d.decimalPlaces() > 2) throw new Error("NGN amount has too many decimal places");
  const kobo = d.mul(100);
  if (!kobo.isInteger()) throw new Error("NGN kobo conversion resulted in non-integer");
  return BigInt(kobo.toFixed());
}

export function koboToNgnString(kobo: NgnKobo): string {
  const s = kobo.toString();
  const len = s.length;
  if (len <= 2) {
    return "0." + s.padStart(2, "0");
  }
  return s.slice(0, len - 2) + "." + s.slice(len - 2);
}

export function priceToDecimal(raw: string | Decimal): Decimal {
  if (typeof raw === "number") throw new Error("IEEE-754 forbidden for money");
  return new Decimal(raw);
}

export function buyPayableKobo(
  injHuman: string,
  injNgn: string,
  feeBps: number,
): { gross: NgnKobo; fee: NgnKobo; payable: NgnKobo } {
  const grossDec = new Decimal(injHuman).mul(injNgn).mul(100);
  const gross = BigInt(grossDec.toFixed(0, Decimal.ROUND_CEIL));
  const fee = (gross * BigInt(feeBps) + 9999n) / 10000n;
  return { gross, fee, payable: gross + fee };
}

export function sellPayoutKobo(
  injHuman: string,
  injNgn: string,
  feeBps: number,
  flwFee: NgnKobo,
): { gross: NgnKobo; fee: NgnKobo; payout: NgnKobo } {
  const grossDec = new Decimal(injHuman).mul(injNgn).mul(100);
  const gross = BigInt(grossDec.toFixed(0, Decimal.ROUND_FLOOR));
  const fee = (gross * BigInt(feeBps) + 9999n) / 10000n;
  const payout = gross - fee - flwFee;
  if (payout <= 0n) throw new Error("payout non-positive");
  return { gross, fee, payout };
}

export function flwAmountToKobo(amount: string | number): NgnKobo {
  const s = typeof amount === "number" ? new Decimal(amount).toFixed(2) : amount;
  return ngnHumanToKobo(s);
}

/**
 * What the customer was charged for a BUY order: gross + platform fee.
 * The payment link is created for this amount, so FLW's `amount`/`charged_amount`
 * must be compared against it — NOT against the gross stored on the order.
 */
export function buyTotalKobo(
  order: { ngnAmountKobo: bigint | string; feeKobo: bigint | string },
): NgnKobo {
  return BigInt(order.ngnAmountKobo) + BigInt(order.feeKobo);
}

/**
 * Authoritative check that a FLW verification result is a successful,
 * exact-amount NGN charge for the given BUY order.
 * Accepts either `amount` or `charged_amount` (they can differ for
 * partial-charge instruments); the tx_ref must match exactly.
 */
export function isSuccessfulBuyCharge(
  verify: { data?: { status?: string; currency?: string; tx_ref?: string; amount?: string | number; charged_amount?: string | number } | null } | null | undefined,
  order: { paymentReference: string | null; ngnAmountKobo: bigint | string; feeKobo: bigint | string },
): boolean {
  const d = verify?.data;
  if (!d) return false;
  if (d.status !== "successful") return false;
  if (d.currency !== "NGN") return false;
  if (d.tx_ref !== order.paymentReference) return false;

  const total = buyTotalKobo(order);
  const candidates: (string | number | undefined)[] = [d.charged_amount, d.amount];
  return candidates.some((a) => a !== undefined && flwAmountToKobo(a) === total);
}

export function parseInjBase(s: string): bigint {
  if (!/^\d+$/.test(s)) throw new Error(`invalid InjBase: ${s}`);
  return BigInt(s);
}

export function addBase(a: InjBase, b: InjBase): InjBase {
  return (parseInjBase(a) + parseInjBase(b)).toString();
}

export function subBase(a: InjBase, b: InjBase): InjBase {
  const n = parseInjBase(a) - parseInjBase(b);
  if (n < 0n) throw new Error("InjBase underflow");
  return n.toString();
}

export function cmpBase(a: InjBase, b: InjBase): number {
  const d = parseInjBase(a) - parseInjBase(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

export function mulBase(a: InjBase, b: InjBase): InjBase {
  return (parseInjBase(a) * parseInjBase(b)).toString();
}

export function divBase(a: InjBase, b: InjBase): InjBase {
  const divisor = parseInjBase(b);
  if (divisor === 0n) throw new Error("division by zero");
  return (parseInjBase(a) / divisor).toString();
}
