const assert = require("node:assert/strict");
const heroes = require("../heroes.json");
const profile = require("../heroPositionProfiles.json");

const {
    createDraftFeatureExtractor,
} = require("../server/draftFeatures.cjs");

const {
    createPositionAwareFeatureExtractor,
} = require("../server/draftPositionFeatures.cjs");

function main() {
    const base = createDraftFeatureExtractor(heroes);
    const extractor = createPositionAwareFeatureExtractor(heroes, profile);

    const find = name => {
        const hero = heroes.find(entry => entry.name === name);

        if (!hero) {
            throw new Error(`Example hero missing: ${name}`);
        }

        return hero.HeroId;
    };

    const radiant = [
        "Witch Doctor",
        "Winter Wyvern",
        "Centaur Warrunner",
        "Outworld Destroyer",
        "Clinkz",
    ].map(find);

    const dire = [
        "Dazzle",
        "Io",
        "Techies",
        "Shadow Shaman",
        "Shadow Demon",
    ].map(find);

    const result = extractor.extract(radiant, dire);
    const swapped = extractor.extract(dire, radiant);

    assert.deepEqual(
        extractor.extract([...radiant].reverse(), [...dire].reverse()),
        result
    );

    assert.deepEqual(
        swapped.values.map(value => value === 0 ? 0 : -value),
        result.values
    );

    assert.deepEqual(
        result.values.slice(0, base.featureNames.length),
        base.extract(radiant, dire).values
    );

    assert.equal(result.values.length, extractor.featureNames.length);

    assert.equal(
        new Set(extractor.featureNames).size,
        extractor.featureNames.length
    );

    assert.ok(result.values.every(value =>
        Number.isFinite(value) && Math.abs(value) <= 1
    ));

    // Reconstruct using only the saved catalog, without consulting current JSON.
    const saved = JSON.parse(JSON.stringify(extractor.catalog));

    const restored = createPositionAwareFeatureExtractor(
        saved.heroes.map(hero => ({
            HeroId: hero.heroId,
            roles: hero.roles,
            primaryAttribute: hero.primaryAttribute,
        })),
        saved.positionProfile
    );

    assert.deepEqual(restored.catalog, extractor.catalog);
    assert.equal(restored.profileSha256, extractor.profileSha256);
    assert.deepEqual(restored.featureNames, extractor.featureNames);
    assert.deepEqual(restored.extract(radiant, dire), result);

    const withJuggernaut = extractor.extract(
        radiant,
        dire.map(id => id === find("Io") ? find("Juggernaut") : id)
    );

    const differences = Object.fromEntries(
        extractor.featureNames
            .slice(base.featureNames.length)
            .map((name, index) => [
                name,
                result.values[base.featureNames.length + index],
            ])
    );

    console.log(JSON.stringify({
        featureSchema: extractor.featureSchema,
        profileSha256: extractor.profileSha256,
        heroes: extractor.catalog.heroes.length,
        baseFeatures: base.featureNames.length,
        positionFeatures: extractor.featureNames.length - base.featureNames.length,
        totalFeatures: extractor.featureNames.length,
        window: extractor.catalog.positionProfile.window,
        orderIndependent: true,
        teamSwapNegatesFeatures: true,
        savedCatalogReproducesFeatures: true,

        example: {
            radiant: result.radiant.positionFeatures,
            originalDire: result.dire.positionFeatures,
            direWithJuggernaut: withJuggernaut.dire.positionFeatures,
            differences,
        },
    }, null, 2));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}