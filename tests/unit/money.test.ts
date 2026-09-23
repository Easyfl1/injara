import { describe, it, expect } from "vitest";
import {
  injHumanToBase,
  injBaseToHuman,
  ngnHumanToKobo,
  koboToNgnString,
  buyPayableKobo,
  sellPayoutKobo,
  flwAmountToKobo,
  parseInjBase,
  addBase,
  subBase,
  cmpBase,
} from "../../src/domain/money.js";

describe("money", () => {
  describe("injHumanToBase", () => {
    it("converts 1 INJ to base units", () => {
      const result = injHumanToBase("1");
      expect(result).toBe("1000000000000000000");
    });

    it("converts 0.5 INJ to base units", () => {
      const result = injHumanToBase("0.5");
      expect(result).toBe("500000000000000000");
    });

    it("converts 1.5 INJ to base units", () => {
      const result = injHumanToBase("1.5");
      expect(result).toBe("1500000000000000000");
    });

    it("rejects negative amounts", () => {
      expect(() => injHumanToBase("-1")).toThrow();
    });

    it("rejects too many decimals", () => {
      expect(() => injHumanToBase("1.123456789")).toThrow();
    });
  });

  describe("injBaseToHuman", () => {
    it("converts base to human", () => {
      expect(injBaseToHuman("1000000000000000000")).toBe("1");
      expect(injBaseToHuman("1500000000000000000")).toBe("1.5");
    });
  });

  describe("addBase", () => {
    it("adds correctly", () => {
      expect(addBase("0", injHumanToBase("1"))).toBe("1000000000000000000");
      expect(
        addBase("1" + "0".repeat(18), injHumanToBase("1")),
      ).toBe("2" + "0".repeat(18));
    });
  });

  describe("subBase", () => {
    it("subtracts correctly", () => {
      expect(
        subBase("2" + "0".repeat(18), injHumanToBase("1")),
      ).toBe("1" + "0".repeat(18));
    });

    it("throws on underflow", () => {
      expect(() => subBase("1", "2")).toThrow("InjBase underflow");
    });
  });

  describe("cmpBase", () => {
    it("compares correctly", () => {
      expect(cmpBase("1", "2")).toBe(-1);
      expect(cmpBase("2", "1")).toBe(1);
      expect(cmpBase("1", "1")).toBe(0);
    });
  });

  describe("ngnHumanToKobo", () => {
    it("converts NGN to kobo", () => {
      expect(ngnHumanToKobo("100")).toBe(10000n);
      expect(ngnHumanToKobo("100.50")).toBe(10050n);
    });
  });

  describe("koboToNgnString", () => {
    it("converts kobo to NGN string", () => {
      expect(koboToNgnString(10000n)).toBe("100.00");
      expect(koboToNgnString(10050n)).toBe("100.50");
      expect(koboToNgnString(50n)).toBe("0.50");
      expect(koboToNgnString(5n)).toBe("0.05");
    });
  });

  describe("flwAmountToKobo", () => {
    it("converts FLW amount to kobo", () => {
      expect(flwAmountToKobo("100.50")).toBe(10050n);
      expect(flwAmountToKobo(100.5)).toBe(10050n);
    });
  });

  describe("buyPayableKobo", () => {
    it("calculates buy payable correctly", () => {
      const result = buyPayableKobo("1.5", "3000000", 200);
      expect(result.gross).toBe(450000000n);
      expect(result.fee).toBe(9000000n);
      expect(result.payable).toBe(459000000n);
    });
  });

  describe("sellPayoutKobo", () => {
    it("calculates sell payout correctly", () => {
      const result = sellPayoutKobo("2", "3000000", 200, 1075n);
      expect(result.gross).toBe(600000000n);
      expect(result.fee).toBe(12000000n);
      expect(result.payout).toBe(587998925n);
    });

    it("throws on non-positive payout", () => {
      expect(() => sellPayoutKobo("0.001", "3000000", 200, 10000000n)).toThrow(
        "payout non-positive",
      );
    });
  });
});
