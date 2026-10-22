const { createHash } = require("node:crypto");
const { createDraftFeatureExtractor } = require("./draftFeatures.cjs");
const { createDraftPositionAnalyzer } = require("./draftPositions.cjs");

const FEATURE_SCHEMA = "draft-tags-positions-v2";

const POSITION_KEYS = Object.freeze([
    "bestGeometricShare",
    "weakestAssignedShare",
    "assignmentMass",
    "assignmentEntropy",
    "minimumClassificationCoverage",
    "maximumAssignedIntervalWidth",
    "minimumObservedHourFraction",
]);

function deepFreeze(value) {
    if (value && typeof value === "object") {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }

    return value;
}

function createPositionAwareFeatureExtractor(heroes, positionProfile) {
    const base = createDraftFeatureExtractor(heroes);
    createDraftPositionAnalyzer(positionProfile);

    const updatedAt = Date.parse(positionProfile.sourceUpdatedAt);

    if (!Number.isFinite(updatedAt)
        || new Date(updatedAt).toISOString() !== positionProfile.sourceUpdatedAt
        || updatedAt < Date.parse(positionProfile.window.end)) {
        throw new Error("Invalid position observation timestamp.");
    }

    const filters = {};
    const filterNames = ["bracketIds", "gameModeIds", "regionIds"];

    if (Object.keys(positionProfile.filters).length !== filterNames.length) {
        throw new Error("Invalid position observation filters.");
    }

    for (const name of filterNames) {
        const value = positionProfile.filters[name];

        if (value !== null && (
            !Array.isArray(value)
            || !value.length
            || new Set(value).size !== value.length
            || !value.every(item =>
                typeof item === "string" && /^[A-Z][A-Z0-9_]*$/.test(item)
            )
        )) {
            throw new Error(`Invalid position observation filter: ${name}.`);
        }

        filters[name] = value === null ? null : [...value].sort();
    }

    const byId = new Map(
        positionProfile.heroes.map(hero => [hero.heroId, hero])
    );

    const window = positionProfile.window;

    // Copy the inputs needed to reproduce features. Later file updates cannot
    // change an existing extractor or a catalog saved inside a training export.
    const snapshot = {
        schema: 1,
        profileSchema: positionProfile.profileSchema,
        source: positionProfile.source,
        sourceUpdatedAt: positionProfile.sourceUpdatedAt,
        filters,
        sharePopulation: positionProfile.sharePopulation,
        shareIntervalMethod: positionProfile.shareIntervalMethod,

        window: {
            start: window.start,
            end: window.end,
            requiredHours: window.requiredHours,
            commonHoursObserved: window.commonHoursObserved,
            complete: window.complete,
        },

        heroes: base.catalog.heroes.map(({ heroId }) => {
            const hero = byId.get(heroId);

            if (!hero) {
                throw new Error(`Position observations missing for hero ${heroId}.`);
            }

            return {
                heroId,
                baselineMatches: hero.baselineMatches,
                classifiedMatches: hero.classifiedMatches,
                usableHours: hero.usableHours,

                positions: [...hero.positions]
                    .sort((a, b) => a.position - b.position)
                    .map(row => ({
                        position: row.position,
                        matches: row.matches,
                        observedShare: row.observedShare,

                        shareInterval95: row.shareInterval95 === null ? null : {
                            lower: row.shareInterval95.lower,
                            upper: row.shareInterval95.upper,
                        },
                    })),
            };
        }),
    };

    const analyzer = createDraftPositionAnalyzer(snapshot);

    const catalog = deepFreeze({
        ...base.catalog,
        featureSchema: FEATURE_SCHEMA,
        positionAnalysisSchema: analyzer.analysisSchema,
        positionSmoothingAlpha: analyzer.smoothingAlpha,
        positionProfile: snapshot,
    });

    const profileSha256 = createHash("sha256")
        .update(JSON.stringify(catalog))
        .digest("hex");

    const featureNames = Object.freeze([
        ...base.featureNames,
        ...POSITION_KEYS.map(key => `position.${key}`),
    ]);

    function describePositions(ids) {
        const analysis = analyzer.analyzeTeam(ids);

        if (!analysis.available) {
            throw new Error(
                `No classified position observations for heroes: ${analysis.missingDataHeroIds.join(", ")
                }.`
            );
        }

        // Keep each team measurement in [0, 1], comparable with existing indicators.
        // These are fixed feature definitions; training learns their coefficients.
        const metrics = analysis.metrics;

        const values = [
            Math.exp(metrics.bestMeanLogShare),
            metrics.weakestAssignedShare,
            Math.min(1, Math.exp(metrics.logAssignmentMass)),
            Math.log(metrics.effectiveAssignments) / Math.log(120),
            analysis.evidence.minimumClassificationCoverage,

            Math.max(...analysis.bestAssignment.map(row =>
                row.shareInterval95.upper - row.shareInterval95.lower
            )),

            analysis.evidence.minimumUsableHours / snapshot.window.requiredHours,
        ];

        if (!values.every(value =>
            Number.isFinite(value) && value >= 0 && value <= 1
        )) {
            throw new Error("Invalid empirical position feature values.");
        }

        return {
            analysis,
            features: Object.fromEntries(
                POSITION_KEYS.map((key, index) => [key, values[index]])
            ),
            values,
        };
    }

    function extract(radiantHeroIds, direHeroIds) {
        const original = base.extract(radiantHeroIds, direHeroIds);
        const radiant = describePositions(radiantHeroIds);
        const dire = describePositions(direHeroIds);

        return {
            values: [
                ...original.values,
                ...radiant.values.map((value, index) => value - dire.values[index]),
            ],

            radiant: {
                ...original.radiant,
                positions: radiant.analysis,
                positionFeatures: radiant.features,
            },

            dire: {
                ...original.dire,
                positions: dire.analysis,
                positionFeatures: dire.features,
            },
        };
    }

    return Object.freeze({
        featureSchema: FEATURE_SCHEMA,
        profileSha256,
        catalog,
        featureNames,
        extract,
    });
}

module.exports = { createPositionAwareFeatureExtractor };