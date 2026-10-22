const { resolve } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { neon } = require("@neondatabase/serverless");
const {
    collectPublicMatches,
    PUBLIC_MATCH_COLLECTION,
} = require("./collectPublicMatches.cjs");

require("dotenv").config({
    path: resolve(__dirname, "../.env"),
    quiet: true,
});

const DAY = 86400000;
const PREFIX = `${PUBLIC_MATCH_COLLECTION}:hour:`;

function buildSamplingPlan(days = 7, now = Date.now()) {
    if (!Number.isInteger(days) || days < 1 || days > 28) {
        throw new Error("The day count must be an integer from 1 to 28.");
    }

    // Complete UTC days whose final hour ended at least 24 hours ago.
    const end = (Math.floor(now / DAY) - 1) * DAY;
    const start = end - days * DAY;
    const hours = [];

    for (let round = 0; round < 24; round++) {
        for (let day = 0; day < days; day++) {
            // 7 and 24 are coprime: every hour appears once per day.
            // Offset each day to spread initial visits across times of day.
            const hour = (round * 7 + day * 5) % 24;

            hours.push(
                new Date(start + day * DAY + hour * 3600000)
                    .toISOString()
                    .slice(0, 13)
            );
        }
    }

    return {
        fromUtc: new Date(start).toISOString(),
        toUtcExclusive: new Date(end).toISOString(),
        hours,
    };
}

async function samplePublicMatches(windowLimit = 7, days = 7) {
    if (
        !Number.isInteger(windowLimit)
        || windowLimit < 1
        || windowLimit > 20
    ) {
        throw new Error("The window limit must be an integer from 1 to 20.");
    }

    const plan = buildSamplingPlan(days);

    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required.");
    }

    const deadline = performance.now() + 4 * 60 * 1000;

    let states;

    try {
        const sql = neon(process.env.DATABASE_URL, {
            fetchOptions: { signal: AbortSignal.timeout(10000) },
        });

        states = await sql`
      SELECT name,
        EXTRACT(EPOCH FROM last_page_at)::double precision AS last_page_at,
        next_request_at <= clock_timestamp()
          AND (
            lease_expires_at IS NULL
            OR lease_expires_at <= clock_timestamp()
          ) AS ready
      FROM public.public_match_collection
      WHERE name LIKE ${`${PREFIX}%`}
    `;
    } catch {
        throw new Error(
            "Could not plan sampling. Check DATABASE_URL and migration 007."
        );
    }

    const byName = new Map(states.map(state => [state.name, state]));

    const candidates = plan.hours.map((hour, order) => ({
        hour,
        order,
        state: byName.get(`${PREFIX}${hour}`),
    })).filter(item =>
        item.state?.ready !== false
    ).sort((a, b) =>
        (a.state?.last_page_at ?? 0) - (b.state?.last_page_at ?? 0)
        || a.order - b.order
    ).slice(0, windowLimit);

    const summary = {
        fromUtc: plan.fromUtc,
        toUtcExclusive: plan.toUtcExclusive,
        plannedHours: plan.hours.length,
        visitedHours: 0,
        pages: 0,
        emptyHours: 0,
        requests: 0,
        received: 0,
        accepted: 0,
        inserted: 0,
        alreadyStored: 0,
        skipped: { otherMode: 0, incomplete: 0, unknownHero: 0 },
        stopReason: candidates.length === windowLimit
            ? "window_limit"
            : "no_more_ready_hours",
        windows: [],
    };

    for (const { hour } of candidates) {
        if (summary.visitedHours > 0) await pause(2500);

        if (performance.now() >= deadline) {
            summary.stopReason = "time_limit";
            break;
        }

        const page = await collectPublicMatches(null, hour);

        summary.visitedHours++;
        summary.requests += page.requests;
        summary.windows.push({
            hour,
            status: page.status,
            inserted: page.inserted ?? 0,
        });

        if (page.status === "not_ready") continue;

        if (page.status === "budget_exhausted") {
            summary.stopReason = page.status;
            summary.retryAt = page.retryAt;
            break;
        }

        if (page.status === "page_saved") summary.pages++;
        if (page.status === "empty_page") summary.emptyHours++;

        for (const key of ["received", "accepted", "inserted", "alreadyStored"]) {
            summary[key] += page[key];
        }

        for (const key of Object.keys(summary.skipped)) {
            summary.skipped[key] += page.skipped[key];
        }

        if (
            page.remainingRequests.day !== null
            && page.remainingRequests.day <= 100
        ) {
            summary.stopReason = "provider_budget_low";
            break;
        }
    }

    return summary;
}

module.exports = { samplePublicMatches, buildSamplingPlan };

if (require.main === module) {
    const parse = (value, fallback) => value === undefined
        ? fallback
        : /^[1-9][0-9]?$/.test(value) ? Number(value) : NaN;

    (process.argv.length > 4
        ? Promise.reject(
            new Error(
                "Usage: node scripts/samplePublicMatches.cjs [windows:1–20] [days:1–28]"
            )
        )
        : samplePublicMatches(
            parse(process.argv[2], 7),
            parse(process.argv[3], 7)
        )
    ).then(summary => {
        console.log(JSON.stringify(summary, null, 2));
    }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}