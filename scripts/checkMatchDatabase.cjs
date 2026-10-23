// Check the report, verification and request-budget tables without reading
// saved reports or inserting test data.
const { resolve } = require("node:path");

require("dotenv").config({
    path: resolve(__dirname, "../.env"),
    quiet: true,
});

const { neon } = require("@neondatabase/serverless");

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error("Add DATABASE_URL to the d2dt-dataset .env file first.");
        process.exitCode = 1;
        return;
    }

    const sql = neon(process.env.DATABASE_URL);

    await sql`
    SELECT  draft_id, outcome, reported_at, received_at,
            verification, match_id, payload_sha256, report,
            verification_details
    FROM public.match_reports
    LIMIT 0
  `;

    await sql`
  SELECT match_id, created_at, next_attempt_at, attempts,
         lease_token, lease_expires_at, last_error_code
  FROM public.match_verification_jobs
  LIMIT 0
`;

    await sql`
  SELECT match_id, fetched_at, schema, match_data
  FROM public.stratz_match_cache
  LIMIT 0
`;

    await sql`
  SELECT budget_key, max_per_second, max_per_minute, max_per_hour,
         max_per_day, verification_max_per_hour,
         verification_max_per_day, paused_until
  FROM public.stratz_api_budgets
  LIMIT 0
`;

    await sql`
  SELECT id, budget_key, purpose, reserved_at
  FROM public.stratz_api_reservations
  LIMIT 0
`;

    await sql`
  SELECT allowed, retry_at
  FROM public.reserve_stratz_request('primary', 'dataset')
  LIMIT 0
`;

    console.log(
        "Match-feedback database connection OK; required columns and quota function are accessible."
    );
}

main().catch(error => {
    const explanations = {
        "42P01":
      "A required table is missing. Run database/001_match_reports.sql and database/002_match_verification.sql.",
        "42703":
      "The database columns differ from the SQL files in database/.",
        "42501":
      "The configured database user cannot read a required table.",
        "28P01":
      "Database authentication failed. Check the connection string credentials.",
        "42883":
      "The STRATZ quota function is missing. Run database/003_stratz_rate_limit.sql.",
    };

    // Connection errors can include credentials. Print only our own explanations.
    console.error(
        explanations[error?.code]
    ?? "Database check failed. Check DATABASE_URL, your connection and the database status."
    );

    process.exitCode = 1;
});