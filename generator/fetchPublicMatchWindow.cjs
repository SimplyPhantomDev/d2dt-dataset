const { normalizePublicMatch } = require("./fetchPublicMatches.cjs");

function publicMatchWindow(hour) {
    const start = typeof hour === "string"
        && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour)
        ? Date.parse(`${hour}:00:00.000Z`)
        : NaN;

    if (
        !Number.isFinite(start) || start <= 0
        || new Date(start).toISOString() !== `${hour}:00:00.000Z`
    ) {
        throw new Error(
            "Use a valid UTC hour: YYYY-MM-DDTHH, for example 2026-10-17T06."
        );
    }

    const end = start + 3600000;

    if (end > Date.now() - 86400000) {
        throw new Error(
            "The collection hour must have ended at least 24 hours ago."
        );
    }

    return { start: start / 1000, end: end / 1000 };
}

async function fetchPublicMatchWindow(hour, cursor = null) {
    const window = publicMatchWindow(hour);

    if (cursor !== null && (
        typeof cursor !== "string" || !/^[1-9][0-9]{0,15}$/.test(cursor)
        || BigInt(cursor) > BigInt(Number.MAX_SAFE_INTEGER)
    )) {
        throw new Error(
            "The window cursor must be a positive, safe decimal match ID."
        );
    }

    // Interpolated values are validated integers; callers cannot supply SQL.
    const sql = `
        SELECT p.match_id::text AS match_id,
            p.start_time::double precision AS start_time,
            p.duration, p.radiant_win, p.game_mode, p.lobby_type,
            p.avg_rank_tier, p.num_rank_tier, p.cluster,
            p.radiant_team, p.dire_team
        FROM public_matches p
        WHERE p.start_time >= ${window.start}
            AND p.start_time < ${window.end}
            AND p.game_mode = 22 AND p.lobby_type = 7
            ${cursor === null ? "" : `AND p.match_id < ${cursor}`}
        ORDER BY p.match_id DESC LIMIT 100
    `;

    const url = new URL("https://api.opendota.com/api/explorer");
    url.searchParams.set("sql", sql);

    let response;

    try {
        response = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(25000),
        });
    } catch {
        throw new Error("OpenDota window request failed or timed out.");
    }

    if (!response.ok) {
        throw new Error(
            `OpenDota window request failed with HTTP ${response.status}.`
        );
    }

    let body;

    try {
        body = await response.json();
    } catch {
        throw new Error("OpenDota returned unreadable window JSON.");
    }

    if (
        !body || body.err != null
        || !Array.isArray(body.rows) || body.rows.length > 100
    ) {
        throw new Error("OpenDota returned an unexpected window response.");
    }

    const rows = body.rows;

    // The existing normalizer also validates every match ID.
    const results = rows.map(normalizePublicMatch);
    const ids = rows.map(row => String(row.match_id));

    if (
        new Set(ids).size !== ids.length
        || ids.some((id, index) =>
            (cursor !== null && BigInt(id) >= BigInt(cursor))
            || (index > 0 && BigInt(id) >= BigInt(ids[index - 1])))
    ) {
        throw new Error("OpenDota returned inconsistent window pagination.");
    }

    if (rows.some(row =>
        !Number.isSafeInteger(row.start_time)
        || row.start_time < window.start
        || row.start_time >= window.end
        || row.game_mode !== 22
        || row.lobby_type !== 7
    )) {
        throw new Error(
            "OpenDota returned a match outside the requested window or mode."
        );
    }

    const matches = [];
    const skipped = { otherMode: 0, incomplete: 0, unknownHero: 0 };

    for (const result of results) {
        if (result.match) {
            result.match.metadata.selection = "explorer-hour-ranked-all-pick-v1";
            result.match.metadata.sampleHour = hour;
            matches.push(result.match);
        } else {
            skipped[result.reason]++;
        }
    }

    const remaining = name => {
        const value = response.headers.get(name);

        return value !== null && /^[0-9]+$/.test(value)
            && Number.isSafeInteger(Number(value))
            ? Number(value)
            : null;
    };

    return {
        matches,
        received: rows.length,
        skipped,
        nextCursor: ids.at(-1) ?? null,
        remainingRequests: {
            minute: remaining("x-rate-limit-remaining-minute"),
            day: remaining("x-rate-limit-remaining-day"),
        },
    };
}

module.exports = { fetchPublicMatchWindow, publicMatchWindow };