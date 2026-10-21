// Shared STRATZ access for generators and the future verification worker.
// Reserve quota before sending; uncertain or failed requests stay counted.
const { resolve } = require("node:path");
require("dotenv").config({
  path: resolve(__dirname, "../.env"),
  quiet: true,
});
const { neon } = require("@neondatabase/serverless");

class StratzRateLimitError extends Error {
  constructor(retryAt) {
    super(`STRATZ requests are deferred until ${retryAt}.`);
    this.name = "StratzRateLimitError";
    this.retryAt = retryAt;
    this.status = 429;
  }
}

async function databaseQuery(run) {
  try {
    const sql = neon(process.env.DATABASE_URL, {
      fetchOptions: { signal: AbortSignal.timeout(10000) },
    });
    return await run(sql);
  } catch {
    // Raw database errors can contain the connection credentials.
    throw new Error("STRATZ quota storage is unavailable. Check DATABASE_URL and database migrations.");
  }
}

async function stratzQuery(query, variables = {}, purpose = "dataset") {
  const token = process.env.STRATZ_API_TOKEN;
  if (!token) throw new Error("Missing STRATZ_API_TOKEN.");
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for shared STRATZ quota tracking.");
  if (typeof query !== "string" || !query.trim()) throw new Error("A GraphQL query is required.");
  if (!["dataset", "verification"].includes(purpose)) throw new Error("Unknown STRATZ request purpose.");

  const payload = JSON.stringify({ query, variables });
  const waitDeadline = performance.now() + 60000;

  for (; ;) {
    const rows = await databaseQuery(sql => sql`
      SELECT allowed, retry_at,
             GREATEST(0, EXTRACT(EPOCH FROM (retry_at - clock_timestamp())) * 1000) AS wait_ms
      FROM public.reserve_stratz_request('primary', ${purpose})
    `);
    if (rows[0]?.allowed === true) break;

    const retryAt = new Date(rows[0]?.retry_at);
    if (!rows[0]?.retry_at || !Number.isFinite(retryAt.getTime())) {
      throw new Error("STRATZ quota storage returned an invalid decision.");
    }

    // Dataset jobs can wait briefly for a second/minute window to clear.
    // Verification returns immediately so its worker can release the job.
    const delay = Math.max(25, Math.ceil(Number(rows[0].wait_ms)));
    if (
      purpose !== "dataset"
      || !Number.isFinite(delay)
      || performance.now() + delay > waitDeadline
    ) {
      throw new StratzRateLimitError(retryAt.toISOString());
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  let response;
  try {
    response = await fetch("https://api.stratz.com/graphql", {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "STRATZ_API",
        Authorization: `Bearer ${token}`,
      },
      body: payload,
    });
  } catch {
    throw new Error("STRATZ request failed or timed out; its reservation remains counted.");
  }

  if (response.status === 429) {
    const value = response.headers.get("retry-after") ?? "";
    const numeric = /^[0-9]+$/.test(value);
    const parsedDate = numeric ? NaN : Date.parse(value);
    const until = Number.isFinite(parsedDate)
      ? new Date(parsedDate).toISOString()
      : null;
    const seconds = numeric
      ? Math.max(1, Math.min(Number(value), 2147483647))
      : until ? 1 : 900;

    const paused = await databaseQuery(sql => sql`
      UPDATE public.stratz_api_budgets
      SET paused_until = GREATEST(
        paused_until,
        clock_timestamp() + ${seconds}::integer * INTERVAL '1 second',
        ${until}::timestamptz
      )
      WHERE budget_key = 'primary'
      RETURNING paused_until
    `);
    throw new StratzRateLimitError(new Date(paused[0].paused_until).toISOString());
  }

  if (!response.ok) {
    const error = new Error(`STRATZ returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("STRATZ returned invalid JSON.");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("STRATZ returned an invalid GraphQL response.");
  }
  if (body.errors && (!Array.isArray(body.errors) || body.errors.length > 0)) {
    const detail = JSON.stringify(body.errors).replaceAll(token, "[redacted]").slice(0, 300);
    throw new Error(`STRATZ GraphQL error: ${detail}`);
  }

  return body;
}

module.exports = { stratzQuery, StratzRateLimitError };