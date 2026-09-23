import { describe, it, expect } from "vitest";
import { validateInjectiveAddress, validateNUBAN, validateEmail } from "../../src/domain/address.js";

describe("address", () => {
  describe("validateInjectiveAddress", () => {
    it("validates correct address", () => {
      expect(validateInjectiveAddress("inj1qyvhy9cnq8alvz8m4tqyq3f8g8qz3r3r3r3r3r")).toBe(true);
    });

    it("rejects non-inj prefix", () => {
      expect(validateInjectiveAddress("cosmos1abc")).toBe(false);
    });

    it("rejects too short", () => {
      expect(validateInjectiveAddress("inj1abc")).toBe(false);
    });
  });

  describe("validateNUBAN", () => {
    it("validates 10-digit number", () => {
      expect(validateNUBAN("1234567890")).toBe(true);
    });

    it("rejects non-10-digit", () => {
      expect(validateNUBAN("123456789")).toBe(false);
    });
  });

  describe("validateEmail", () => {
    it("validates correct email", () => {
      expect(validateEmail("user@example.com")).toBe(true);
    });

    it("rejects invalid email", () => {
      expect(validateEmail("not-an-email")).toBe(false);
    });
  });
});
