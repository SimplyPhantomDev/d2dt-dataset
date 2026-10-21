// Process a small batch of queued match IDs. Cached facts are shared by reports.
const { randomUUID } = require("node:crypto");
const { neon } = require("@neondatabase/serverless");
const { fetchStratzMatch } = require("../server/fetchStratzMatch.cjs");
const { verifyMatchReport } = require("../server/verifyMatchReport.cjs");
const { StratzRateLimitError } = require("../server/stratzApi.cjs");

class VerificationDatabaseError extends Error {}

async function databaseQuery(run) {
  try {
    const sql = neon(process.env.DATABASE_URL, {
      fetchOptions: { signal: AbortSignal.timeout(10000) },
    });
    return await run(sql);
  } catch {
    // Database errors can contain credentials; keep them out of logs.
    throw new VerificationDatabaseError(
      "Verification database operation failed. Check DATABASE_URL and migrations 001–004."
    );
  }
}

async function claimJob() {
  const token = randomUUID();

  const rows = await databaseQuery(sql => sql`
    WITH candidate AS (
      SELECT j.match_id
      FROM public.match_verification_jobs j
      WHERE j.next_attempt_at <= clock_timestamp()
        AND (j.lease_expires_at IS NULL
             OR j.lease_expires_at <= clock_timestamp())
        AND EXISTS (
          SELECT 1 FROM public.match_reports r
          WHERE r.match_id = j.match_id
            AND r.verification = 'unverified'
        )
      ORDER BY j.next_attempt_at, j.created_at, j.match_id
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE public.match_verification_jobs j
    SET lease_token = ${token}::uuid,
        lease_expires_at = clock_timestamp() + INTERVAL '5 minutes',
        attempts = j.attempts + 1
    FROM candidate c
    WHERE j.match_id = c.match_id
    RETURNING j.match_id::text AS match_id, j.attempts
  `);

  return rows[0] ? { ...rows[0], token } : null;
}

async function postponeJob(job, code, retryAt = null) {
  const seconds = Math.min(
    86400,
    300 * 2 ** Math.min(job.attempts - 1, 9)
  );

  const rows = await databaseQuery(sql => sql`
    UPDATE public.match_verification_jobs
    SET next_attempt_at = CASE WHEN ${retryAt}::timestamptz IS NULL
          THEN clock_timestamp()
               + ${seconds}::integer * INTERVAL '1 second'
          ELSE GREATEST(
            clock_timestamp() + INTERVAL '1 minute',
            ${retryAt}::timestamptz
          ) END,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = ${code}
    WHERE match_id = ${job.match_id}::bigint
      AND lease_token = ${job.token}::uuid
      AND lease_expires_at > clock_timestamp()
    RETURNING match_id
  `);

  return rows.length === 1;
}

async function finishJob(job, match, decisions) {
  const rows = await databaseQuery(sql => sql`
    WITH owned AS MATERIALIZED (
      SELECT match_id
      FROM public.match_verification_jobs
      WHERE match_id = ${job.match_id}::bigint
        AND lease_token = ${job.token}::uuid
        AND lease_expires_at > clock_timestamp()
      FOR UPDATE
    ), cached AS (
      INSERT INTO public.stratz_match_cache (
        match_id, schema, match_data
      )
      SELECT match_id, 1, ${JSON.stringify(match)}::jsonb
      FROM owned
      ON CONFLICT (match_id) DO NOTHING
      RETURNING match_id
    ), updated AS (
      UPDATE public.match_reports r
      SET verification = d.verification,
          verification_details = d.details || jsonb_build_object(
            'checkedAt', clock_timestamp()
          )
      FROM jsonb_to_recordset(
        ${JSON.stringify(decisions)}::jsonb
      ) AS d(
        draft_id uuid,
        payload_sha256 text,
        verification text,
        details jsonb
      ), owned
      WHERE r.draft_id = d.draft_id
        AND r.match_id = owned.match_id
        AND r.payload_sha256 = d.payload_sha256
        AND r.verification = 'unverified'
      RETURNING r.verification
    ), released AS (
      UPDATE public.match_verification_jobs j
      SET lease_token = NULL,
          lease_expires_at = NULL,
          next_attempt_at = clock_timestamp(),
          attempts = 0,
          last_error_code = NULL
      FROM owned
      WHERE j.match_id = owned.match_id
      RETURNING j.match_id
    )
    SELECT EXISTS(SELECT 1 FROM released) AS owned,
      (SELECT COUNT(*)::integer FROM updated
       WHERE verification = 'verified') AS verified,
      (SELECT COUNT(*)::integer FROM updated
       WHERE verification = 'rejected') AS rejected
  `);

  return rows[0];
}

async function verifyMatchReports(limit = 5) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("The batch limit must be an integer from 1 to 50.");
  }

  if (!process.env.DATABASE_URL || !process.env.STRATZ_API_TOKEN) {
    throw new Error("DATABASE_URL and STRATZ_API_TOKEN are required.");
  }

  const summary = {
    claimed: 0,
    lookupAttempts: 0,
    cacheHits: 0,
    verified: 0,
    rejected: 0,
    deferred: 0,
    failed: 0,
    lostLeases: 0,
    stopReason: "batch_limit",
  };

  const deadline = performance.now() + 4 * 60 * 1000;

  for (let index = 0; index < limit; index++) {
    if (performance.now() >= deadline) {
      summary.stopReason = "time_limit";
      break;
    }

    const job = await claimJob();

    if (!job) {
      summary.stopReason = "no_due_jobs";
      break;
    }

    summary.claimed++;
    let phase = "cache";

    try {
      const cached = await databaseQuery(sql => sql`
        SELECT match_data
        FROM public.stratz_match_cache
        WHERE match_id = ${job.match_id}::bigint
          AND schema = 1
      `);

      let match = cached[0]?.match_data;

      if (cached.length) {
        summary.cacheHits++;
      } else {
        phase = "fetch";
        summary.lookupAttempts++;
        match = await fetchStratzMatch(job.match_id);
      }

      if (match === null) {
        const owned = await postponeJob(job, "match_unavailable");

        if (owned) summary.deferred++;
        else summary.lostLeases++;

        continue;
      }

      phase = "compare";

      const reports = await databaseQuery(sql => sql`
        SELECT draft_id::text, payload_sha256, report
        FROM public.match_reports
        WHERE match_id = ${job.match_id}::bigint
          AND verification = 'unverified'
        ORDER BY received_at, draft_id
        LIMIT 100
      `);

      const decisions = reports.map(row => {
        const decision = verifyMatchReport(row.report, match);

        if (!["verified", "rejected"].includes(decision.verification)) {
          throw new Error(
            "The stored report is inconsistent with its match ID."
          );
        }

        return {
          draft_id: row.draft_id,
          payload_sha256: row.payload_sha256,
          verification: decision.verification,
          details: { schema: 1, ...decision },
        };
      });

      const saved = await finishJob(job, match, decisions);

      if (!saved.owned) {
        summary.lostLeases++;
      } else {
        summary.verified += saved.verified;
        summary.rejected += saved.rejected;
      }
    } catch (error) {
      if (error instanceof VerificationDatabaseError) throw error;

      const limited = error instanceof StratzRateLimitError;
      const auth = error.status === 401 || error.status === 403;

      let code = phase === "fetch"
        ? "stratz_request_failed"
        : "invalid_match_data";

      if (auth) code = "stratz_auth_failed";
      if (limited) code = "quota_wait";

      const owned = await postponeJob(
        job,
        code,
        limited ? error.retryAt : null
      );

      if (!owned) summary.lostLeases++;
      else summary.deferred++;

      if (!limited) summary.failed++;

      if (limited || auth) {
        summary.stopReason = code;
        break;
      }
    }
  }

  return summary;
}

module.exports = { verifyMatchReports };

if (require.main === module) {
  const argument = process.argv[2] ?? "5";
  const limit = /^[1-9][0-9]?$/.test(argument)
    ? Number(argument)
    : NaN;

  (process.argv.length > 3
    ? Promise.reject(
        new Error("Usage: node scripts/verifyMatchReports.cjs [1–50]")
      )
    : verifyMatchReports(limit)
  ).then(summary => {
    console.log(JSON.stringify(summary, null, 2));

    if (summary.failed > 0) process.exitCode = 1;
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}