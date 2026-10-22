const { resolve, join, relative } = require("node:path");
const {
    mkdir, mkdtemp, writeFile, rename, rm,
} = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const {
    loadTrainingDataset,
    splitChronologically,
} = require("../server/trainingDataset.cjs");
const {
    fitLogistic,
    evaluateLogistic,
} = require("../server/logisticRegression.cjs");

const ROOT = resolve(__dirname, "..");
const LAMBDAS = [1, 0.1, 0.01, 0.001, 0.0001];

async function trainDraftBenchmark(
    directory,
    output = resolve(ROOT, "training-data")
) {
    const data = await loadTrainingDataset(directory);
    const split = splitChronologically(data.rows);
    const width = data.spec.featureNames.length;

    const prior = split.train.reduce(
        (sum, row) => sum + row.target,
        0
    ) / split.train.length;

    const constant = probability => ({
        intercept: Math.log(probability / (1 - probability)),
        coefficients: Array(width).fill(0),
    });

    const candidates = [];

    function add(family, fitted) {
        candidates.push({
            family,
            fitted,
            validation: evaluateLogistic(fitted, split.validation),
        });
    }

    add("coin-flip", constant(0.5));
    add("training-prior", constant(prior));

    for (const family of ["heroes-only", "heroes-and-tags"]) {
        const columns = data.spec.featureNames.flatMap((name, index) =>
            family === "heroes-and-tags" || name.startsWith("hero.")
                ? [index]
                : []
        );

        for (const lambda of LAMBDAS) {
            add(family, fitLogistic(split.train, columns, lambda));
        }
    }

    // Candidate order prefers simpler models when validation losses are tied.
    let selected = candidates[0];

    for (const candidate of candidates) {
        if (candidate.validation.logLoss < selected.validation.logLoss - 1e-12) {
            selected = candidate;
        }
    }

    const describeCandidate = candidate => ({
        family: candidate.family,
        lambda: candidate.fitted.lambda ?? null,
        iterations: candidate.fitted.iterations ?? 0,
        maxAbsGradient: candidate.fitted.maxAbsGradient ?? null,
        validation: candidate.validation,
    });

    const splitInfo = {
        policy: split.policy,
        validationStartsAt: split.validationStartsAt,
        testStartsAt: split.testStartsAt,
        trainMatches: split.train.length,
        validationMatches: split.validation.length,
        testMatches: split.test.length,
    };

    // Test scores are computed only after model selection.
    const report = {
        schema: 1,
        sourceManifestSha256: data.sourceManifestSha256,
        featureSchema: data.spec.featureSchema,
        profileSha256: data.spec.profileSha256,
        profilePatch: data.spec.profilePatch,
        split: splitInfo,
        selectionMetric: "validation-log-loss",
        trainingRadiantWinRate: prior,
        selected: describeCandidate(selected),
        validationCandidates: candidates.map(describeCandidate),
        test: {
            selected: evaluateLogistic(selected.fitted, split.test),
            coinFlip: evaluateLogistic(candidates[0].fitted, split.test),
            trainingPrior: evaluateLogistic(candidates[1].fitted, split.test),
        },
    };

    const model = {
        schema: 1,
        kind: "draft-logistic-v1",
        featureSpec: data.spec,
        sourceManifestSha256: data.sourceManifestSha256,
        split: splitInfo,
        family: selected.family,
        lambda: selected.fitted.lambda ?? null,
        intercept: selected.fitted.intercept,
        coefficients: selected.fitted.coefficients,
    };

    const modelText = JSON.stringify(model, null, 2) + "\n";
    report.modelSha256 = createHash("sha256")
        .update(modelText)
        .digest("hex");

    const destination = join(output, `benchmark-${randomUUID()}`);
    let temporary;

    try {
        await mkdir(output, { recursive: true });
        temporary = await mkdtemp(join(output, "pending-benchmark-"));

        await writeFile(join(temporary, "model.json"), modelText, {
            encoding: "utf8",
            flag: "wx",
        });

        await writeFile(
            join(temporary, "report.json"),
            JSON.stringify(report, null, 2) + "\n",
            { encoding: "utf8", flag: "wx" }
        );

        await rename(temporary, destination);
    } catch {
        throw new Error(
            "Could not save the benchmark. Check folder permissions and free space."
        );
    } finally {
        if (temporary) {
            await rm(temporary, { recursive: true, force: true }).catch(() => { });
        }
    }

    return {
        directory: relative(ROOT, destination).replaceAll("\\", "/"),
        ...report,
    };
}

module.exports = { trainDraftBenchmark };

if (require.main === module) {
    if (process.argv.length !== 3) {
        console.error(
            "Usage: node scripts/trainDraftBenchmark.cjs training-data/dataset-YOUR-ID"
        );
        process.exitCode = 1;
    } else {
        trainDraftBenchmark(process.argv[2]).then(report => {
            console.log(JSON.stringify(report, null, 2));
        }).catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
    }
}