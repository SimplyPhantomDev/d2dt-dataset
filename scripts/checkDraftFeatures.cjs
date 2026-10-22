const assert = require("node:assert/strict");
const heroes = require("../heroes.json");
const { createDraftFeatureExtractor } = require("../server/draftFeatures.cjs");

function main() {
    const extractor = createDraftFeatureExtractor(heroes);

    const find = name => {
        const hero = heroes.find(entry => entry.name === name);

        if (!hero) {
            throw new Error(`Example hero missing from heroes.json: ${name}`);
        }

        return hero.HeroId;
    };

    // The example that exposed the limitations of the original calculator.
    const radiant = [
        "Witch Doctor",
        "Winter Wyvern",
        "Centaur Warrunner",
        "Outworld Destroyer",
        "Clinkz",
    ];

    const dire = [
        "Dazzle",
        "Io",
        "Techies",
        "Shadow Shaman",
        "Shadow Demon",
    ];

    const r = radiant.map(find);
    const d = dire.map(find);

    const result = extractor.extract(r, d);
    const reordered = extractor.extract([...r].reverse(), [...d].reverse());
    const swapped = extractor.extract(d, r);

    assert.deepEqual(
        reordered,
        result,
        "Hero order changed the features."
    );

    assert.deepEqual(
        swapped.values.map(value => value === 0 ? 0 : -value),
        result.values,
        "Swapping teams did not negate every feature."
    );

    assert.equal(result.values.length, extractor.featureNames.length);
    assert.equal(new Set(extractor.featureNames).size, extractor.featureNames.length);
    assert.ok(result.values.every(value => Number.isFinite(value)));

    const active = Object.fromEntries(
        extractor.featureNames.flatMap((name, index) =>
            result.values[index] === 0 ? [] : [[name, result.values[index]]]
        )
    );

    console.log(JSON.stringify({
        featureSchema: extractor.featureSchema,
        profileSha256: extractor.profileSha256,
        heroes: extractor.catalog.heroes.length,
        features: extractor.featureNames.length,
        orderIndependent: true,
        teamSwapNegatesFeatures: true,
        example: {
            radiant: { heroes: radiant, ...result.radiant },
            dire: { heroes: dire, ...result.dire },
            nonzeroFeatures: active,
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