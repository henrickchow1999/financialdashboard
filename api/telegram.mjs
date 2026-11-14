// Telegram bot webhook: send the bot a screenshot of your transactions (or a receipt)
// and they're added to the ledger.
//
// Commands:  /start <passcode>  connect this Telegram account (only that account is accepted after)
//            /undo              remove what the last screenshot added
//            /help
//
// Env: TELEGRAM_BOT_TOKEN, APP_PASSCODE, GITHUB_TOKEN
//      ANTHROPIC_API_KEY (optional): if set, screenshots are read instantly here.
//      If not set, they're saved to inbox/ in the data repo for the hourly
//      Claude Code task to process.

import { telegramSecretOk, passcodeOk } from "./_auth.mjs";
import { readLedger, updateLedger, cleanTxn, putNewFile } from "./_store.mjs";
import { extractStatement } from "./_statement.mjs";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./_extract.mjs";

export const config = { maxDuration: 60 };

const MAX_IMAGE_BYTES = 5_000_000;
const HELP =
  "Send me a screenshot of your card/bank transactions, or a photo of a receipt, and I'll add them to Ledgerly" +
  (process.env.ANTHROPIC_API_KEY ? ".\n\n" : " (within the hour).\n\n") +
  "• Duplicates (e.g. overlapping screenshots) are skipped automatically.\n" +
  "• Card bill payments and transfers between your own accounts are not added.\n" +
  "• /undo removes whatever the last screenshot added.";

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description || res.status}`);
  return json.result;
}

const reply = (chatId, text, replyTo) =>
  tg("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  }).catch((e) => console.error(e));

async function downloadImage(fileId) {
  const file = await tg("getFile", { file_id: fileId });
  if (file.file_size && file.file_size > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("That image is too large (over 5 MB). Send it as a normal photo instead."), { userFacing: true });
  }
  const res = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`Image download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (file.file_path.split(".").pop() || "").toLowerCase();
  const mime = { png: "image/png", webp: "image/webp", gif: "image/gif" }[ext] || "image/jpeg";
  return { base64: buf.toString("base64"), mime };
}

const money = (n, cur = "MYR") => `${cur === "MYR" ? "RM" : cur + " "}${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rawKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
const txnKey = (t) => `${t.date}|${t.type}|${Number(t.amount).toFixed(2)}`;

/** Turn extracted rows into ledger transactions; split out rows we deliberately don't add. */
function toTxns(rows, batch) {
  const add = [];
  const ignored = [];
  const now = Date.now();
  rows.forEach((r, i) => {
    if (!(r.amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      ignored.push({ r, why: "unreadable" });
      return;
    }
    if (r.kind === "card_payment" || r.kind === "transfer") {
      ignored.push({ r, why: r.kind === "card_payment" ? "card bill payment" : "transfer between your accounts" });
      return;
    }
    const type = r.direction === "money_in" ? "income" : "expense";
    let category = r.category;
    if (type === "expense" && !EXPENSE_CATEGORIES.includes(category)) category = "Other Expense";
    if (type === "income") {
      if (r.kind === "refund") category = "Refunds Received";
      else if (!INCOME_CATEGORIES.includes(category)) category = "Other Income";
    }
    const notes = [
      r.foreign_amount ? `Charged as ${r.foreign_amount}` : "",
      r.home_currency && r.home_currency !== "MYR" ? `Amount in ${r.home_currency}` : "",
      "Added from Telegram",
    ].filter(Boolean).join(" · ");
    const t = cleanTxn({
      id: `tg${batch.slice(2)}x${i}`,
      createdAt: now + i,
      hasReceipt: false,
      receiptName: "",
      type,
      date: r.date,
      vendor: r.merchant || r.raw_text,
      description: r.description,
      category,
      amount: r.amount,
      method: "Card",
      notes,
      source: { kind: "telegram", batch, raw: r.raw_text },
    });
    if (t) add.push(t); else ignored.push({ r, why: "unreadable" });
  });
  return { add, ignored };
}

/** Rows already in the ledger (same date, type and amount, and same statement text when known) are skipped. */
function dedupe(existing, incoming) {
  const pool = existing.map((t) => ({ key: txnKey(t), raw: t.source?.raw ? rawKey(t.source.raw) : null }));
  const fresh = [];
  const dupes = [];
  for (const t of incoming) {
    const k = txnKey(t);
    const rk = rawKey(t.source?.raw);
    const idx = pool.findIndex((p) => p.key === k && (p.raw === null || p.raw === rk));
    if (idx >= 0) {
      pool.splice(idx, 1); // each existing row can only cancel out one incoming row
      dupes.push(t);
    } else {
      fresh.push(t);
    }
  }
  return { fresh, dupes };
}

/* Without an API key, screenshots wait in inbox/ of the data repo. A scheduled
   Claude Code task (see PROCESS.md in the data repo) reads them, adds the
   transactions with the same rules as below, and messages the owner. */
async function queueImage({ msg, chatId, updateId, fileId }) {
  const image = await downloadImage(fileId);
  const ext = { "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[image.mime] || "jpg";
  const saved = await putNewFile(`inbox/${updateId}.${ext}`, Buffer.from(image.base64, "base64"), `Telegram: screenshot ${updateId} waiting`);
  if (saved) {
    await reply(chatId, "📥 Saved. I'll add these transactions within the hour and message you when it's done.", msg.message_id);
  }
}

async function handleImage({ msg, chatId, updateId, fileId }) {
  if (!process.env.ANTHROPIC_API_KEY) return queueImage({ msg, chatId, updateId, fileId });
  tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  const image = await downloadImage(fileId);
  const result = await extractStatement(image);

  if (!result.is_financial || !result.transactions.length) {
    await reply(chatId, "I couldn't find any transactions in that image." + (result.notes ? `\n\n${result.notes}` : ""), msg.message_id);
    return;
  }

  const batch = `tg${updateId}`;
  const { add, ignored } = toTxns(result.transactions, batch);

  const { result: saved } = await updateLedger((d) => {
    if (d.telegram.seenUpdates.includes(updateId)) return { skip: true, already: true };
    const { fresh, dupes } = dedupe(d.txns, add);
    d.txns.push(...fresh);
    d.telegram.seenUpdates = [...d.telegram.seenUpdates, updateId].slice(-300);
    if (fresh.length) d.telegram.batches = [...d.telegram.batches, batch].slice(-50);
    return { fresh, dupes };
  }, `Telegram: screenshot ${updateId}`);

  if (saved.already) return;
  const { fresh, dupes } = saved;
  const lines = [];
  if (fresh.length) {
    const spent = fresh.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    const got = fresh.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    lines.push(`✅ Added ${fresh.length} transaction${fresh.length === 1 ? "" : "s"}` +
      (spent ? ` · spent ${money(spent)}` : "") + (got ? ` · received ${money(got)}` : ""));
    for (const t of fresh) lines.push(`${t.type === "income" ? "+" : "−"}${money(t.amount)}  ${t.date.slice(5)}  ${t.vendor}`);
  } else {
    lines.push("Nothing new to add.");
  }
  if (dupes.length) lines.push("", `↩︎ Skipped ${dupes.length} already in your ledger.`);
  for (const { r, why } of ignored) {
    lines.push(`⏭ Not added (${why}): ${r.merchant || r.raw_text}${r.amount ? " " + money(r.amount) : ""}`);
  }
  if (result.notes) lines.push("", `Note: ${result.notes}`);
  if (fresh.length) lines.push("", "Wrong? Send /undo to remove these.");
  await reply(chatId, lines.join("\n"), msg.message_id);
}

async function handleUndo(chatId) {
  const { result } = await updateLedger((d) => {
    const batch = d.telegram.batches.at(-1);
    if (!batch) return { skip: true, removed: 0 };
    const before = d.txns.length;
    d.txns = d.txns.filter((t) => t.source?.batch !== batch);
    d.telegram.batches = d.telegram.batches.slice(0, -1);
    return { removed: before - d.txns.length };
  }, "Telegram: undo");
  await reply(chatId, result.removed ? `↩︎ Removed ${result.removed} transaction${result.removed === 1 ? "" : "s"} from the last screenshot.` : "Nothing to undo.");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!telegramSecretOk(req.headers["x-telegram-bot-api-secret-token"])) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  const msg = update.message;
  // Always answer 200 so Telegram doesn't keep re-sending; problems are reported in the chat.
  if (!msg || !msg.chat || !msg.from) return res.status(200).json({ ok: true });
  const chatId = msg.chat.id;

  try {
    const text = (msg.text || "").trim();
    const { data } = await readLedger();
    const ownerId = data.telegram.ownerId;

    if (text.startsWith("/start")) {
      const code = text.slice(6).trim();
      if (code && passcodeOk(code)) {
        await updateLedger((d) => { d.telegram.ownerId = msg.from.id; }, "Telegram: connect owner");
        await reply(chatId, `Connected ✅\n\n${HELP}\n\nYou can delete your /start message now so the passcode isn't left in the chat.`);
      } else if (ownerId === msg.from.id) {
        await reply(chatId, `You're already connected.\n\n${HELP}`);
      } else {
        await reply(chatId, "This bot is private. To connect, send:\n/start YOUR-PASSCODE\n(the same passcode you use to open Ledgerly)");
      }
      return res.status(200).json({ ok: true });
    }

    if (!ownerId || ownerId !== msg.from.id) {
      await reply(chatId, "This bot is private. To connect, send:\n/start YOUR-PASSCODE");
      return res.status(200).json({ ok: true });
    }

    if (text === "/undo") {
      await handleUndo(chatId);
    } else if (msg.photo?.length) {
      const best = msg.photo.reduce((a, b) => ((b.file_size || 0) > (a.file_size || 0) ? b : a));
      await handleImage({ msg, chatId, updateId: update.update_id, fileId: best.file_id });
    } else if (msg.document && /^image\//.test(msg.document.mime_type || "")) {
      await handleImage({ msg, chatId, updateId: update.update_id, fileId: msg.document.file_id });
    } else {
      await reply(chatId, HELP);
    }
  } catch (err) {
    console.error("telegram webhook failed:", err);
    const why = err.userFacing || (err.statusCode && err.statusCode < 500) ? err.message : "Something went wrong saving this.";
    await reply(chatId, `⚠️ ${why} Please try again.`, msg.message_id);
  }
  return res.status(200).json({ ok: true });
}
