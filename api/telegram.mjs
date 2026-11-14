// Telegram bot webhook. Screenshots of transactions (or receipt photos) are saved
// to inbox/ in the private data repo; a scheduled Claude Code task (see
// PROCESS.md in that repo) reads them, adds the transactions, and messages the
// owner. This file never calls the Claude API.
//
// Commands:  /start <passcode>  connect this Telegram account (only that account is accepted after)
//            /undo              remove what the last screenshot added
//            /help
//
// Env: TELEGRAM_BOT_TOKEN, APP_PASSCODE, GITHUB_TOKEN
//      LEDGERLY_FIRE_URL, LEDGERLY_FIRE_TOKEN: the Claude Code scheduled task's API
//      trigger (claude.ai/code/routines). When set, the bot starts the task as soon
//      as screenshots arrive. It runs on the owner's Claude subscription.

import { telegramSecretOk, passcodeOk } from "./_auth.mjs";
import { readLedger, updateLedger, putNewFile, listDir } from "./_store.mjs";

export const config = { maxDuration: 60 };

const MAX_IMAGE_BYTES = 5_000_000;
const HELP =
  "Send me a screenshot of your card/bank transactions, or a photo of a receipt, and I'll add them to Ledgerly within the hour.\n\n" +
  "• Duplicates (e.g. overlapping screenshots) are skipped automatically.\n" +
  "• Card bill payments and transfers between your own accounts are not added.\n" +
  "• /undo removes whatever the last screenshot added.\n" +
  "• /process starts processing now if something is still waiting."

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

const FIRE_DELAY_MS = 12_000; // photos sent together arrive within a few seconds
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fireConfigured = () =>
  /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/.test(process.env.LEDGERLY_FIRE_URL || "") &&
  !!process.env.LEDGERLY_FIRE_TOKEN;

/** Start the Claude Code task that processes the inbox (runs on the owner's subscription). */
async function fireProcessing() {
  const res = await fetch(process.env.LEDGERLY_FIRE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LEDGERLY_FIRE_TOKEN}`,
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Starting the processing task failed (${res.status}) ${detail.slice(0, 200)}`);
  }
}

const inboxIds = async () =>
  (await listDir("inbox")).filter((n) => /\.(jpe?g|png|webp|gif)$/i.test(n)).map((n) => Number(n.split(".")[0])).filter(Number.isFinite);

/* Save the screenshot to the inbox, then (after a short wait, so photos sent
   together are all saved) start the processing task once. */
async function queueImage({ msg, chatId, updateId, fileId }) {
  const image = await downloadImage(fileId);
  const ext = { "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[image.mime] || "jpg";
  const saved = await putNewFile(`inbox/${updateId}.${ext}`, Buffer.from(image.base64, "base64"), `Telegram: screenshot ${updateId} waiting`);
  if (!saved) return; // Telegram re-sent a message we already have

  if (!fireConfigured()) {
    await reply(chatId, "📥 Saved. It'll be added the next time the inbox is processed.", msg.message_id);
    return;
  }
  await reply(chatId, "📥 Saved. I'll add it in a few minutes and message you when it's done.", msg.message_id);
  await sleep(FIRE_DELAY_MS);
  const ids = await inboxIds();
  if (ids.length && Math.max(...ids) !== updateId) return; // a later photo will start the task
  try {
    await fireProcessing();
  } catch (err) {
    console.error(err);
    await reply(chatId, "⚠️ Saved, but I couldn't start processing. Send /process to try again.");
  }
}

async function handleProcess(chatId) {
  if (!fireConfigured()) {
    await reply(chatId, "Automatic processing isn't set up yet (LEDGERLY_FIRE_URL / LEDGERLY_FIRE_TOKEN in Vercel).");
    return;
  }
  const waiting = (await inboxIds()).length;
  if (!waiting) { await reply(chatId, "Nothing is waiting. Everything you sent has been added."); return; }
  await fireProcessing();
  await reply(chatId, `⏳ Processing ${waiting} screenshot${waiting === 1 ? "" : "s"} now. I'll message you when it's done.`);
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
    } else if (text === "/process") {
      await handleProcess(chatId);
    } else if (msg.photo?.length) {
      const best = msg.photo.reduce((a, b) => ((b.file_size || 0) > (a.file_size || 0) ? b : a));
      await queueImage({ msg, chatId, updateId: update.update_id, fileId: best.file_id });
    } else if (msg.document && /^image\//.test(msg.document.mime_type || "")) {
      await queueImage({ msg, chatId, updateId: update.update_id, fileId: msg.document.file_id });
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
