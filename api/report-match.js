// Receive one saved match result, validate it, then store it in Neon.
// A repeated upload succeeds without replacing the original report.
const { createHash } = require("node:crypto");
const { neon } = require("@neondatabase/serverless");
const heroes = require("../heroes.json");
const {
  MatchReportError,
  normalizeMatchReport,
} = require("../server/matchReports.cjs");

const allowedHeroIds = new Set(
  heroes.map(hero => Number(hero.HeroId))
);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");

    return res.status(405).json({
      ok: false,
      error: "Use POST to submit a match report.",
    });
  }

  if (
    process.env.MATCH_REPORTS_ENABLED !== "true"
    || !process.env.DATABASE_URL
  ) {
    return res.status(503).json({
      ok: false,
      error: "Match reporting is unavailable.",
    });
  }

  const contentType = String(req.headers["content-type"] ?? "")
    .split(";")[0].trim().toLowerCase();

  if (contentType !== "application/json") {
    return res.status(415).json({
      ok: false,
      error: "Send the report as application/json.",
    });
  }

  let report;

  try {
    // Vercel's body getter can itself throw for malformed JSON.
    report = normalizeMatchReport(req.body, allowedHeroIds);
  } catch (error) {
    const known = error instanceof MatchReportError;

    return res.status(known ? error.status : 400).json({
      ok: false,
      error: known ? error.message : "The report must be valid JSON.",
    });
  }

  const serialized = JSON.stringify(report);
  const hash = createHash("sha256")
    .update(serialized)
    .digest("hex");

  try {
    const sql = neon(process.env.DATABASE_URL, {
      fetchOptions: {
        signal: AbortSignal.timeout(10000),
      },
    });

    const inserted = await sql`
  INSERT INTO public.match_reports
    (draft_id, outcome, reported_at, payload_sha256, report, match_id)
  VALUES
    (
      ${report.draftId}::uuid,
      ${report.outcome},
      ${report.reportedAt}::timestamptz,
      ${hash},
      ${serialized}::jsonb,
      ${report.matchId ?? null}::bigint
    )
  ON CONFLICT (draft_id) DO NOTHING
  RETURNING draft_id
`;

    if (inserted.length === 0) {
      const existing = await sql`
        SELECT payload_sha256
        FROM public.match_reports
        WHERE draft_id = ${report.draftId}::uuid
      `;

      if (!existing.length) {
        throw new Error("The stored report could not be read.");
      }

      if (existing[0].payload_sha256 !== hash) {
        return res.status(409).json({
          ok: false,
          error: "A different report already exists for this draft ID.",
        });
      }
    }

    return res.status(inserted.length ? 201 : 200).json({
      ok: true,
      draftId: report.draftId,
      duplicate: inserted.length === 0,
    });
  } catch (error) {
    // Full database errors may contain connection credentials.
    const code = /^[A-Z0-9]{5}$/.test(error?.code)
      ? error.code
      : "unknown";

    console.error("[match-feedback] Database request failed", { code });

    return res.status(503).json({
      ok: false,
      error: "The report could not be stored. Please retry later.",
    });
  }
};