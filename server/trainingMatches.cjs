const { createPatchResolver } = require("./matchPatch.cjs");

class TrainingExportError extends Error { }

function invalid(message) {
    throw new TrainingExportError(message);
}

function normalizeMatch(id, match, source) {
    const publicMatch = source === "opendota";
    const validTeam = team => Array.isArray(team) && team.length === 5
        && [...team].every(hero => Number.isSafeInteger(hero) && hero > 0);
    const time = typeof match?.startedAt === "string" ? Date.parse(match.startedAt) : NaN;
    const duration = publicMatch ? match?.metadata?.durationSeconds : match?.durationSeconds;

    if (match?.schema !== 1 || match.matchId !== id
        || typeof match.didRadiantWin !== "boolean"
        || !validTeam(match.radiantHeroIds) || !validTeam(match.direHeroIds)
        || new Set([...match.radiantHeroIds, ...match.direHeroIds]).size !== 10
        || !Number.isFinite(time) || time <= 0 || new Date(time).toISOString() !== match.startedAt
        || !Number.isSafeInteger(duration) || duration <= 0
        || (publicMatch
            ? match.gameVersionId !== null || BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER)
            : !Number.isSafeInteger(match.gameVersionId) || match.gameVersionId <= 0)) {
        invalid(`Invalid ${source} facts for match ${id}. No export was saved.`);
    }

    let publicContext = null;
    if (publicMatch) {
        const m = match.metadata;
        const hourly = m.selection === "explorer-hour-ranked-all-pick-v1";
        const validRank = m.averageRankTier === null || (typeof m.averageRankTier === "number"
            && Number.isFinite(m.averageRankTier) && m.averageRankTier >= 10 && m.averageRankTier <= 85);
        const validCount = m.playersWithKnownRank === null
            || (Number.isSafeInteger(m.playersWithKnownRank)
                && m.playersWithKnownRank >= 1 && m.playersWithKnownRank <= 10);

        if (m.source !== "opendota" || m.gameMode !== 22 || m.lobbyType !== 7
            || (!hourly && m.selection !== "publicMatches-ranked-all-pick")
            || !validRank || !validCount
            || (m.averageRankTier !== null && m.playersWithKnownRank === null)
            || (m.cluster !== null && (!Number.isSafeInteger(m.cluster) || m.cluster <= 0))
            || (hourly && m.sampleHour !== match.startedAt.slice(0, 13))) {
            invalid(`Invalid public context for match ${id}. No export was saved.`);
        }

        // Keep sampling context even when a verified STRATZ record is preferred.
        publicContext = {
            selection: m.selection,
            gameMode: m.gameMode,
            lobbyType: m.lobbyType,
            averageRankTier: m.averageRankTier,
            playersWithKnownRank: m.playersWithKnownRank,
            cluster: m.cluster,
            sampleHour: hourly ? m.sampleHour : null,
            durationSeconds: duration,
        };
    }

    return {
        startedAt: match.startedAt,
        gameVersionId: match.gameVersionId,
        radiantHeroIds: [...match.radiantHeroIds].sort((a, b) => a - b),
        direHeroIds: [...match.direHeroIds].sort((a, b) => a - b),
        didRadiantWin: match.didRadiantWin,
        durationSeconds: duration,
        publicContext,
    };
}

function buildTrainingDataset(rows, timeline) {
    const resolvePatch = createPatchResolver(timeline);
    if (!Array.isArray(rows)) invalid("Invalid database response. No export was saved.");

    const matches = [], unresolvedMatches = [], seen = new Set();
    const summary = {
        publicMatches: 0, verifiedMatches: 0, overlappingMatches: 0,
        uniqueMatches: 0, trainingMatches: 0, unresolvedMatches: 0,
        byInferredPatch: {}, unresolvedReasons: {},
        earliestMatch: null, latestMatch: null,
    };

    for (const row of rows) {
        const id = row?.match_id;
        if (typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id)
            || BigInt(id) > 9223372036854775807n || seen.has(id)
            || (row.public_data == null && row.verified_data == null)) {
            invalid("Invalid or repeated match ID in database response. No export was saved.");
        }

        seen.add(id);
        const p = row.public_data == null ? null : normalizeMatch(id, row.public_data, "opendota");
        const v = row.verified_data == null ? null : normalizeMatch(id, row.verified_data, "stratz");

        if (p && v) {
            const core = ["startedAt", "radiantHeroIds", "direHeroIds", "didRadiantWin"];
            if (core.some(key => JSON.stringify(p[key]) !== JSON.stringify(v[key]))) {
                invalid(`Sources disagree on the draft, winner or start time for match ${id}. No export was saved.`);
            }
            summary.overlappingMatches++;
        }

        if (p) summary.publicMatches++;
        if (v) summary.verifiedMatches++;

        const preferred = v ?? p;
        const patch = resolvePatch(preferred.startedAt);
        const record = {
            schema: 2,
            matchId: id,
            startedAt: preferred.startedAt,
            // Preserve the provider's ID. A patch name is a separate inference.
            gameVersionId: preferred.gameVersionId,
            radiantHeroIds: preferred.radiantHeroIds,
            direHeroIds: preferred.direHeroIds,
            didRadiantWin: preferred.didRadiantWin,
            patch: {
                name: patch.name,
                method: "valve-release-timeline",
                unresolvedReason: patch.reason,
            },
            metadata: {
                sources: [...(p ? ["opendota"] : []), ...(v ? ["stratz"] : [])],
                preferredSource: v ? "stratz" : "opendota",
                // Post-match duration is for auditing, never a prediction input.
                durationSeconds: preferred.durationSeconds,
                publicContext: p?.publicContext ?? null,
            },
        };

        if (patch.name === null) {
            unresolvedMatches.push(record);
            summary.unresolvedReasons[patch.reason] = (summary.unresolvedReasons[patch.reason] ?? 0) + 1;
        } else {
            matches.push(record);
            summary.byInferredPatch[patch.name] = (summary.byInferredPatch[patch.name] ?? 0) + 1;
        }

        if (summary.earliestMatch === null || Date.parse(record.startedAt) < Date.parse(summary.earliestMatch)) {
            summary.earliestMatch = record.startedAt;
        }
        if (summary.latestMatch === null || Date.parse(record.startedAt) > Date.parse(summary.latestMatch)) {
            summary.latestMatch = record.startedAt;
        }
    }

    const chronological = (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)
        || a.matchId.length - b.matchId.length || a.matchId.localeCompare(b.matchId);

    matches.sort(chronological);
    unresolvedMatches.sort(chronological);

    // Also stabilize the summary when the same rows arrive in another order.
    summary.byInferredPatch = Object.fromEntries(Object.entries(summary.byInferredPatch).sort());
    summary.unresolvedReasons = Object.fromEntries(Object.entries(summary.unresolvedReasons).sort());
    summary.uniqueMatches = seen.size;
    summary.trainingMatches = matches.length;
    summary.unresolvedMatches = unresolvedMatches.length;

    return { matches, unresolvedMatches, summary };
}

module.exports = { TrainingExportError, buildTrainingDataset };