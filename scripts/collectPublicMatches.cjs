// Collect one historical page. Matches and pagination progress commit together.
const { randomUUID } = require("node:crypto");
const { resolve } = require("node:path");
const { neon } = require("@neondatabase/serverless");
const { fetchPublicMatches } = require("../generator/fetchPublicMatches.cjs");
const {
    fetchPublicMatchWindow,
    publicMatchWindow,
} = require("../generator/fetchPublicMatchWindow.cjs");

require("dotenv").config({ path: resolve(__dirname, "../.env"), quiet: true });

const NAME = "opendota-ranked-all-pick-v1";

class CollectorDatabaseError extends Error { }

async function query(run) {
    try {
        const sql = neon(process.env.DATABASE_URL, {
            fetchOptions: { signal: AbortSignal.timeout(10000) },
        });

        return await run(sql);
    } catch {
        // Raw connection errors can contain credentials.
        throw new CollectorDatabaseError(
            "Public-match database operation failed. Check DATABASE_URL and migrations 005–006."
        );
    }
}

async function collectPublicMatches(initialCursor = null, windowHour = null) {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required.");
    }

    if (initialCursor !== null && (
        typeof initialCursor !== "string" || !/^[1-9][0-9]{0,15}$/.test(initialCursor)
        || BigInt(initialCursor) > BigInt(Number.MAX_SAFE_INTEGER)
    )) {
        throw new Error("The initial cursor must be a positive, safe decimal match ID.");
    }

    let name = NAME;

    if (windowHour !== null) {
        publicMatchWindow(windowHour);

        if (initialCursor !== null) {
            throw new Error(
                "Hourly collection starts automatically; omit the initial cursor."
            );
        }

        name = `${NAME}:hour:${windowHour}`;

        await query(sql => sql`
            INSERT INTO public.public_match_collection (name)
            VALUES (${name})
            ON CONFLICT (name) DO NOTHING
        `);
    }

    const token = randomUUID();

    const claimed = await query(sql => sql`
        UPDATE public.public_match_collection
        SET next_match_id = CASE WHEN initialized THEN next_match_id
                                ELSE ${initialCursor}::bigint END,
            initialized = TRUE,
            lease_token = ${token}::uuid,
            lease_expires_at = clock_timestamp() + INTERVAL '2 minutes',
            next_request_at = clock_timestamp() + INTERVAL '2 seconds',
            updated_at = clock_timestamp()
        WHERE name = ${name}
            AND next_request_at <= clock_timestamp()
            AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
            AND (${initialCursor}::text IS NULL OR NOT initialized)
        RETURNING next_match_id::text AS cursor
  `);

    if (!claimed.length) {
        const [state] = await query(sql => sql`
            SELECT initialized, next_match_id::text AS cursor,
                GREATEST(next_request_at,
                    COALESCE(lease_expires_at, next_request_at))::text AS retry_at
            FROM public.public_match_collection WHERE name = ${name}
        `);

        if (!state) {
            throw new Error("Collector state is missing. Run migration 005.");
        }

        if (initialCursor !== null && state.initialized) {
            throw new Error("The initial cursor is already set. Rerun without the argument.");
        }

        return {
            status: "not_ready",
            requests: 0,
            nextCursor: state.cursor,
            retryAt: state.retry_at,
        };
    }

    const cursor = claimed[0].cursor;

    try {
        const [budget] = await query(sql => sql`
            SELECT allowed, retry_at::text AS retry_at
            FROM public.reserve_public_match_request(${token}::uuid)
        `);

        if (!budget.allowed) {
            await query(sql => sql`
                UPDATE public.public_match_collection
                SET lease_token = NULL, lease_expires_at = NULL,
                next_request_at = GREATEST(clock_timestamp() + INTERVAL '1 minute',
                ${budget.retry_at}::timestamptz),
                updated_at = clock_timestamp()
                WHERE name = ${name} AND lease_token = ${token}::uuid
            `);

            return {
                status: "budget_exhausted",
                requests: 0,
                nextCursor: cursor,
                retryAt: budget.retry_at,
            };
        }
        const page = windowHour === null
            ? await fetchPublicMatches(cursor)
            : await fetchPublicMatchWindow(windowHour, cursor);

        if (page.skipped.unknownHero > 0) {
            throw new Error("Page contains unknown heroes. Refresh heroes.json before retrying.");
        }

        const next = page.received ? page.nextCursor : cursor;

        const [saved] = await query(sql => sql`
            WITH owned AS MATERIALIZED (
                SELECT name FROM public.public_match_collection
                WHERE name = ${name} AND lease_token = ${token}::uuid
                    AND lease_expires_at > clock_timestamp()
                    AND next_match_id IS NOT DISTINCT FROM ${cursor}::bigint
                FOR UPDATE
            ), incoming AS MATERIALIZED (
                SELECT (value ->> 'matchId')::bigint AS match_id, value AS match_data
                FROM jsonb_array_elements(${JSON.stringify(page.matches)}::jsonb)
            ), conflicts AS MATERIALIZED (
                SELECT i.match_id FROM incoming i
                JOIN public.public_match_samples s USING (match_id)
                WHERE   ROW(s.match_data -> 'radiantHeroIds', s.match_data -> 'direHeroIds',
                          s.match_data -> 'didRadiantWin', s.match_data -> 'startedAt')
                    IS DISTINCT FROM
                        ROW(i.match_data -> 'radiantHeroIds', i.match_data -> 'direHeroIds',
                            i.match_data -> 'didRadiantWin', i.match_data -> 'startedAt')
            ), allowed AS (
                SELECT name FROM owned WHERE NOT EXISTS (SELECT 1 FROM conflicts)
            ), inserted AS (
                INSERT INTO public.public_match_samples (match_id, match_data)
                SELECT i.match_id, i.match_data FROM incoming i CROSS JOIN allowed
                ON CONFLICT (match_id) DO NOTHING
                RETURNING match_id
            ), advanced AS (
                UPDATE public.public_match_collection c
                SET next_match_id = ${next}::bigint,
                    next_request_at = clock_timestamp() + CASE
                        WHEN ${page.received}::integer = 0 THEN INTERVAL '5 minutes'
                        WHEN ${page.remainingRequests.day}::integer <= 100 THEN INTERVAL '1 hour'
                        ELSE INTERVAL '2 seconds' END,
                    lease_token = NULL, lease_expires_at = NULL,
                    updated_at = clock_timestamp()
                FROM allowed WHERE c.name = allowed.name
                RETURNING c.next_match_id::text AS cursor
            )
            SELECT EXISTS(SELECT 1 FROM owned) AS owned,
                EXISTS(SELECT 1 FROM conflicts) AS conflict,
                (SELECT COUNT(*)::integer FROM inserted) AS inserted,
                (SELECT cursor FROM advanced) AS cursor
        `);

        if (!saved.owned) {
            throw new Error("Collector lease lost; this run did not save its page.");
        }

        if (saved.conflict) {
            throw new Error("Conflicting facts for a stored match; the page was not saved.");
        }

        return {
            status: page.received ? "page_saved" : "empty_page",
            requests: 1,
            received: page.received,
            accepted: page.matches.length,
            inserted: saved.inserted,
            alreadyStored: page.matches.length - saved.inserted,
            skipped: page.skipped,
            nextCursor: saved.cursor,
            remainingRequests: page.remainingRequests,
        };
    } catch (error) {
        // Never rewind progress. If a save committed but its reply was lost,
        // that save already released this token, so this UPDATE changes nothing.
        await query(sql => sql`
      UPDATE public.public_match_collection
      SET lease_token = NULL, lease_expires_at = NULL,
          next_request_at = clock_timestamp() + INTERVAL '5 minutes',
          updated_at = clock_timestamp()
      WHERE name = ${name} AND lease_token = ${token}::uuid
    `).catch(() => { });

        throw error;
    }
}

module.exports = { collectPublicMatches };

if (require.main === module) {
    (process.argv.length > 3
        ? Promise.reject(new Error("Usage: node scripts/collectPublicMatches.cjs [initialCursor]"))
        : collectPublicMatches(process.argv[2] ?? null)
    ).then(summary => {
        console.log(JSON.stringify(summary, null, 2));
    }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}