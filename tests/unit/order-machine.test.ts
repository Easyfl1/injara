import { describe, it, expect } from "vitest";
import { canTransition } from "../../src/domain/order-machine.js";

describe("order-machine", () => {
  it("allows QUOTED -> AWAITING_PAYMENT for BUY", () => {
    expect(canTransition("BUY", "QUOTED", "AWAITING_PAYMENT")).toBe(true);
  });

  it("allows QUOTED -> EXPIRED for BUY", () => {
    expect(canTransition("BUY", "QUOTED", "EXPIRED")).toBe(true);
  });

  it("allows AWAITING_PAYMENT -> PAYMENT_CONFIRMED for BUY", () => {
    expect(canTransition("BUY", "AWAITING_PAYMENT", "PAYMENT_CONFIRMED")).toBe(true);
  });

  it("does not allow COMPLETED -> anything for BUY", () => {
    expect(canTransition("BUY", "COMPLETED", "QUOTED")).toBe(false);
  });

  it("allows QUOTED -> AWAITING_DEPOSIT for SELL", () => {
    expect(canTransition("SELL", "QUOTED", "AWAITING_DEPOSIT")).toBe(true);
  });

  it("allows DEPOSIT_CONFIRMED -> PAYOUT_PENDING for SELL", () => {
    expect(canTransition("SELL", "DEPOSIT_CONFIRMED", "PAYOUT_PENDING")).toBe(true);
  });
});
