import pino from "pino";

/**
 * Structured JSON logs. Secrets and phone numbers are redacted by path; message
 * bodies are only logged when LOG_MESSAGE_BODIES=true (see pipeline).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "babito-agent" },
  redact: {
    paths: [
      "*.authorization",
      "*.Authorization",
      "*.access_token",
      "*.accessToken",
      "*.token",
      "*.secret",
      "*.password",
      "*.apiKey",
      "*.phone",
      "*.email",
      "headers.authorization",
    ],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;

/** Mask a phone for logs: 972501234567 -> 9725****4567 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  if (phone.length <= 8) return "****";
  return `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}
