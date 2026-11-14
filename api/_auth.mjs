import { createHmac, timingSafeEqual } from "node:crypto";

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** True if `given` matches APP_PASSCODE. Throws 503 if no passcode is configured. */
export function passcodeOk(given) {
  const expected = process.env.APP_PASSCODE;
  if (!expected) {
    throw Object.assign(new Error("APP_PASSCODE is not set on the server."), { statusCode: 503 });
  }
  return typeof given === "string" && given.length > 0 && sameText(given.trim(), expected.trim());
}

/** Secret Telegram must send with every webhook call. Derived from the bot token, so it needs no extra setting. */
export function telegramWebhookSecret(botToken = process.env.TELEGRAM_BOT_TOKEN) {
  if (!botToken) return null;
  return createHmac("sha256", botToken).update("ledgerly-telegram-webhook").digest("base64url").slice(0, 48);
}

export function telegramSecretOk(given) {
  const expected = telegramWebhookSecret();
  return !!expected && typeof given === "string" && sameText(given, expected);
}
