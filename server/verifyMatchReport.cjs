// Compare a normalized report with trusted match facts from the future worker.
// This file performs no network requests, database writes or prediction updates.

function validMatchId(value) {
    return typeof value === "string"
    && /^[1-9][0-9]{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
}

function teamKey(ids) {
    if (
        !Array.isArray(ids)
    || ids.length !== 5
    || [...ids].some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(ids).size !== 5
    ) {
        throw new TypeError("A team must contain five different positive hero IDs.");
    }

    // Hero order is irrelevant; team membership must match exactly.
    return [...ids].sort((a, b) => a - b).join(",");
}

function teamKeys(first, second) {
    const keys = [teamKey(first), teamKey(second)];

    if (new Set([...first, ...second]).size !== 10) {
        throw new TypeError("The two teams must contain ten different heroes.");
    }

    return keys;
}

function verifyMatchReport(report, match) {
    if (
        report?.schema !== 1
    || report.draft?.schema !== 1
    || !["ally-win", "ally-loss"].includes(report.outcome)
    ) {
        throw new TypeError("A normalized match report is required.");
    }

    const [ally, enemy] = teamKeys(
        report.draft.allyHeroIds,
        report.draft.enemyHeroIds
    );

    if (report.matchId == null) {
        return { verification: "unverified", reason: "missing_match_id" };
    }

    if (!validMatchId(report.matchId)) {
        throw new TypeError("The report contains an invalid match ID.");
    }

    // Unavailable or not-yet-fetched matches are not evidence of a false report.
    if (match == null) {
        return { verification: "unverified", reason: "match_unavailable" };
    }

    // The worker will construct this cache format from STRATZ, never the client:
    // { schema: 1, matchId: "...", radiantHeroIds: [...],
    //   direHeroIds: [...], didRadiantWin: true | false }
    if (
        match.schema !== 1
    || !validMatchId(match.matchId)
    || typeof match.didRadiantWin !== "boolean"
    ) {
        throw new TypeError("Trusted match data is incomplete or invalid.");
    }

    if (match.matchId !== report.matchId) {
    // A wrong cache entry is a worker error, not grounds to reject the report.
        throw new Error("The cached match ID does not match the report.");
    }

    const [radiant, dire] = teamKeys(
        match.radiantHeroIds,
        match.direHeroIds
    );

    let allySide = null;
    if (ally === radiant && enemy === dire) allySide = "radiant";
    if (ally === dire && enemy === radiant) allySide = "dire";

    if (allySide === null) {
        return { verification: "rejected", reason: "draft_mismatch" };
    }

    const allyWon = allySide === "radiant"
        ? match.didRadiantWin
        : !match.didRadiantWin;
    const confirmedOutcome = allyWon ? "ally-win" : "ally-loss";
    const agrees = report.outcome === confirmedOutcome;

    return {
        verification: agrees ? "verified" : "rejected",
        reason: agrees ? "match_confirmed" : "outcome_mismatch",
        allySide,
        confirmedOutcome,
    };
}

module.exports = { verifyMatchReport };