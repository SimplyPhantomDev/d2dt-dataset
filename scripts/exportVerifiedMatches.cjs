// Export confirmed match facts for training. This script only reads Neon.
const { resolve, dirname, relative } = require("node:path");
const { mkdir, writeFile, rename, rm } = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { neon } = require("@neondatabase/serverless");

const ROOT = resolve(__dirname, "..");
const OUTPUT = resolve(ROOT, "training-data/verifiedMatches.jsonl");

require("dotenv").config({ path: resolve(ROOT, ".env"), quiet: true });

class ExportError extends Error {}

function normalizeTrainingMatch(row) {
  const match = row?.match_data;
  const validId = typeof row?.match_id === "string"
    && /^[1-9][0-9]{0,18}$/.test(row.match_id)
    && BigInt(row.match_id) <= 9223372036854775807n;

  const validTeam = team => Array.isArray(team)
    && team.length === 5
    && [...team].every(id => Number.isSafeInteger(id) && id > 0);

  const time = typeof match?.startedAt === "string"
    ? Date.parse(match.startedAt)
    : NaN;

  if (
    !validId || match?.schema !== 1
    || match.matchId !== row.match_id
    || typeof match.didRadiantWin !== "boolean"
    || !validTeam(match.radiantHeroIds)
    || !validTeam(match.direHeroIds)
    || new Set([...match.radiantHeroIds, ...match.direHeroIds]).size !== 10
    || !Number.isFinite(time) || time <= 0
    || new Date(time).toISOString() !== match.startedAt
    || !Number.isSafeInteger(match.gameVersionId) || match.gameVersionId <= 0
    || !Number.isSafeInteger(match.durationSeconds) || match.durationSeconds <= 0
  ) {
    throw new ExportError("Invalid cached match facts; export was not replaced.");
  }

  // Whitelist fields: client predictions and reported outcomes are excluded.
  return {
    schema: 1,
    matchId: row.match_id,
    startedAt: match.startedAt,
    gameVersionId: match.gameVersionId,
    radiantHeroIds: [...match.radiantHeroIds].sort((a, b) => a - b),
    direHeroIds: [...match.direHeroIds].sort((a, b) => a - b),
    didRadiantWin: match.didRadiantWin,
    metadata: {
      source: "stratz",
      selection: "verified-report",
      // Post-match audit information, never a prediction input.
      durationSeconds: match.durationSeconds,
    },
  };
}

async function readVerifiedMatches() {
  if (!process.env.DATABASE_URL) {
    throw new ExportError("Add DATABASE_URL to the repository's .env file.");
  }

  try {
    const sql = neon(process.env.DATABASE_URL, {
      fetchOptions: { signal: AbortSignal.timeout(30000) },
    });

    // EXISTS avoids duplicating a match when multiple reports are verified.
    // One SELECT keeps facts and report eligibility in the same snapshot.
    return await sql`
      SELECT c.match_id::text AS match_id, c.match_data
      FROM public.stratz_match_cache c
      WHERE c.schema = 1
        AND EXISTS (
          SELECT 1 FROM public.match_reports r
          WHERE r.match_id = c.match_id
            AND r.verification = 'verified'
        )
      ORDER BY c.match_id
    `;
  } catch {
    // Database errors may contain credentials; never print their raw text.
    throw new ExportError(
      "Could not read verified matches. Check DATABASE_URL and migrations 001–004."
    );
  }
}

async function exportVerifiedMatches(output = OUTPUT) {
  const rows = await readVerifiedMatches();
  const matches = rows.map(normalizeTrainingMatch);

  // Actual match time determines chronology, not the date of the upload.
  matches.sort((a, b) => a.startedAt.localeCompare(b.startedAt)
    || a.matchId.length - b.matchId.length
    || a.matchId.localeCompare(b.matchId));

  const gameVersions = {};
  for (const match of matches) {
    gameVersions[match.gameVersionId] = (gameVersions[match.gameVersionId] ?? 0) + 1;
  }

  // JSONL stores one independent JSON object per line.
  const content = matches.map(match => JSON.stringify(match)).join("\n")
    + (matches.length ? "\n" : "");

  const temporary = `${output}.${randomUUID()}.tmp`;

  try {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });

    // Replace the previous export only after the new file is fully written.
    await rename(temporary, output);
  } catch {
    throw new ExportError(
      "Could not save the training export. Check folder permissions and free space."
    );
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }

  return {
    file: relative(ROOT, output).replaceAll("\\", "/"),
    matches: matches.length,
    gameVersions,
    earliestMatch: matches[0]?.startedAt ?? null,
    latestMatch: matches.at(-1)?.startedAt ?? null,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

module.exports = { exportVerifiedMatches, normalizeTrainingMatch };

if (require.main === module) {
  exportVerifiedMatches().then(summary => {
    console.log(JSON.stringify(summary, null, 2));
  }).catch(error => {
    console.error(error instanceof ExportError
      ? error.message
      : "Training export failed unexpectedly; export was not replaced.");
    process.exitCode = 1;
  });
}