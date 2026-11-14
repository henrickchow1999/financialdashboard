// GET  /api/transactions            -> { txns, updatedAt }
// POST /api/transactions { upsert: [txn...], delete: [id...] } -> { txns, updatedAt }
//
// Every request needs the header  x-ledgerly-passcode: <APP_PASSCODE>

import { passcodeOk } from "./_auth.mjs";
import { readLedger, updateLedger, cleanTxn } from "./_store.mjs";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  try {
    if (!passcodeOk(req.headers["x-ledgerly-passcode"])) {
      return res.status(401).json({ error: "Wrong passcode" });
    }

    if (req.method === "GET") {
      const { data } = await readLedger();
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ txns: data.txns, updatedAt: data.updatedAt || null });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const upserts = (Array.isArray(body.upsert) ? body.upsert : []).map(cleanTxn).filter(Boolean);
      const deletes = new Set((Array.isArray(body.delete) ? body.delete : []).filter((x) => typeof x === "string"));
      if (upserts.length > 5000 || deletes.size > 5000) {
        return res.status(413).json({ error: "Too many changes in one request" });
      }
      if (!upserts.length && !deletes.size) {
        const { data } = await readLedger();
        return res.status(200).json({ txns: data.txns, updatedAt: data.updatedAt || null });
      }

      const { data } = await updateLedger((d) => {
        const byId = new Map(d.txns.map((t) => [t.id, t]));
        for (const t of upserts) byId.set(t.id, { ...(byId.get(t.id) || {}), ...t });
        for (const id of deletes) byId.delete(id);
        d.txns = [...byId.values()];
      }, `Dashboard: ${upserts.length} saved, ${deletes.size} deleted`);

      return res.status(200).json({ txns: data.txns, updatedAt: data.updatedAt });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error("transactions failed:", err);
    return res.status(status).json({ error: status === 500 ? "Something went wrong saving your data." : err.message });
  }
}
