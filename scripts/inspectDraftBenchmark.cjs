const { readFile } = require("node:fs/promises");
const { resolve, join } = require("node:path");
const { createHash } = require("node:crypto");
const {
    loadTrainingDataset,
    splitChronologically,
} = require("../server/trainingDataset.cjs");
const {
    createDraftFeatureExtractor,
} = require("../server/draftFeatures.cjs");
const { predictRadiant } = require("../server/logisticRegression.cjs");

const round = value => Number(value.toFixed(6));

const NAMES = new Map([
    [30, "Witch Doctor"],
    [112, "Winter Wyvern"],
    [96, "Centaur Warrunner"],
    [76, "Outworld Destroyer"],
    [56, "Clinkz"],
    [50, "Dazzle"],
    [91, "Io"],
    [105, "Techies"],
    [27, "Shadow Shaman"],
    [79, "Shadow Demon"],
    [8, "Juggernaut"],
]);

async function inspectDraftBenchmark(modelDirectory, datasetDirectory) {
    const data = await loadTrainingDataset(datasetDirectory);
    let bytes, model, report;

    try {
        const inputs = await Promise.all([
            readFile(join(resolve(modelDirectory), "model.json")),
            readFile(join(resolve(modelDirectory), "report.json"), "utf8"),
        ]);

        bytes = inputs[0];
        model = JSON.parse(bytes.toString("utf8"));
        report = JSON.parse(inputs[1]);
    } catch {
        throw new Error(
            "Could not read model.json and report.json from the benchmark folder."
        );
    }

    const modelSha256 = createHash("sha256").update(bytes).digest("hex");

    if (model?.schema !== 1
        || model.kind !== "draft-logistic-v1"
        || report?.schema !== 1
        || modelSha256 !== report.modelSha256
        || model.sourceManifestSha256 !== data.sourceManifestSha256
        || report.sourceManifestSha256 !== data.sourceManifestSha256
        || JSON.stringify(model.featureSpec) !== JSON.stringify(data.spec)
        || !Number.isFinite(model.intercept)
        || !Array.isArray(model.coefficients)
        || model.coefficients.length !== data.spec.featureNames.length
        || !model.coefficients.every(Number.isFinite)
        || model.family !== report.selected?.family
        || model.lambda !== report.selected?.lambda) {
        throw new Error(
            "The model, report and dataset do not agree. Use the original benchmark and its source export."
        );
    }

    const split = splitChronologically(data.rows);

    const expectedSplit = {
        policy: split.policy,
        validationStartsAt: split.validationStartsAt,
        testStartsAt: split.testStartsAt,
        trainMatches: split.train.length,
        validationMatches: split.validation.length,
        testMatches: split.test.length,
    };

    if (Object.entries(expectedSplit).some(([key, value]) =>
        model.split?.[key] !== value || report.split?.[key] !== value
    )) {
        throw new Error(
            "The benchmark's saved split does not match the dataset."
        );
    }

    // Development diagnostics use validation.
    // No new test-set scores are computed.
    const predictions = split.validation.map(row =>
        predictRadiant(model, row.values)
    );

    const sorted = [...predictions].sort((a, b) => a - b);

    const quantile = fraction => {
        const position = fraction * (sorted.length - 1);
        const index = Math.floor(position);
        const next = Math.min(index + 1, sorted.length - 1);

        return round(
            sorted[index] + (sorted[next] - sorted[index]) * (position - index)
        );
    };

    const bins = Array.from(
        { length: 10 },
        () => ({ matches: 0, predicted: 0, wins: 0 })
    );

    predictions.forEach((p, index) => {
        const bin = bins[Math.min(9, Math.floor(p * 10))];
        bin.matches++;
        bin.predicted += p;
        bin.wins += split.validation[index].target;
    });

    const extractor = createDraftFeatureExtractor(
        data.spec.catalog.heroes.map(hero => ({
            HeroId: hero.heroId,
            primaryAttribute: hero.primaryAttribute,
            roles: hero.roles,
        }))
    );

    function explain(name, allies, enemies) {
        const { values } = extractor.extract(allies, enemies);

        const allyAsRadiant = predictRadiant(model, values);
        const allyAsDire = 1 - predictRadiant(
            model,
            values.map(value => -value)
        );

        // Equal prior over the two sides: an explicit assumption for the app.
        const allyUnknownSide = (allyAsRadiant + allyAsDire) / 2;

        const contributions = values.map((value, index) => ({
            feature: data.spec.featureNames[index],
            value,
            logOddsContribution: model.coefficients[index] * value,
        }));

        const draftScore = contributions.reduce(
            (sum, item) => sum + item.logOddsContribution,
            0
        );

        return {
            name,
            allies: allies.map(id => NAMES.get(id) ?? String(id)),
            enemies: enemies.map(id => NAMES.get(id) ?? String(id)),
            allyAsRadiant: round(allyAsRadiant),
            allyAsDire: round(allyAsDire),
            allyUnknownSide: round(allyUnknownSide),
            enemyUnknownSide: round(1 - allyUnknownSide),
            draftScoreLogOdds: round(draftScore),
            topContributions: contributions
                .filter(item => item.logOddsContribution !== 0)
                .sort((a, b) =>
                    Math.abs(b.logOddsContribution) - Math.abs(a.logOddsContribution)
                )
                .slice(0, 8)
                .map(item => ({
                    ...item,
                    logOddsContribution: round(item.logOddsContribution),
                })),
        };
    }

    const allies = [30, 112, 96, 76, 56];
    const enemies = [50, 91, 105, 27, 79];

    return {
        family: model.family,
        lambda: model.lambda,
        modelSha256,
        profileSha256: data.spec.profileSha256,
        radiantInterceptLogOdds: round(model.intercept),

        validationPredictionSpread: {
            matches: predictions.length,
            minimum: quantile(0),
            p10: quantile(0.1),
            median: quantile(0.5),
            p90: quantile(0.9),
            maximum: quantile(1),
        },

        validationCalibration: bins.flatMap((bin, index) =>
            bin.matches ? [{
                lowerBound: index / 10,
                upperBound: (index + 1) / 10,
                matches: bin.matches,
                meanPrediction: round(bin.predicted / bin.matches),
                observedWinRate: round(bin.wins / bin.matches),
            }] : []
        ),

        draftCases: [
            explain("original-five-support-example", allies, enemies),
            explain(
                "replace-enemy-Io-with-Juggernaut",
                allies,
                enemies.map(id => id === 91 ? 8 : id)
            ),
        ],
    };
}

module.exports = { inspectDraftBenchmark };

if (require.main === module) {
    if (process.argv.length !== 4) {
        console.error(
            "Usage: node scripts/inspectDraftBenchmark.cjs training-data/benchmark-YOUR-ID training-data/dataset-YOUR-ID"
        );
        process.exitCode = 1;
    } else {
        inspectDraftBenchmark(process.argv[2], process.argv[3]).then(result => {
            console.log(JSON.stringify(result, null, 2));
        }).catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
    }
}