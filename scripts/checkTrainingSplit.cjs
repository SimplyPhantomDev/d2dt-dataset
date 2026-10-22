const {
    loadTrainingDataset,
    splitChronologically,
} = require("../server/trainingDataset.cjs");

function describe(rows) {
    const radiantWins = rows.reduce((sum, row) => sum + row.target, 0);

    return {
        matches: rows.length,
        observedDays: new Set(
            rows.map(row => Math.floor(Date.parse(row.startedAt) / 86400000))
        ).size,
        observedHours: new Set(
            rows.map(row => Math.floor(Date.parse(row.startedAt) / 3600000))
        ).size,
        radiantWins,
        direWins: rows.length - radiantWins,
        earliestMatch: rows[0].startedAt,
        latestMatch: rows.at(-1).startedAt,
    };
}

async function main() {
    if (process.argv.length !== 3) {
        throw new Error(
            "Usage: node scripts/checkTrainingSplit.cjs training-data/dataset-YOUR-ID"
        );
    }

    const data = await loadTrainingDataset(process.argv[2]);
    const split = splitChronologically(data.rows);

    console.log(JSON.stringify({
        directory: data.directory,
        sourceManifestSha256: data.sourceManifestSha256,
        featureSchema: data.spec.featureSchema,
        profileSha256: data.spec.profileSha256,
        profilePatch: data.spec.profilePatch,
        featureCount: data.spec.featureNames.length,
        matches: data.rows.length,
        policy: split.policy,
        targetFractions: split.targetFractions,
        validationStartsAt: split.validationStartsAt,
        testStartsAt: split.testStartsAt,
        train: describe(split.train),
        validation: describe(split.validation),
        test: describe(split.test),
    }, null, 2));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}