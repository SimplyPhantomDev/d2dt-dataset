const { setTimeout: pause } = require("node:timers/promises");
const { collectPublicMatches } = require("./collectPublicMatches.cjs");

async function collectPublicMatchBatch(pageLimit = 5) {
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 20) {
        throw new Error("The page limit must be an integer from 1 to 20.");
    }

    const deadline = performance.now() + 4 * 60 * 1000;

    const summary = {
        pages: 0,
        requests: 0,
        received: 0,
        accepted: 0,
        inserted: 0,
        alreadyStored: 0,
        skipped: {
            otherMode: 0,
            incomplete: 0,
            unknownHero: 0,
        },
        nextCursor: null,
        stopReason: "page_limit",
    };

    for (let index = 0; index < pageLimit; index++) {
        if (index > 0) await pause(2500);

        if (performance.now() >= deadline) {
            summary.stopReason = "time_limit";
            break;
        }

        // Every page resumes from the checkpoint stored in Neon.
        const page = await collectPublicMatches();

        summary.requests += page.requests;
        summary.nextCursor = page.nextCursor;

        if (page.status !== "page_saved") {
            summary.stopReason = page.status;
            summary.retryAt = page.retryAt ?? null;
            break;
        }

        summary.pages++;

        for (const key of ["received", "accepted", "inserted", "alreadyStored"]) {
            summary[key] += page[key];
        }

        for (const key of Object.keys(summary.skipped)) {
            summary.skipped[key] += page.skipped[key];
        }

        if (page.remainingRequests.day !== null && page.remainingRequests.day <= 100) {
            summary.stopReason = "provider_budget_low";
            break;
        }
    }

    return summary;
}

module.exports = { collectPublicMatchBatch };

if (require.main === module) {
    const argument = process.argv[2] ?? "5";
    const limit = /^(?:[1-9]|1[0-9]|20)$/.test(argument)
        ? Number(argument)
        : NaN;

    (process.argv.length > 3
        ? Promise.reject(
            new Error("Usage: node scripts/collectPublicMatchBatch.cjs [1–20]")
        )
        : collectPublicMatchBatch(limit)
    ).then(summary => {
        console.log(JSON.stringify(summary, null, 2));
    }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}