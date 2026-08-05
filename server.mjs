// Local dev server: serves index.html and implements /api/scan-receipt,
// so the app behaves the same on localhost as it does deployed on Vercel.
//
//   ANTHROPIC_API_KEY=... node server.mjs
//
// The key is read from the environment (or a .env.local file beside this script)
// and never leaves the server process.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;

// Minimal .env.local loader so the key can live in a gitignored file.
const envFile = join(HERE, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function readBody(req, limitBytes = 12_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/scan-receipt") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      return res.end(JSON.stringify({ error: "Method not allowed" }));
    }
    try {
      // Imported lazily so the static server still boots without node_modules.
      const { handleScanRequest } = await import("./api/_extract.mjs");
      const result = await handleScanRequest(JSON.parse(await readBody(req)));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.statusCode || 500;
      const isInternal = status >= 500 && status !== 503;
      if (isInternal) console.error("scan-receipt failed:", err);
      else if (status === 503) console.warn("scan-receipt: ANTHROPIC_API_KEY not set — returning manual-entry fallback");
      res.writeHead(status, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        error: isInternal
          ? "Receipt scanning failed. Please enter the details manually."
          : err.message,
      }));
    }
  }

  // Static files, confined to this directory.
  const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(HERE, rel);
  if (!filePath.startsWith(HERE)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
});

server.listen(PORT, () => {
  const configured = process.env.ANTHROPIC_API_KEY ? "enabled" : "NOT configured — manual entry only";
  console.log(`Ledgerly running at http://localhost:${PORT}`);
  console.log(`Receipt scanning: ${configured}`);
});
