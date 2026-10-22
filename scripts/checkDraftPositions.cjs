const assert = require("node:assert/strict");
const heroes = require("../heroes.json");
const profile = require("../heroPositionProfiles.json");
const {
    createDraftPositionAnalyzer,
} = require("../server/draftPositions.cjs");

function main() {
    const analyzer = createDraftPositionAnalyzer(profile);
    const byId = new Map(heroes.map(hero => [hero.HeroId, hero.name]));

    const find = name => {
        const hero = heroes.find(entry => entry.name === name);

        if (!hero) {
            throw new Error(`Example hero missing: ${name}`);
        }

        return hero.HeroId;
    };

    const allies = [
        "Witch Doctor",
        "Winter Wyvern",
        "Centaur Warrunner",
        "Outworld Destroyer",
        "Clinkz",
    ].map(find);

    const enemies = [
        "Dazzle",
        "Io",
        "Techies",
        "Shadow Shaman",
        "Shadow Demon",
    ].map(find);

    const juggernaut = enemies.map(
        id => id === find("Io") ? find("Juggernaut") : id
    );

    function inspect(ids) {
        const result = analyzer.analyzeTeam(ids);

        assert.deepEqual(
            analyzer.analyzeTeam([...ids].reverse()),
            result,
            "Hero order changed the position analysis."
        );

        assert.equal(
            result.available,
            true,
            "An example hero has no classified observations."
        );

        assert.equal(result.assignmentsEvaluated, 120);

        assert.equal(
            new Set(result.bestAssignment.map(row => row.heroId)).size,
            5
        );

        assert.deepEqual(
            result.bestAssignment.map(row => row.position),
            [1, 2, 3, 4, 5]
        );

        assert.ok(Object.values(result.metrics).every(Number.isFinite));

        return {
            ...result,
            bestAssignment: result.bestAssignment.map(row => ({
                hero: byId.get(row.heroId),
                ...row,
            })),
        };
    }

    console.log(JSON.stringify({
        analysisSchema: analyzer.analysisSchema,
        smoothingAlpha: analyzer.smoothingAlpha,
        window: analyzer.observationWindow,
        orderIndependent: true,
        examples: {
            allies: inspect(allies),
            originalEnemies: inspect(enemies),
            enemiesWithJuggernaut: inspect(juggernaut),
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