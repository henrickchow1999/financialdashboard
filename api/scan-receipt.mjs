import { handleScanRequest } from "./_extract.mjs";

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const result = await handleScanRequest(body);
    return res.status(200).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    const isInternal = status >= 500 && status !== 503;
    if (isInternal) console.error("scan-receipt failed:", err);
    return res.status(status).json({
      error: isInternal ? "Receipt scanning failed. Please enter the details manually." : err.message,
    });
  }
}
