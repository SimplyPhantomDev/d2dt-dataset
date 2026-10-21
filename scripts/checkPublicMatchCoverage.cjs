const { resolve } = require("node:path");
const { neon } = require("@neondatabase/serverless");

require("dotenv").config({
    path: resolve(__dirname, "../.env"),
    quiet: true,
});

async function checkPublicMatchCoverage() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required.");
    }

    try {
        const sql = neon(process.env.DATABASE_URL, {
            fetchOptions: { signal: AbortSignal.timeout(30000) },
        });

        const [result] = await sql`
        WITH matches AS MATERIALIZED (
            SELECT
                (match_data ->> 'startedAt')::timestamptz AS started_at,
                match_data ->> 'gameVersionId' AS game_version_id,
                (match_data #>> '{metadata,averageRankTier}')::numeric AS average_rank,
                (match_data #>> '{metadata,playersWithKnownRank}')::integer AS known_ranks
            FROM public.public_match_samples
        ), hours AS MATERIALIZED (
            SELECT
                date_trunc('hour', started_at AT TIME ZONE 'UTC') AS hour,
                COUNT(*)::integer AS matches
            FROM matches
            WHERE started_at IS NOT NULL
            GROUP BY 1
        ), days AS (
            SELECT
                to_char(hour, 'YYYY-MM-DD') AS day,
                SUM(matches)::integer AS matches,
                COUNT(*)::integer AS observed_hours
            FROM hours
            GROUP BY 1
        ), gaps AS (
            SELECT GREATEST(
                EXTRACT(EPOCH FROM (
                    hour - LAG(hour) OVER (ORDER BY hour)
                )) / 3600 - 1,
                0
            )::integer AS missing_hours
            FROM hours
        )
        SELECT jsonb_build_object(
            'matches', COUNT(*)::integer,
            'missingStartTimes', COUNT(*) FILTER (
                WHERE started_at IS NULL
            )::integer,
            'earliestMatch', to_char(
                MIN(started_at) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'latestMatch', to_char(
                MAX(started_at) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'startTimeSpanSeconds', COALESCE(
                EXTRACT(EPOCH FROM (
                    MAX(started_at) - MIN(started_at)
                ))::bigint,
                0
            ),
            'observedDays', (SELECT COUNT(*)::integer FROM days),
            'observedHours', (SELECT COUNT(*)::integer FROM hours),
            'unobservedHoursWithinSpan', (
                SELECT COALESCE(
                    (
                        EXTRACT(EPOCH FROM (MAX(hour) - MIN(hour))) / 3600
                        + 1 - COUNT(*)
                    )::integer,
                    0
                )
                FROM hours
            ),
            'largestUnobservedHourGap', COALESCE(
                (SELECT MAX(missing_hours) FROM gaps),
                0
            ),
            'withoutGameVersionId', COUNT(*) FILTER (
                WHERE game_version_id IS NULL
            )::integer,
            'rankCoverage', jsonb_build_object(
                'withAverageRank', COUNT(*) FILTER (
                    WHERE average_rank IS NOT NULL
                )::integer,
                'withAtLeastFiveKnownRanks', COUNT(*) FILTER (
                    WHERE average_rank IS NOT NULL AND known_ranks >= 5
                )::integer,
                'withoutAverageRank', COUNT(*) FILTER (
                    WHERE average_rank IS NULL
                )::integer
            ),
            'byUtcDay', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'day', day,
                        'matches', matches,
                        'observedHours', observed_hours
                    )
                    ORDER BY day
                )
                FROM days
            ), '[]'::jsonb)
        ) AS coverage
        FROM matches
    `;

        return result.coverage;
    } catch {
        // Raw database errors can contain credentials.
        throw new Error(
            "Could not inspect public-match coverage. Check DATABASE_URL, migration 005 and stored match timestamps."
        );
    }
}

module.exports = { checkPublicMatchCoverage };

if (require.main === module) {
    checkPublicMatchCoverage().then(summary => {
        console.log(JSON.stringify(summary, null, 2));
    }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}