export function validateInjectiveAddress(address: string): boolean {
  if (!address.startsWith("inj1")) return false;
  if (address.length < 40 || address.length > 65) return false;
  return /^inj1[a-z0-9]{38,62}$/.test(address);
}

export function validateNUBAN(accountNumber: string): boolean {
  return /^\d{10}$/.test(accountNumber);
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
