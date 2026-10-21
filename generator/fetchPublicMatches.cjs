const knownHeroes = new Set(require("../heroes.json").map(hero => hero.HeroId));
const ENDPOINT = "https://api.opendota.com/api/publicMatches";

function matchId(value) {
    const text = Number.isSafeInteger(value) ? String(value) : value;

    if (
        typeof text !== "string" || !/^[1-9][0-9]{0,15}$/.test(text)
        || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
        throw new Error("OpenDota match IDs must be positive, safe decimal integers.");
    }

    return text;
}

function normalizePublicMatch(row) {
    const id = matchId(row?.match_id);

    // Keep the initial training population to ranked All Pick.
    if (row.game_mode !== 22 || row.lobby_type !== 7) {
        return { reason: "otherMode" };
    }

    const validTeam = team => Array.isArray(team) && team.length === 5
        && [...team].every(hero => Number.isSafeInteger(hero) && hero > 0);

    const time = Number.isSafeInteger(row.start_time) && row.start_time > 0
        ? row.start_time * 1000
        : NaN;

    if (
        typeof row.radiant_win !== "boolean"
        || !Number.isSafeInteger(row.duration) || row.duration <= 0
        || !Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())
        || !validTeam(row.radiant_team) || !validTeam(row.dire_team)
        || new Set([...row.radiant_team, ...row.dire_team]).size !== 10
    ) {
        return { reason: "incomplete" };
    }

    if ([...row.radiant_team, ...row.dire_team].some(hero => !knownHeroes.has(hero))) {
        return { reason: "unknownHero" };
    }

    const rankCount = Number.isInteger(row.num_rank_tier)
        && row.num_rank_tier >= 1 && row.num_rank_tier <= 10
        ? row.num_rank_tier : null;

    const averageRank = rankCount !== null
        && Number.isFinite(row.avg_rank_tier)
        && row.avg_rank_tier >= 10 && row.avg_rank_tier <= 85
        ? row.avg_rank_tier : null;

    return {
        match: {
            schema: 1,
            matchId: id,
            startedAt: new Date(time).toISOString(),

            // This endpoint does not supply a STRATZ gameVersionId.
            gameVersionId: null,

            radiantHeroIds: [...row.radiant_team].sort((a, b) => a - b),
            direHeroIds: [...row.dire_team].sort((a, b) => a - b),
            didRadiantWin: row.radiant_win,
            metadata: {
                source: "opendota",
                selection: "publicMatches-ranked-all-pick",
                gameMode: row.game_mode,
                lobbyType: row.lobby_type,
                averageRankTier: averageRank,
                playersWithKnownRank: rankCount,
                cluster: Number.isInteger(row.cluster) && row.cluster > 0
                    ? row.cluster : null,

                // Audit/filtering information, never a prediction input.
                durationSeconds: row.duration,
            },
        },
    };
}

async function fetchPublicMatches(lessThanMatchId = null) {
    const cursor = lessThanMatchId === null ? null : matchId(lessThanMatchId);
    const url = new URL(ENDPOINT);

    if (cursor !== null) {
        url.searchParams.set("less_than_match_id", cursor);
    }

    let response;

    try {
        response = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(25000),
        });
    } catch {
        throw new Error("OpenDota request failed or timed out.");
    }

    if (!response.ok) {
        throw new Error(response.status === 429
            ? "OpenDota rate limit reached. Stop and try again later."
            : `OpenDota request failed with HTTP ${response.status}.`);
    }

    let rows;

    try {
        rows = await response.json();
    } catch {
        throw new Error("OpenDota returned unreadable JSON.");
    }

    if (!Array.isArray(rows) || rows.length > 100) {
        throw new Error("OpenDota returned an unexpected match-list response.");
    }

    const ids = rows.map(row => matchId(row?.match_id));

    if (
        new Set(ids).size !== ids.length
        || ids.some((id, index) =>
            (cursor !== null && BigInt(id) >= BigInt(cursor))
            || (index > 0 && BigInt(id) >= BigInt(ids[index - 1])))
    ) {
        throw new Error("OpenDota returned inconsistent pagination; cursor not advanced.");
    }

    const matches = [];
    const skipped = { otherMode: 0, incomplete: 0, unknownHero: 0 };

    for (const row of rows) {
        const result = normalizePublicMatch(row);

        if (result.match) matches.push(result.match);
        else skipped[result.reason]++;
    }

    const remaining = name => {
        const text = response.headers.get(name);

        return text !== null && /^[0-9]+$/.test(text)
            && Number.isSafeInteger(Number(text)) ? Number(text) : null;
    };

    return {
        matches,
        received: rows.length,
        skipped,

        // Use every source row for pagination, including filtered-out matches.
        nextCursor: ids.at(-1) ?? null,

        remainingRequests: {
            minute: remaining("x-rate-limit-remaining-minute"),
            day: remaining("x-rate-limit-remaining-day"),
        },
    };
}

module.exports = { fetchPublicMatches, normalizePublicMatch };