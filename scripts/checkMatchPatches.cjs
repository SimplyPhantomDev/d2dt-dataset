const { resolve } = require("node:path");
const { neon } = require("@neondatabase/serverless");
const {
    fetchPatchTimeline,
    createPatchResolver,
} = require("../server/matchPatch.cjs");

require("dotenv").config({
    path: resolve(__dirname, "../.env"),
    quiet: true,
});

async function checkMatchPatches() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required.");
    }

    const timeline = await fetchPatchTimeline();
    const resolvePatch = createPatchResolver(timeline);

    let rows;

    try {
        const sql = neon(process.env.DATABASE_URL, {
            fetchOptions: { signal: AbortSignal.timeout(30000) },
        });

        rows = await sql`
            SELECT 'public' AS source,
                match_data ->> 'startedAt' AS started_at
            FROM public.public_match_samples

            UNION ALL

            SELECT 'verified' AS source,
                c.match_data ->> 'startedAt' AS started_at
            FROM public.stratz_match_cache c
            WHERE c.schema = 1
                AND EXISTS (
                    SELECT 1 FROM public.match_reports r
                    WHERE r.match_id = c.match_id
                        AND r.verification = 'verified'
                )
        `;
    } catch {
        throw new Error(
            "Could not read match dates. Check DATABASE_URL and migrations 001–005."
        );
    }

    const bucket = () => ({
        matches: 0,
        byInferredPatch: {},
        unresolved: {},
    });

    const summary = {
        catalogSource: timeline.source,
        catalogFetchedAt: timeline.fetchedAt,
        catalogPatches: timeline.patches.length,
        latestCatalogPatch: timeline.patches.at(-1).name,
        boundaryBufferHours: timeline.boundaryBufferHours,
        public: bucket(),
        verified: bucket(),
    };

    for (const row of rows) {
        const group = summary[row.source];
        const patch = resolvePatch(row.started_at);

        group.matches++;

        const counts = patch.name === null
            ? group.unresolved
            : group.byInferredPatch;

        const key = patch.name ?? patch.reason;
        counts[key] = (counts[key] ?? 0) + 1;
    }

    return summary;
}

module.exports = { checkMatchPatches };

if (require.main === module) {
    checkMatchPatches().then(summary => {
        console.log(JSON.stringify(summary, null, 2));
    }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}