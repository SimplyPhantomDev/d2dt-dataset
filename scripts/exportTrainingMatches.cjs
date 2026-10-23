const { resolve, join, relative, dirname } = require("node:path");
const {
    readFile, mkdir, mkdtemp, writeFile, rename, rm,
} = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { neon } = require("@neondatabase/serverless");
const { fetchPatchTimeline } = require("../server/matchPatch.cjs");

const {
    TrainingExportError,
    buildTrainingDataset,
} = require("../server/trainingMatches.cjs");

const {
    createPositionAwareFeatureExtractor,
} = require("../server/draftPositionFeatures.cjs");

const {
    restoreDraftFeatureExtractor,
} = require("../server/restoreDraftFeatureExtractor.cjs");

const ROOT = resolve(__dirname, "..");
const OUTPUT = resolve(ROOT, "training-data");

require("dotenv").config({
    path: resolve(ROOT, ".env"),
    quiet: true,
});

async function readFeatureSource(savedFeatureSpec) {
    if (savedFeatureSpec !== null) {
        try {
            const file = resolve(savedFeatureSpec);

            const [specBytes, manifestText] = await Promise.all([
                readFile(file),
                readFile(join(dirname(file), "manifest.json"), "utf8"),
            ]);

            const manifest = JSON.parse(manifestText);
            const expected = manifest.files?.["featureSpec.json"];

            if (manifest.schema !== 2 || manifest.matchSchema !== 2
                || expected?.bytes !== specBytes.length
                || expected.sha256 !== createHash("sha256")
                    .update(specBytes)
                    .digest("hex")) {
                throw new Error(
                    "Saved feature specification integrity check failed."
                );
            }

            const spec = JSON.parse(specBytes.toString("utf8"));

            return {
                extractor: restoreDraftFeatureExtractor(spec),
                patch: spec.profilePatch,
                source: spec.source ?? {},
            };
        } catch {
            throw new TrainingExportError(
                `Could not restore the saved feature specification.
                Provide an unmodified featureSpec.json from a completed export.`
            );
        }
    }

    try {
        const [bytes, text, positionText] = await Promise.all([
            readFile(resolve(ROOT, "heroes.json")),
            readFile(resolve(ROOT, "manifest.json"), "utf8"),
            readFile(resolve(ROOT, "heroPositionProfiles.json"), "utf8"),
        ]);

        const manifest = JSON.parse(text);

        // Accept Windows line-ending conversion only when the normalized
        // bytes match the published hero file's checksum and size.
        const candidates = [
            bytes,
            Buffer.from(
                bytes.toString("utf8").replaceAll("\r\n", "\n"),
                "utf8"
            ),
        ];

        const verifiedBytes = candidates.find(candidate =>
            candidate.length === manifest.heroesBytes
            && createHash("sha256").update(candidate).digest("hex")
            === manifest.heroesSha256
        );

        const time = typeof manifest.generatedAt === "string"
            ? Date.parse(manifest.generatedAt)
            : NaN;

        if (manifest.schema !== 1 || manifest.heroesFile !== "heroes.json"
            || !verifiedBytes
            || typeof manifest.patch !== "string"
            || !/^\d+\.\d+[a-z]?$/.test(manifest.patch)
            || !Number.isFinite(time) || time <= 0
            || new Date(time).toISOString() !== manifest.generatedAt) {
            throw new Error("Invalid hero dataset manifest.");
        }

        return {
            extractor: createPositionAwareFeatureExtractor(
                JSON.parse(verifiedBytes.toString("utf8")),
                JSON.parse(positionText)
            ),

            patch: manifest.patch,

            source: {
                heroesFile: "heroes.json",
                heroesSha256: manifest.heroesSha256,
                datasetGeneratedAt: manifest.generatedAt,
                positionProfilesFile: "heroPositionProfiles.json",

                positionProfilesSha256: createHash("sha256")
                    .update(positionText.replaceAll("\r\n", "\n"))
                    .digest("hex"),
            },
        };
    } catch {
        throw new TrainingExportError(
            `Could not load hero profiles. Check heroes.json and
            manifest.json, then run node generator/buildHeroPositionProfiles.cjs
            to refresh the position profiles.`
        );
    }
}

async function readTrainingMatches() {
    if (!process.env.DATABASE_URL) {
        throw new TrainingExportError(
            "Add DATABASE_URL to the repository's .env file."
        );
    }

    try {
        const sql = neon(process.env.DATABASE_URL, {
            fetchOptions: { signal: AbortSignal.timeout(60000) },
        });

        // One snapshot keeps source facts and report eligibility consistent.
        // EXISTS counts a verified match once, regardless of report count.
        return await sql`
            WITH verified AS (
                SELECT c.match_id, c.match_data
                FROM public.stratz_match_cache c
                WHERE c.schema = 1 AND EXISTS (
                    SELECT 1 FROM public.match_reports r
                    WHERE r.match_id = c.match_id
                        AND r.verification = 'verified'
                )
            )
            SELECT COALESCE(p.match_id, v.match_id)::text AS match_id,
                    p.match_data AS public_data,
                    v.match_data AS verified_data
            FROM public.public_match_samples p
            FULL OUTER JOIN verified v ON v.match_id = p.match_id
            ORDER BY COALESCE(p.match_id, v.match_id)
        `;
    } catch {
        // Raw database errors can contain credentials.
        throw new TrainingExportError(
            "Could not read training matches. Check DATABASE_URL and migrations 001–005."
        );
    }
}

async function exportTrainingMatches(output = OUTPUT, savedFeatureSpec = null) {
    const { extractor, patch, source } =
        await readFeatureSource(savedFeatureSpec);
    const rows = await readTrainingMatches();

    let timeline;
    try {
        timeline = await fetchPatchTimeline();
    } catch {
        throw new TrainingExportError(
            "Could not fetch Valve's patch timeline. No export was saved; try again later."
        );
    }

    const { matches, unresolvedMatches, summary } =
        buildTrainingDataset(rows, timeline);

    const featureRows = [];
    const featureExclusions = [];
    let radiantWins = 0;

    const positionProfile = extractor.catalog.positionProfile;

    const missingPositionData = new Set(
        (positionProfile?.heroes ?? [])
            .filter(hero => hero.classifiedMatches === 0)
            .map(hero => hero.heroId)
    );

    for (const match of matches) {
        if (match.patch.name !== patch) {
            featureExclusions.push({
                matchId: match.matchId,
                startedAt: match.startedAt,
                patch: match.patch.name,
                reason: "profile_patch_mismatch",
            });
            continue;
        }

        const missingHeroIds = [
            ...match.radiantHeroIds,
            ...match.direHeroIds,
        ].filter(id => missingPositionData.has(id));

        if (missingHeroIds.length) {
            featureExclusions.push({
                matchId: match.matchId,
                startedAt: match.startedAt,
                patch: match.patch.name,
                reason: "position_observations_missing",
                heroIds: missingHeroIds.sort((a, b) => a - b),
            });

            continue;
        }

        let values;
        try {
            values = extractor.extract(
                match.radiantHeroIds,
                match.direHeroIds
            ).values;

            if (values.length !== extractor.featureNames.length
                || !values.every(Number.isFinite)) {
                throw new Error("Invalid feature vector.");
            }
        } catch {
            throw new TrainingExportError(
                `Could not extract features for match ${match.matchId}. Check its hero IDs and the hero catalog.`
            );
        }

        const target = Number(match.didRadiantWin);
        radiantWins += target;

        // Only values are model inputs. The outcome is a separate training label;
        // matchId and startedAt support auditing and chronological splitting.
        featureRows.push({
            schema: 1,
            matchId: match.matchId,
            startedAt: match.startedAt,
            patch: match.patch.name,
            values,
            target,
        });
    }

    const features = {
        featureSchema: extractor.featureSchema,
        profileSha256: extractor.profileSha256,
        profilePatch: patch,
        heroes: extractor.catalog.heroes.length,
        featureCount: extractor.featureNames.length,
        matches: featureRows.length,
        excludedMatches: featureExclusions.length,
        radiantWins,
        direWins: featureRows.length - radiantWins,
        ...(positionProfile ? {
            positionProfileUpdatedAt: positionProfile.sourceUpdatedAt,
            positionWindowComplete: positionProfile.window.complete,
        } : {}),
    };

    const featureSpec = {
        schema: 1,
        featureSchema: extractor.featureSchema,
        profileSha256: extractor.profileSha256,
        profilePatch: patch,
        orientation: "radiant-minus-dire",
        target: {
            field: "target",
            one: "radiant-win",
            zero: "dire-win",
        },
        source,
        featureNames: extractor.featureNames,
        catalog: extractor.catalog,
    };

    const jsonl = records =>
        records.map(record => JSON.stringify(record)).join("\n")
        + (records.length ? "\n" : "");

    const files = {
        "matches.jsonl": jsonl(matches),
        "unresolvedMatches.jsonl": jsonl(unresolvedMatches),
        "patchTimeline.json": JSON.stringify(timeline, null, 2) + "\n",
        "features.jsonl": jsonl(featureRows),
        "featureExclusions.jsonl": jsonl(featureExclusions),
        "featureSpec.json": JSON.stringify(featureSpec, null, 2) + "\n",
    };

    const manifest = {
        schema: 2,
        matchSchema: 2,
        exportedAt: new Date().toISOString(),
        summary,
        features,
        files: Object.fromEntries(
            Object.entries(files).map(([name, content]) => [name, {
                bytes: Buffer.byteLength(content, "utf8"),
                sha256: createHash("sha256").update(content).digest("hex"),
            }])
        ),
    };

    const destination = join(output, `dataset-${randomUUID()}`);
    let temporary;

    try {
        await mkdir(output, { recursive: true });
        temporary = await mkdtemp(join(output, "pending-"));

        for (const [name, content] of Object.entries(files)) {
            await writeFile(join(temporary, name), content, {
                encoding: "utf8",
                flag: "wx",
            });
        }

        await writeFile(
            join(temporary, "manifest.json"),
            JSON.stringify(manifest, null, 2) + "\n",
            { encoding: "utf8", flag: "wx" }
        );

        // Publish the completed bundle together.
        await rename(temporary, destination);
    } catch {
        throw new TrainingExportError(
            "Could not save the export. Check folder permissions and free space."
        );
    } finally {
        if (temporary) {
            await rm(temporary, { recursive: true, force: true }).catch(() => { });
        }
    }

    return {
        directory: relative(ROOT, destination).replaceAll("\\", "/"),
        ...summary,
        features,
    };
}

module.exports = { exportTrainingMatches };

if (require.main === module) {
    const args = process.argv.slice(2);

    const valid = args.length === 0
        || (
            args.length === 2
            && args[0] === "--feature-spec"
            && args[1].trim()
        );

    if (!valid) {
        console.error(
            `Usage: node scripts/exportTrainingMatches.cjs
            [--feature-spec training-data/dataset-ID/featureSpec.json]`
        );

        process.exitCode = 1;
    } else {
        exportTrainingMatches(OUTPUT, args[1] ?? null).then(summary => {
            console.log(JSON.stringify(summary, null, 2));
        }).catch(error => {
            console.error(error instanceof TrainingExportError
                ? error.message
                : "Training export failed unexpectedly. No export was saved.");

            process.exitCode = 1;
        });
    }
}