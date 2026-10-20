// Check the configured database and required table columns without reading
// match reports or inserting test data. The future API will use the same driver.
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
    SELECT draft_id, outcome, reported_at, received_at,
           verification, match_id, payload_sha256, report
    FROM public.match_reports
    LIMIT 0
  `;

  console.log(
    "Match-feedback database connection OK; required columns are accessible."
  );
}

main().catch(error => {
  const explanations = {
    "42P01":
      "The match_reports table is missing. Run database/001_match_reports.sql first.",
    "42703":
      "The match_reports columns differ from database/001_match_reports.sql.",
    "42501":
      "The configured database user cannot read the match_reports table.",
    "28P01":
      "Database authentication failed. Check the connection string credentials.",
  };

  // Connection errors can include credentials. Print only our own explanations.
  console.error(
    explanations[error?.code]
      ?? "Database check failed. Check DATABASE_URL, your connection and the database status."
  );

  process.exitCode = 1;
});