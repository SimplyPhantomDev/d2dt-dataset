const { resolve, join, relative } = require("node:path");
const { mkdir, mkdtemp, writeFile, rename, rm } = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { neon } = require("@neondatabase/serverless");
const { fetchPatchTimeline } = require("../server/matchPatch.cjs");
const {
    TrainingExportError,
    buildTrainingDataset,
} = require("../server/trainingMatches.cjs");

const ROOT = resolve(__dirname, "..");
const OUTPUT = resolve(ROOT, "training-data");

require("dotenv").config({
    path: resolve(ROOT, ".env"),
    quiet: true,
});

async function readTrainingMatches() {
    if (!process.env.DATABASE_URL) {
        throw new TrainingExportError("Add DATABASE_URL to the repository's .env file.");
    }

    try {
        const sql = neon(process.env.DATABASE_URL, {
            fetchOptions: { signal: AbortSignal.timeout(60000) },
        });

        // One snapshot: concurrent collection cannot change the source mix midway.
        // Cache PK + EXISTS count a verified match once, regardless of report count.
        return await sql`
            WITH verified AS (
                SELECT c.match_id, c.match_data
                FROM public.stratz_match_cache c
                WHERE c.schema = 1 AND EXISTS (
                    SELECT 1 FROM public.match_reports r
                    WHERE r.match_id = c.match_id AND r.verification = 'verified'
                )
            )
            SELECT COALESCE(p.match_id, v.match_id)::text AS match_id,
                            p.match_data AS public_data, v.match_data AS verified_data
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

async function exportTrainingMatches(output = OUTPUT) {
    const rows = await readTrainingMatches();

    let timeline;
    try {
        timeline = await fetchPatchTimeline();
    } catch {
        throw new TrainingExportError(
            "Could not fetch Valve's patch timeline. No export was saved; try again later."
        );
    }

    const { matches, unresolvedMatches, summary } = buildTrainingDataset(rows, timeline);
    const jsonl = records => records.map(record => JSON.stringify(record)).join("\n")
        + (records.length ? "\n" : "");

    const files = {
        "matches.jsonl": jsonl(matches),
        "unresolvedMatches.jsonl": jsonl(unresolvedMatches),
        "patchTimeline.json": JSON.stringify(timeline, null, 2) + "\n",
    };

    const manifest = {
        schema: 1,
        matchSchema: 2,
        exportedAt: new Date().toISOString(),
        summary,
        files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, {
            bytes: Buffer.byteLength(content, "utf8"),
            sha256: createHash("sha256").update(content).digest("hex"),
        }])),
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

        // Publish a complete bundle together. Previous exports remain untouched.
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
    };
}

module.exports = { exportTrainingMatches };

if (require.main === module) {
    exportTrainingMatches().then(summary => {
        console.log(JSON.stringify(summary, null, 2));
    }).catch(error => {
        console.error(error instanceof TrainingExportError
            ? error.message
            : "Training export failed unexpectedly. No export was saved.");
        process.exitCode = 1;
    });
}