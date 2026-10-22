const SOURCE = "https://www.dota2.com/datafeed/patchnoteslist?language=english";
const BUFFER = 24 * 60 * 60 * 1000;

function isoTime(value) {
    const time = typeof value === "string" ? Date.parse(value) : NaN;

    if (
        !Number.isFinite(time) || time <= 0
        || new Date(time).toISOString() !== value
    ) {
        throw new Error("Patch lookup requires a valid UTC ISO timestamp.");
    }

    return time;
}

function normalizePatchTimeline(body, fetchedAt = new Date().toISOString()) {
    const asOf = isoTime(fetchedAt);

    if (
        body?.success !== true
        || !Array.isArray(body.patches)
        || !body.patches.length
    ) {
        throw new Error("Valve returned an invalid patch history.");
    }

    const names = new Set();
    const times = new Set();
    const patches = [];

    for (const entry of body.patches) {
        if (
            typeof entry?.patch_number !== "string"
            || !/^\d+\.\d+[a-z]?$/i.test(entry.patch_number)
            || !Number.isSafeInteger(entry.patch_timestamp)
            || entry.patch_timestamp <= 0
            || !Number.isFinite(new Date(entry.patch_timestamp * 1000).getTime())
        ) {
            throw new Error("Valve returned an invalid patch-history entry.");
        }

        if (entry.patch_timestamp * 1000 > asOf) continue;

        const name = entry.patch_number.toLowerCase();

        if (names.has(name) || times.has(entry.patch_timestamp)) {
            throw new Error("Valve returned conflicting patch-history entries.");
        }

        names.add(name);
        times.add(entry.patch_timestamp);

        patches.push({
            name,
            releasedAt: new Date(entry.patch_timestamp * 1000).toISOString(),
        });
    }

    patches.sort((a, b) => a.releasedAt.localeCompare(b.releasedAt));

    if (!patches.length) {
        throw new Error("Valve returned no released patches.");
    }

    return {
        schema: 1,
        source: SOURCE,
        fetchedAt,
        boundaryBufferHours: 24,
        patches,
    };
}

async function fetchPatchTimeline() {
    let response;

    try {
        response = await fetch(SOURCE, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(20000),
        });
    } catch {
        throw new Error("Valve patch-history request failed or timed out.");
    }

    if (!response.ok) {
        throw new Error(
            `Valve patch-history request failed with HTTP ${response.status}.`
        );
    }

    let body;

    try {
        body = await response.json();
    } catch {
        throw new Error("Valve returned unreadable patch-history JSON.");
    }

    return normalizePatchTimeline(body);
}

function createPatchResolver(timeline) {
    if (
        timeline?.schema !== 1
        || timeline.source !== SOURCE
        || timeline.boundaryBufferHours !== 24
        || !Array.isArray(timeline.patches)
        || !timeline.patches.length
    ) {
        throw new Error("Invalid patch timeline.");
    }

    const asOf = isoTime(timeline.fetchedAt);

    // Copy the entries so later changes to the input cannot alter this lookup.
    const patches = timeline.patches.map(patch => ({
        name: patch?.name,
        releasedAt: patch?.releasedAt,
    }));

    const names = new Set();
    let previous = 0;

    const times = patches.map(patch => {
        const time = isoTime(patch.releasedAt);

        if (
            typeof patch.name !== "string"
            || !/^\d+\.\d+[a-z]?$/.test(patch.name)
            || names.has(patch.name)
            || time <= previous
            || time > asOf
        ) {
            throw new Error("Invalid patch timeline ordering or entries.");
        }

        names.add(patch.name);
        previous = time;
        return time;
    });

    return startedAt => {
        const time = isoTime(startedAt);

        if (time > asOf) {
            return { name: null, reason: "after_catalog" };
        }

        // Find the latest listed release at or before the match's start.
        let low = 0;
        let high = times.length;

        while (low < high) {
            const middle = Math.floor((low + high) / 2);

            if (times[middle] <= time) low = middle + 1;
            else high = middle;
        }

        const index = low - 1;

        if (index < 0) {
            return { name: null, reason: "before_history" };
        }

        if (
            time - times[index] <= BUFFER
            || (
                index + 1 < times.length
                && times[index + 1] - time <= BUFFER
            )
        ) {
            return { name: null, reason: "release_boundary" };
        }

        // An inference from release history, not a match-reported build ID.
        return { name: patches[index].name, reason: null };
    };
}

module.exports = {
    fetchPatchTimeline,
    normalizePatchTimeline,
    createPatchResolver,
};