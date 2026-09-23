import * as otplib from "otplib";

export function generateTOTPUri(secret: string): string {
  return otplib.authenticator.keyuri("Injara Admin", "injara", secret);
}

export function verifyTOTP(token: string, secret: string): boolean {
  try {
    return otplib.authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}
