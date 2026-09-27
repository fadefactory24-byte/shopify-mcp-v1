/**
 * Phone normalization for matching WhatsApp senders against Shopify records.
 * WhatsApp gives wa_id as international digits ("972501234567"); Shopify may
 * hold "+972 50-123-4567", "050-1234567", "00972501234567", etc.
 * We compare normalized international digit strings. Default country: Israel.
 */
export function normalizePhone(raw: string | null | undefined, defaultCountryCode = "972"): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = defaultCountryCode + digits.slice(1);
  digits = digits.replace(/\D/g, "");
  // Israeli numbers sometimes stored as 972-0-50...: drop the trunk zero.
  if (digits.startsWith(`${defaultCountryCode}0`)) digits = defaultCountryCode + digits.slice(defaultCountryCode.length + 1);
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return na !== null && na === nb;
}

export function toE164(digits: string): string {
  return `+${digits}`;
}
