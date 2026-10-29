const { readFile, mkdir, mkdtemp, writeFile, rename, rm } = require("node:fs/promises");
const { resolve, join, relative } = require("node:path");
const { createHash } = require("node:crypto");
const { loadTrainingDataset } = require("../server/trainingDataset.cjs");
const { restoreDraftFeatureExtractor } = require("../server/restoreDraftFeatureExtractor.cjs");
const { predictRadiant } = require("../server/logisticRegression.cjs");

const ROOT = resolve(__dirname, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

const check = (condition, message) => {
    if (!condition) throw new Error(message);
};

async function exportClientDraftModel(benchmarkDirectory, datasetDirectory) {
    const data = await loadTrainingDataset(datasetDirectory);
    check(data.rows.length > 0, "The training dataset contains no usable matches.");

    const benchmark = resolve(benchmarkDirectory);
    const [modelBytes, reportText] = await Promise.all([
        readFile(join(benchmark, "model.json")),
        readFile(join(benchmark, "report.json"), "utf8"),
    ]);

    const model = JSON.parse(modelBytes.toString("utf8"));
    const report = JSON.parse(reportText);
    const modelId = hash(modelBytes);

    check(model.schema === 1 && model.kind === "draft-logistic-v1",
        "Unsupported trained model format.");

    check(report.schema === 1 && report.modelSha256 === modelId,
        "The model does not match its benchmark report.");

    check(model.sourceManifestSha256 === data.sourceManifestSha256
        && report.sourceManifestSha256 === data.sourceManifestSha256,
        "The benchmark and dataset are not a matching pair.");

    check(JSON.stringify(model.featureSpec) === JSON.stringify(data.spec)
        && model.featureSpec.featureSchema === "draft-tags-positions-v2"
        && report.profileSha256 === data.spec.profileSha256
        && report.profilePatch === data.spec.profilePatch,
        "The saved feature definitions do not match the training dataset.");

    check(report.selected && typeof model.family === "string"
        && report.selected.family === model.family
        && report.selected.lambda === model.lambda
        && JSON.stringify(report.split) === JSON.stringify(model.split),
        "The model does not match the selected benchmark candidate.");

    check(Number.isFinite(model.intercept)
        && Array.isArray(model.coefficients)
        && model.coefficients.length === data.spec.featureNames.length
        && [...model.coefficients].every(Number.isFinite),
        "Invalid model intercept or coefficients.");

    const extractor = restoreDraftFeatureExtractor(model.featureSpec);

    const heroColumns = data.spec.featureNames.flatMap((name, index) =>
        name.startsWith("hero.") ? [{ id: Number(name.slice(5)), index }] : []
    );

    const sampleCount = Math.min(100, data.rows.length);

    // Verify reconstruction against saved features without evaluating outcomes
    // or retraining. No sampled matches are included in the client artifact.
    for (let i = 0; i < sampleCount; i++) {
        const index = sampleCount === 1 ? 0
            : Math.floor(i * (data.rows.length - 1) / (sampleCount - 1));

        const row = data.rows[index];

        const allies = heroColumns
            .filter(column => row.values[column.index] === 1)
            .map(column => column.id);

        const enemies = heroColumns
            .filter(column => row.values[column.index] === -1)
            .map(column => column.id);

        const { values } = extractor.extract(allies, enemies);

        check(values.length === row.values.length
            && values.every((value, column) =>
                Number.isFinite(value)
                && Math.abs(value - row.values[column]) <= 1e-12),
            "Reconstructed features differ from the saved training features.");
    }

    const allies = [30, 112, 96, 76, 56];

    const examples = [
        ["original-five-support-example", [50, 91, 105, 27, 79]],
        ["replace-enemy-Io-with-Juggernaut", [50, 8, 105, 27, 79]],
    ].map(([name, enemies]) => {
        const { values } = extractor.extract(allies, enemies);
        const allyAsRadiant = predictRadiant(model, values);
        const allyAsDire = 1 - predictRadiant(
            model,
            values.map(value => -value)
        );
        const ally = (allyAsRadiant + allyAsDire) / 2;

        check([allyAsRadiant, allyAsDire, ally].every(value =>
            Number.isFinite(value) && value >= 0 && value <= 1),
            "The model produced an invalid reference prediction.");

        return {
            name,
            allyHeroIds: allies,
            enemyHeroIds: enemies,
            values,
            allyAsRadiant,
            allyAsDire,
            ally,
            enemy: 1 - ally,
        };
    });

    // Coefficients and their frozen catalog stay together. Live dataset updates
    // must never substitute different position observations into this model.
    const artifact = {
        schema: 1,
        kind: "d2dt-client-model-v1",
        modelId,
        model,
        verification: {
            tolerance: 1e-12,
            drafts: examples,
        },
    };

    const text = JSON.stringify(artifact, null, 4) + "\n";
    const output = join(ROOT, "training-data");
    const destination = join(output, `client-model-${modelId.slice(0, 12)}`);
    let temporary;

    try {
        await mkdir(output, { recursive: true });
        temporary = await mkdtemp(join(output, "pending-client-model-"));

        await writeFile(join(temporary, "draftModel.json"), text, {
            encoding: "utf8",
            flag: "wx",
        });

        await rename(temporary, destination);
    } catch (error) {
        throw new Error(
            "Could not save the client model. Check write permissions and whether this model was already exported.",
            { cause: error }
        );
    } finally {
        if (temporary) {
            await rm(temporary, { recursive: true, force: true });
        }
    }

    return {
        directory: relative(ROOT, destination).replaceAll("\\", "/"),
        file: "draftModel.json",
        bytes: Buffer.byteLength(text),
        modelId,
        family: model.family,
        patch: data.spec.profilePatch,
        featureSchema: data.spec.featureSchema,
        profileSha256: data.spec.profileSha256,
        heroes: data.spec.catalog.heroes.length,
        features: data.spec.featureNames.length,
        checkedFeatureRows: sampleCount,
        examples: examples.map(example => {
            const hundredths = Math.round(example.ally * 10000);

            return {
                name: example.name,
                allyPercent: hundredths / 100,
                enemyPercent: (10000 - hundredths) / 100,
            };
        }),
    };
}

module.exports = { exportClientDraftModel };

if (require.main === module) {
    if (process.argv.length !== 4) {
        console.error(
            "Usage: node scripts/exportClientDraftModel.cjs training-data/benchmark-ID training-data/dataset-ID"
        );
        process.exitCode = 1;
    } else {
        exportClientDraftModel(process.argv[2], process.argv[3]).then(result => {
            console.log(JSON.stringify(result, null, 2));
        }).catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
    }
}