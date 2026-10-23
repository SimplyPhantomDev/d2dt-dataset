const { createHash } = require("node:crypto");
const { createDraftFeatureExtractor } = require("./draftFeatures.cjs");
const {
    createPositionAwareFeatureExtractor,
} = require("./draftPositionFeatures.cjs");

function restoreDraftFeatureExtractor(spec) {
    let extractor;

    try {
        if (spec?.schema !== 1) {
            throw new Error("Unsupported feature specification.");
        }

        const heroes = spec.catalog.heroes.map(hero => ({
            HeroId: hero.heroId,
            roles: hero.roles,
            primaryAttribute: hero.primaryAttribute,
        }));

        if (spec.featureSchema === "draft-tags-v1") {
            extractor = createDraftFeatureExtractor(heroes);
        } else if (spec.featureSchema === "draft-tags-positions-v2") {
            extractor = createPositionAwareFeatureExtractor(
                heroes,
                spec.catalog.positionProfile
            );
        } else {
            throw new Error("Unsupported feature schema.");
        }
    } catch {
        throw new Error("The saved hero catalog is invalid or unsupported.");
    }

    const hash = createHash("sha256")
        .update(JSON.stringify(spec.catalog))
        .digest("hex");

    if (spec.featureSchema !== extractor.featureSchema
        || spec.profileSha256 !== extractor.profileSha256
        || hash !== spec.profileSha256
        || JSON.stringify(spec.featureNames) !== JSON.stringify(extractor.featureNames)
        || typeof spec.profilePatch !== "string"
        || !/^\d+\.\d+[a-z]?$/.test(spec.profilePatch)
        || spec.orientation !== "radiant-minus-dire"
        || spec.target?.field !== "target"
        || spec.target.one !== "radiant-win"
        || spec.target.zero !== "dire-win") {
        throw new Error(
            "Feature definitions do not agree with the saved catalog."
        );
    }

    return extractor;
}

module.exports = { restoreDraftFeatureExtractor };