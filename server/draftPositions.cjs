const ANALYSIS_SCHEMA = "draft-position-fit-v1";
const ALPHA = 0.5;
const POSITIONS = [1, 2, 3, 4, 5];

function createDraftPositionAnalyzer(profile) {
    const window = profile?.window;
    const start = Date.parse(window?.start);
    const end = Date.parse(window?.end);
    const count = value => Number.isSafeInteger(value) && value >= 0;

    if (profile?.schema !== 1
        || profile.profileSchema !== "hero-position-observations-v1"
        || profile.source !== "stratz.heroStats.winHour"
        || profile.sharePopulation !== "classified-matches-in-usable-hero-hours"
        || profile.shareIntervalMethod !== "marginal-wilson-95"
        || profile.filters?.gameModeIds?.length !== 1
        || profile.filters.gameModeIds[0] !== "ALL_PICK_RANKED"
        || !Number.isFinite(start) || !Number.isFinite(end)
        || start % 3600000 !== 0 || end % 3600000 !== 0
        || end - start !== 168 * 3600000
        || window.requiredHours !== 168
        || !count(window.commonHoursObserved)
        || window.commonHoursObserved < 1 || window.commonHoursObserved > 168
        || window.complete !== (window.commonHoursObserved === 168)
        || !Array.isArray(profile.heroes) || !profile.heroes.length) {
        throw new Error("Invalid empirical position profile or observation window.");
    }

    const observationWindow = Object.freeze({ ...window });
    const byId = new Map();

    for (const hero of profile.heroes) {
        if (!Number.isSafeInteger(hero?.heroId) || hero.heroId <= 0
            || byId.has(hero.heroId)
            || !count(hero.classifiedMatches) || !count(hero.baselineMatches)
            || hero.baselineMatches < hero.classifiedMatches
            || !count(hero.usableHours) || hero.usableHours > window.commonHoursObserved
            || !Array.isArray(hero.positions) || hero.positions.length !== 5) {
            throw new Error("Invalid or duplicate hero position profile.");
        }

        const positions = [...hero.positions].sort((a, b) => a?.position - b?.position);
        let total = 0;

        const shares = positions.map((row, index) => {
            if (row?.position !== index + 1 || !count(row.matches)) {
                throw new Error(`Invalid position counts for hero ${hero.heroId}.`);
            }

            total += row.matches;

            if (!Number.isSafeInteger(total)) {
                throw new Error("Position counts exceed safe integer precision.");
            }

            const observedShare = hero.classifiedMatches
                ? row.matches / hero.classifiedMatches : null;
            const interval = row.shareInterval95;

            if (observedShare === null
                ? row.observedShare !== null || interval !== null
                : !Number.isFinite(row.observedShare)
                || Math.abs(row.observedShare - observedShare) > 1e-12
                || !Number.isFinite(interval?.lower) || !Number.isFinite(interval?.upper)
                || interval.lower < 0 || interval.lower > observedShare
                || interval.upper < observedShare || interval.upper > 1) {
                throw new Error(`Invalid position share or interval for hero ${hero.heroId}.`);
            }

            // Explicit symmetric smoothing: half a match per position. This prevents
            // an unobserved position from becoming a claim that it is impossible.
            const smoothedShare = (row.matches + ALPHA)
                / (hero.classifiedMatches + POSITIONS.length * ALPHA);

            return Object.freeze({
                position: row.position,
                matches: row.matches,
                observedShare,
                smoothedShare,
                shareInterval95: interval ? Object.freeze({ ...interval }) : null,
            });
        });

        if (total !== hero.classifiedMatches
            || (hero.baselineMatches > 0 && hero.usableHours === 0)) {
            throw new Error(`Inconsistent position totals for hero ${hero.heroId}.`);
        }

        byId.set(hero.heroId, Object.freeze({
            heroId: hero.heroId,
            classifiedMatches: total,
            classificationCoverage: hero.baselineMatches
                ? total / hero.baselineMatches : null,
            usableHours: hero.usableHours,
            positions: Object.freeze(shares),
        }));
    }

    function analyzeTeam(heroIds) {
        if (!Array.isArray(heroIds) || heroIds.length !== 5
            || new Set(heroIds).size !== 5
            || ![...heroIds].every(id => Number.isSafeInteger(id) && byId.has(id))) {
            throw new Error("Position analysis requires five distinct, known hero IDs.");
        }

        const heroes = [...heroIds].sort((a, b) => a - b).map(id => byId.get(id));
        const missingDataHeroIds = heroes
            .filter(hero => !hero.classifiedMatches)
            .map(hero => hero.heroId);

        const evidence = {
            minimumClassifiedMatches: Math.min(
                ...heroes.map(hero => hero.classifiedMatches)
            ),
            minimumClassificationCoverage:
                heroes.some(hero => hero.classificationCoverage === null)
                    ? null
                    : Math.min(...heroes.map(hero => hero.classificationCoverage)),
            minimumUsableHours: Math.min(...heroes.map(hero => hero.usableHours)),
            windowComplete: observationWindow.complete,
        };

        // A prior alone is not empirical evidence that an unknown hero is flexible.
        if (missingDataHeroIds.length) {
            return {
                available: false,
                missingDataHeroIds,
                evidence,
                assignmentsEvaluated: 0,
                bestAssignment: null,
                metrics: null,
            };
        }

        const assignments = [];

        function visit(chosen, remaining, logWeight) {
            if (!remaining.length) {
                assignments.push({ heroes: chosen, logWeight });
                return;
            }

            const positionIndex = chosen.length;

            for (let i = 0; i < remaining.length; i++) {
                const hero = remaining[i];

                visit(
                    [...chosen, hero],
                    remaining.filter((_, index) => index !== i),
                    logWeight + Math.log(hero.positions[positionIndex].smoothedShare)
                );
            }
        }

        visit([], heroes, 0);

        // Sorting IDs before enumeration also makes tied assignments deterministic.
        const best = assignments.reduce(
            (a, b) => b.logWeight > a.logWeight ? b : a
        );

        const scaled = assignments.map(
            assignment => Math.exp(assignment.logWeight - best.logWeight)
        );
        const totalWeight = scaled.reduce((sum, weight) => sum + weight, 0);
        const weights = scaled.map(weight => weight / totalWeight);
        const entropy = -weights.reduce(
            (sum, weight) => sum + weight * Math.log(weight),
            0
        );

        const bestAssignment = best.heroes.map((hero, index) => ({
            heroId: hero.heroId,
            ...hero.positions[index],
            classifiedMatches: hero.classifiedMatches,
            classificationCoverage: hero.classificationCoverage,
        }));

        return {
            available: true,
            missingDataHeroIds,
            evidence,
            assignmentsEvaluated: assignments.length,
            bestAssignment,

            // These describe position compatibility and ambiguity. They are neither
            // win probabilities nor calibrated probabilities of the players' roles.
            metrics: {
                bestMeanLogShare: best.logWeight / 5,
                weakestAssignedShare: Math.min(
                    ...bestAssignment.map(row => row.smoothedShare)
                ),
                logAssignmentMass: best.logWeight + Math.log(totalWeight),
                effectiveAssignments: Math.min(120, Math.max(1, Math.exp(entropy))),
            },
        };
    }

    return Object.freeze({
        analysisSchema: ANALYSIS_SCHEMA,
        smoothingAlpha: ALPHA,
        observationWindow,
        analyzeTeam,
    });
}

module.exports = { createDraftPositionAnalyzer };