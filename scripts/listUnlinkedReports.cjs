const { resolve } = require("node:path");

require("dotenv").config({
    path: resolve(__dirname, "../.env"),
    quiet: true,
});

const { neon } = require("@neondatabase/serverless");
const heroes = require("../heroes.json");

const heroNames = new Map(
    heroes.map(hero => [hero.HeroId, hero.name])
);

function names(ids) {
    if (!Array.isArray(ids)) return ["Missing hero list"];

    return ids.map(id =>
        heroNames.get(id) ?? `Unknown hero (${id})`
    );
}

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error(
            "DATABASE_URL is required in the d2dt-dataset .env file."
        );
    }

    let rows;

    try {
        const sql = neon(process.env.DATABASE_URL, {
            fetchOptions: { signal: AbortSignal.timeout(10000) },
        });

        rows = await sql`
      SELECT draft_id::text AS draft_id, outcome,
        report->'draft'->'allyHeroIds' AS ally_ids,
        report->'draft'->'enemyHeroIds' AS enemy_ids
      FROM public.match_reports
      WHERE match_id IS NULL AND verification = 'unverified'
      ORDER BY received_at, draft_id
    `;
    } catch {
        throw new Error(
            "Could not read saved reports. Check DATABASE_URL and the database connection."
        );
    }

    console.log(JSON.stringify(rows.map(row => ({
        draftId: row.draft_id,
        reportedOutcome: row.outcome,
        allies: names(row.ally_ids),
        enemies: names(row.enemy_ids),
    })), null, 2));
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});