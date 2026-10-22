const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const fetchPositionHours = require("./fetchPositionHours.cjs");

const HISTORY_PATH = path.resolve(
    __dirname,
    "../rankedPositionHistory.json"
);

const SOURCE = "stratz.heroStats.winHour";
const POSITIONS = [null, 1, 2, 3, 4, 5];
const RETENTION_HOURS = 8 * 24;
const HOUR = 3600;

function normalizeFilters(filters) {
    const names = ["bracketIds", "gameModeIds", "regionIds"];

    if (
        !filters ||
        typeof filters !== "object" ||
        Array.isArray(filters) ||
        Object.keys(filters).length !== names.length
    ) {
        throw new Error("Invalid position history filters.");
    }

    return Object.fromEntries(
        names.map(name => {
            const values = filters[name];

            if (values === null) return [name, null];

            if (
                !Array.isArray(values) ||
                !values.length ||
                !values.every(
                    value =>
                        typeof value === "string" &&
                        /^[A-Z][A-Z0-9_]*$/.test(value)
                ) ||
                new Set(values).size !== values.length
            ) {
                throw new Error(
                    `Invalid position history filter: ${name}.`
                );
            }

            return [name, [...values].sort()];
        })
    );
}

function validateRecord(row) {
    if (
        !row ||
        !Number.isSafeInteger(row.heroId) ||
        row.heroId <= 0 ||
        !POSITIONS.includes(row.position) ||
        !Number.isSafeInteger(row.hour) ||
        row.hour <= 0 ||
        row.hour % HOUR !== 0 ||
        !Number.isSafeInteger(row.winCount) ||
        row.winCount < 0 ||
        !Number.isSafeInteger(row.matchCount) ||
        row.matchCount < row.winCount
    ) {
        throw new Error("Invalid position history record.");
    }
}

async function updatePositionHistory() {
    let previous = null;

    try {
        previous = JSON.parse(
            await fs.readFile(HISTORY_PATH, "utf8")
        );

        if (
            !previous ||
            previous.schema !== 1 ||
            previous.source !== SOURCE ||
            !Array.isArray(previous.records) ||
            !Number.isFinite(Date.parse(previous.updatedAt))
        ) {
            throw new Error(
                "Invalid saved position history format."
            );
        }

        normalizeFilters(previous.filters);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    const fresh = await fetchPositionHours();
    const fetchedAt = Date.parse(fresh?.fetchedAt);

    if (
        fresh?.schema !== 1 ||
        fresh.source !== SOURCE ||
        !Array.isArray(fresh.records) ||
        !Number.isFinite(fetchedAt)
    ) {
        throw new Error("Invalid position collection format.");
    }

    const filters = normalizeFilters(fresh.filters);

    if (
        previous &&
        JSON.stringify(normalizeFilters(previous.filters)) !==
        JSON.stringify(filters)
    ) {
        throw new Error(
            "Position filters changed. Use a separate archive for the new population."
        );
    }

    if (
        previous &&
        fetchedAt < Date.parse(previous.updatedAt)
    ) {
        throw new Error(
            "Collection timestamp is older than the saved position history."
        );
    }

    // Retain completed hours from each slice independently.
    const end =
        Math.floor(fetchedAt / (HOUR * 1000)) * HOUR;

    const start = end - RETENTION_HOURS * HOUR;
    const records = new Map();
    const acceptedPositions = new Set();

    let added = 0;
    let revised = 0;

    function merge(rows, isFresh) {
        const seen = new Set();

        for (const row of rows) {
            validateRecord(row);

            const key =
                `${row.position ?? "all"}:${row.heroId}:${row.hour}`;

            if (seen.has(key)) {
                throw new Error(
                    "Duplicate position history record."
                );
            }

            seen.add(key);

            if (row.hour < start || row.hour >= end) continue;

            const old = records.get(key);

            if (isFresh) {
                acceptedPositions.add(row.position);

                if (!old) {
                    added++;
                } else if (
                    old.matchCount !== row.matchCount ||
                    old.winCount !== row.winCount
                ) {
                    revised++;
                }
            }

            // These are snapshots:
            // a revised row replaces its previous counts.
            records.set(key, {
                heroId: row.heroId,
                hour: row.hour,
                position: row.position,
                matchCount: row.matchCount,
                winCount: row.winCount,
            });
        }
    }

    if (previous) merge(previous.records, false);
    merge(fresh.records, true);

    if (
        !POSITIONS.every(position =>
            acceptedPositions.has(position)
        )
    ) {
        throw new Error(
            "Collection lacks completed records for one or more position slices."
        );
    }

    const sorted = [...records.values()].sort(
        (a, b) =>
            a.hour - b.hour ||
            a.heroId - b.heroId ||
            (a.position ?? 0) - (b.position ?? 0)
    );

    const history = {
        schema: 1,
        source: SOURCE,
        filters,
        updatedAt: fresh.fetchedAt,
        retentionHours: RETENTION_HOURS,
        records: sorted,
    };

    // Complete a uniquely named temporary file
    // before replacing the archive.
    const temporaryPath =
        `${HISTORY_PATH}.${randomUUID()}.tmp`;

    try {
        await fs.writeFile(
            temporaryPath,
            JSON.stringify(history, null, 2) + "\n",
            "utf8"
        );

        await fs.rename(temporaryPath, HISTORY_PATH);
    } finally {
        await fs.rm(temporaryPath, { force: true });
    }

    const hourSets = POSITIONS.map(
        position =>
            new Set(
                sorted
                    .filter(row => row.position === position)
                    .map(row => row.hour)
            )
    );

    const commonHours = [...hourSets[0]].filter(
        hour => hourSets.every(set => set.has(hour))
    );

    const slices = POSITIONS.map((position, index) => {
        const rows = sorted.filter(
            row => row.position === position
        );

        return {
            position,
            storedRecords: rows.length,
            storedHours: hourSets[index].size,
            earliestHour: new Date(
                rows[0].hour * 1000
            ).toISOString(),
            latestHour: new Date(
                rows[rows.length - 1].hour * 1000
            ).toISOString(),
        };
    });

    return {
        historyFile: path.basename(HISTORY_PATH),
        filters,
        requests: fresh.requests,
        addedRecords: added,
        revisedRecords: revised,
        storedRecords: sorted.length,
        commonStoredHours: commonHours.length,
        slices,
    };
}

module.exports = updatePositionHistory;

if (require.main === module) {
    updatePositionHistory()
        .then(summary =>
            console.log(JSON.stringify(summary, null, 2))
        )
        .catch(error => {
            console.error(
                "Position history update failed:",
                error.message
            );
            process.exitCode = 1;
        });
}