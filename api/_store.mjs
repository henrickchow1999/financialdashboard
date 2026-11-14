// Shared ledger storage: one JSON file in a PRIVATE GitHub repo.
//
// Env:
//   GITHUB_TOKEN       fine-grained token with Contents: read & write on the data repo only
//   GITHUB_DATA_REPO   "owner/repo" (default henrickchow1999/ledgerly-data)
//
// Every write sends only this one file through the Contents API, with the sha it
// read. If someone else wrote in between (GitHub answers 409), it re-reads and
// re-applies the change, so the dashboard and the Telegram bot can write at the
// same time without overwriting each other.

const API = "https://api.github.com";
const FILE = "ledger.json";

const EMPTY = () => ({ version: 1, txns: [], telegram: { ownerId: null, seenUpdates: [], batches: [] } });

function repo() {
  return process.env.GITHUB_DATA_REPO || "henrickchow1999/ledgerly-data";
}

function headers() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw Object.assign(new Error("Storage is not configured (GITHUB_TOKEN is not set)."), { statusCode: 503 });
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ledgerly",
  };
}

async function gh(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  return res;
}

function normalize(data) {
  const base = EMPTY();
  if (!data || typeof data !== "object") return base;
  return {
    ...base,
    ...data,
    txns: Array.isArray(data.txns) ? data.txns : [],
    telegram: { ...base.telegram, ...(data.telegram || {}) },
  };
}

/** Read the ledger. Returns { data, sha } (sha is null when the file doesn't exist yet). */
export async function readLedger() {
  const res = await gh(`/repos/${repo()}/contents/${FILE}`);
  if (res.status === 404) {
    // Either the file doesn't exist yet (normal on first use) or the repo is unreachable.
    const repoRes = await gh(`/repos/${repo()}`);
    if (!repoRes.ok) {
      throw Object.assign(
        new Error(`Can't reach the data repo ${repo()} (GitHub ${repoRes.status}). Check GITHUB_TOKEN has access to it.`),
        { statusCode: 502 },
      );
    }
    return { data: EMPTY(), sha: null };
  }
  if (!res.ok) {
    throw Object.assign(new Error(`GitHub read failed (${res.status})`), { statusCode: 502 });
  }
  const meta = await res.json();
  let b64 = meta.content;
  if (!b64 || meta.encoding === "none") {
    // Files over 1 MB come back without inline content; fetch the blob instead.
    const blobRes = await gh(`/repos/${repo()}/git/blobs/${meta.sha}`);
    if (!blobRes.ok) throw Object.assign(new Error(`GitHub blob read failed (${blobRes.status})`), { statusCode: 502 });
    b64 = (await blobRes.json()).content;
  }
  const text = Buffer.from(b64, "base64").toString("utf8");
  return { data: normalize(JSON.parse(text)), sha: meta.sha };
}

/**
 * Apply `mutate(data)` to the latest ledger and save it.
 * `mutate` may return { skip: true } to save nothing; whatever else it returns is passed back.
 */
export async function updateLedger(mutate, message = "Update ledger") {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, sha } = await readLedger();
    const result = (await mutate(data)) || {};
    if (result.skip) return { data, result };

    data.updatedAt = new Date().toISOString();
    const body = {
      message,
      content: Buffer.from(JSON.stringify(data, null, 1)).toString("base64"),
      ...(sha ? { sha } : {}),
    };
    const res = await gh(`/repos/${repo()}/contents/${FILE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { data, result };
    if (res.status === 409 || res.status === 422) {
      // Someone else saved first: wait a moment, re-read, re-apply.
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 700 * (attempt + 1)));
      continue;
    }
    const detail = await res.text().catch(() => "");
    throw Object.assign(new Error(`GitHub write failed (${res.status}) ${detail.slice(0, 200)}`), { statusCode: 502 });
  }
  throw Object.assign(new Error("Too many simultaneous saves, please try again."), { statusCode: 503 });
}

/**
 * Save a new file (e.g. a screenshot waiting to be processed) in the data repo.
 * Returns false if a file already exists at that path (e.g. Telegram re-sent the same message).
 */
export async function putNewFile(path, buffer, message) {
  const res = await gh(`/repos/${repo()}/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: buffer.toString("base64") }),
  });
  if (res.ok) return true;
  if (res.status === 422 || res.status === 409) return false; // already there
  const detail = await res.text().catch(() => "");
  throw Object.assign(new Error(`GitHub upload failed (${res.status}) ${detail.slice(0, 200)}`), { statusCode: 502 });
}

/** Names of the files in a folder of the data repo ([] if the folder doesn't exist). */
export async function listDir(path) {
  const res = await gh(`/repos/${repo()}/contents/${path}`);
  if (res.status === 404) return [];
  if (!res.ok) throw Object.assign(new Error(`GitHub list failed (${res.status})`), { statusCode: 502 });
  const items = await res.json();
  return Array.isArray(items) ? items.map((i) => i.name) : [];
}

/* ---------------- transaction validation ---------------- */

const TYPES = new Set(["income", "expense"]);
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

/** Keep only the fields the dashboard uses, with sane types. Returns null if unusable. */
export function cleanTxn(t) {
  if (!t || typeof t !== "object") return null;
  const id = str(t.id, 64);
  const amount = Math.round(Number(t.amount) * 100) / 100;
  const date = str(t.date, 10);
  if (!id || !TYPES.has(t.type) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amount > 0)) return null;
  const out = {
    id,
    createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
    hasReceipt: !!t.hasReceipt,
    receiptName: str(t.receiptName, 200),
    type: t.type,
    date,
    vendor: str(t.vendor, 200),
    description: str(t.description, 300),
    category: str(t.category, 80),
    amount,
    method: str(t.method, 40),
    notes: str(t.notes, 500),
  };
  if (t.source && typeof t.source === "object") {
    out.source = {
      kind: str(t.source.kind, 20),
      batch: str(t.source.batch, 40),
      raw: str(t.source.raw, 200),
    };
  }
  return out;
}
