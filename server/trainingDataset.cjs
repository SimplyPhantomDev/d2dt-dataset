const { readFile } = require("node:fs/promises");
const { resolve, join } = require("node:path");
const { createHash } = require("node:crypto");
const { createDraftFeatureExtractor } = require("./draftFeatures.cjs");

const DAY = 86400000;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function loadTrainingDataset(directory) {
    if (typeof directory !== "string" || !directory.trim()) {
        throw new Error("Provide the path to a completed dataset export folder.");
    }

    const folder = resolve(directory);
    let manifestBytes, specBytes, featureBytes, manifest, spec;

    try {
        [manifestBytes, specBytes, featureBytes] = await Promise.all([
            readFile(join(folder, "manifest.json")),
            readFile(join(folder, "featureSpec.json")),
            readFile(join(folder, "features.jsonl")),
        ]);

        manifest = JSON.parse(manifestBytes.toString("utf8"));
        spec = JSON.parse(specBytes.toString("utf8"));
    } catch {
        throw new Error(
            "Could not read the export's manifest, feature specification or feature rows."
        );
    }

    if (manifest?.schema !== 2 || manifest.matchSchema !== 2 || spec?.schema !== 1) {
        throw new Error(
            "Unsupported training export schema. Use the updated exportTrainingMatches script."
        );
    }

    for (const [name, bytes] of [
        ["featureSpec.json", specBytes],
        ["features.jsonl", featureBytes],
    ]) {
        const expected = manifest.files?.[name];

        if (expected?.bytes !== bytes.length || expected.sha256 !== sha256(bytes)) {
            throw new Error(
                `Export integrity check failed for ${name}. Use an unmodified export.`
            );
        }
    }

    let extractor;

    try {
        extractor = createDraftFeatureExtractor(
            spec.catalog.heroes.map(hero => ({
                HeroId: hero.heroId,
                roles: hero.roles,
                primaryAttribute: hero.primaryAttribute,
            }))
        );
    } catch {
        throw new Error("The saved hero catalog is invalid or unsupported.");
    }

    const info = manifest.features;

    if (spec.featureSchema !== extractor.featureSchema
        || spec.profileSha256 !== extractor.profileSha256
        || sha256(JSON.stringify(spec.catalog)) !== spec.profileSha256
        || JSON.stringify(spec.featureNames) !== JSON.stringify(extractor.featureNames)
        || typeof spec.profilePatch !== "string"
        || !/^\d+\.\d+[a-z]?$/.test(spec.profilePatch)
        || spec.orientation !== "radiant-minus-dire"
        || spec.target?.field !== "target"
        || spec.target.one !== "radiant-win"
        || spec.target.zero !== "dire-win"
        || info?.featureSchema !== spec.featureSchema
        || info.profileSha256 !== spec.profileSha256
        || info.profilePatch !== spec.profilePatch
        || info.heroes !== extractor.catalog.heroes.length
        || info.featureCount !== spec.featureNames.length) {
        throw new Error(
            "Feature definitions do not agree with the saved catalog and manifest."
        );
    }

    const text = featureBytes.toString("utf8").trimEnd();
    const rows = [];
    const seen = new Set();
    let radiantWins = 0;

    for (const line of text ? text.split("\n") : []) {
        let row;

        try {
            row = JSON.parse(line);
        } catch {
            throw new Error(`Invalid feature JSON on line ${rows.length + 1}.`);
        }

        const id = row?.matchId;
        const time = typeof row?.startedAt === "string"
            ? Date.parse(row.startedAt)
            : NaN;

        if (row?.schema !== 1
            || typeof id !== "string"
            || !/^[1-9][0-9]{0,18}$/.test(id)
            || BigInt(id) > 9223372036854775807n
            || seen.has(id)
            || !Number.isFinite(time)
            || time <= 0
            || new Date(time).toISOString() !== row.startedAt
            || row.patch !== spec.profilePatch
            || (row.target !== 0 && row.target !== 1)
            || !Array.isArray(row.values)
            || row.values.length !== spec.featureNames.length
            || !row.values.every(value => Number.isFinite(value))) {
            throw new Error(
                `Invalid or duplicate feature row on line ${rows.length + 1}.`
            );
        }

        seen.add(id);
        radiantWins += row.target;
        rows.push(row);
    }

    if (rows.length !== info.matches
        || radiantWins !== info.radiantWins
        || rows.length - radiantWins !== info.direWins
        || !Number.isSafeInteger(info.excludedMatches)
        || info.excludedMatches < 0
        || rows.length + info.excludedMatches !== manifest.summary?.trainingMatches) {
        throw new Error(
            "Feature row counts or outcomes do not agree with the manifest."
        );
    }

    return {
        directory: folder,
        sourceManifestSha256: sha256(manifestBytes),
        spec,
        rows,
    };
}

// Pass the validated rows returned by loadTrainingDataset.
function splitChronologically(rows) {
    const ordered = [...rows].sort((a, b) =>
        Date.parse(a.startedAt) - Date.parse(b.startedAt)
        || a.matchId.length - b.matchId.length
        || a.matchId.localeCompare(b.matchId)
    );

    const groups = [];

    ordered.forEach((row, index) => {
        const day = Math.floor(Date.parse(row.startedAt) / DAY);

        if (groups.at(-1)?.day !== day) {
            groups.push({ day, index });
        }
    });

    if (groups.length < 3) {
        throw new Error(
            "Chronological splitting requires matches from at least three UTC dates."
        );
    }

    // Choose date boundaries closest to the requested proportions.
    // Outcomes play no part in choosing the boundaries.
    let best = null;

    for (let i = 1; i < groups.length - 1; i++) {
        for (let j = i + 1; j < groups.length; j++) {
            const a = groups[i].index;
            const b = groups[j].index;
            const n = ordered.length;

            const score = Math.abs(a / n - 0.70)
                + Math.abs((b - a) / n - 0.15)
                + Math.abs((n - b) / n - 0.15);

            if (best === null || score < best.score) {
                best = { a, b, score };
            }
        }
    }

    const partitions = {
        train: ordered.slice(0, best.a),
        validation: ordered.slice(best.a, best.b),
        test: ordered.slice(best.b),
    };

    for (const [name, part] of Object.entries(partitions)) {
        if (new Set(part.map(row => row.target)).size !== 2) {
            // Do not search for alternative boundaries using outcome labels.
            throw new Error(
                `The ${name} split needs both Radiant and Dire wins. Collect broader coverage.`
            );
        }
    }

    const midnight = row =>
        new Date(Math.floor(Date.parse(row.startedAt) / DAY) * DAY).toISOString();

    return {
        policy: "utc-day-70-15-15-v1",
        targetFractions: {
            train: 0.70,
            validation: 0.15,
            test: 0.15,
        },
        validationStartsAt: midnight(partitions.validation[0]),
        testStartsAt: midnight(partitions.test[0]),
        ...partitions,
    };
}

module.exports = { loadTrainingDataset, splitChronologically };