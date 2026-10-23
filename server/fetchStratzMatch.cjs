const { stratzQuery } = require("./stratzApi.cjs");

function checkMatchId(matchId) {
    if (
        typeof matchId !== "string"
    || matchId !== matchId.trim()
    || !/^[1-9][0-9]{0,18}$/.test(matchId)
    || BigInt(matchId) > 9223372036854775807n
    ) {
        throw new TypeError(
            "A positive decimal match ID within BIGINT range is required."
        );
    }
}

function normalizeStratzMatch(raw, matchId) {
    checkMatchId(matchId);

    if (raw === null) return null;

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("STRATZ returned invalid match data.");
    }

    // Never convert a large numeric ID after JavaScript has rounded it.
    const returnedId = Number.isSafeInteger(raw.id)
        ? String(raw.id)
        : raw.id;

    if (typeof returnedId !== "string" || returnedId !== matchId) {
        throw new Error("STRATZ returned a different or unsafe match ID.");
    }

    // Partial records remain unavailable; they must not reject a user's report.
    if (
        typeof raw.didRadiantWin !== "boolean"
    || !Array.isArray(raw.players)
    || raw.players.length !== 10
    || [...raw.players].some(player =>
        !Number.isSafeInteger(player?.heroId)
      || player.heroId <= 0
      || typeof player.isRadiant !== "boolean"
    )
    || new Set(raw.players.map(player => player.heroId)).size !== 10
    || !Number.isSafeInteger(raw.startDateTime)
    || raw.startDateTime <= 0
    || !Number.isSafeInteger(raw.durationSeconds)
    || raw.durationSeconds <= 0
    || !Number.isSafeInteger(raw.gameVersionId)
    || raw.gameVersionId <= 0
    ) {
        return null;
    }

    const startedAt = new Date(raw.startDateTime * 1000);

    if (!Number.isFinite(startedAt.getTime())) return null;

    const radiantHeroIds = raw.players
        .filter(player => player.isRadiant)
        .map(player => player.heroId)
        .sort((a, b) => a - b);

    const direHeroIds = raw.players
        .filter(player => !player.isRadiant)
        .map(player => player.heroId)
        .sort((a, b) => a - b);

    if (radiantHeroIds.length !== 5 || direHeroIds.length !== 5) {
        return null;
    }

    return {
        schema: 1,
        matchId,
        radiantHeroIds,
        direHeroIds,
        didRadiantWin: raw.didRadiantWin,
        startedAt: startedAt.toISOString(),
        durationSeconds: raw.durationSeconds,
        // STRATZ's numeric version ID, not a patch label such as "7.41f".
        gameVersionId: raw.gameVersionId,
    };
}

async function fetchStratzMatch(matchId) {
    checkMatchId(matchId);

    // The validated digits-only ID is safe as a GraphQL integer literal.
    // Keeping it as text avoids rounding through JavaScript's Number type.
    const query = `
    query VerifyMatch {
      match(id: ${matchId}) {
        id
        didRadiantWin
        startDateTime
        durationSeconds
        gameVersionId
        players {
          heroId
          isRadiant
        }
      }
    }
  `;

    const body = await stratzQuery(query, {}, "verification");

    if (!body?.data || !Object.hasOwn(body.data, "match")) {
        throw new Error("STRATZ did not return the requested match field.");
    }

    return normalizeStratzMatch(body.data.match, matchId);
}

module.exports = { fetchStratzMatch, normalizeStratzMatch };