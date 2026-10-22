const HOUR = 3600;
const REQUIRED_HOURS = 7 * 24;
const POSITIONS = [null, 1, 2, 3, 4, 5];

function addCount(target, key, amount) {
    const value = target[key] + amount;

    if (!Number.isSafeInteger(value)) {
        throw new Error(
            "Aggregated counts exceed safe integer precision."
        );
    }

    target[key] = value;
}

// Sampling uncertainty for one position's share among classified matches.
// This does not measure bias caused by unclassified or missing observations.
function shareInterval95(count, total) {
    if (total === 0) return null;

    const z = 1.959963984540054;
    const p = count / total;
    const denominator = 1 + z * z / total;
    const center =
        (p + z * z / (2 * total)) / denominator;

    const radius =
        z *
        Math.sqrt(
            p * (1 - p) / total +
            z * z / (4 * total * total)
        ) /
        denominator;

    return {
        lower:
            count === 0
                ? 0
                : Math.max(0, center - radius),

        upper:
            count === total
                ? 1
                : Math.min(1, center + radius),
    };
}

function buildHeroPositionProfiles(history, heroIds) {
    if (
        history?.schema !== 1 ||
        history.source !== "stratz.heroStats.winHour" ||
        !Array.isArray(history.records) ||
        typeof history.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(history.updatedAt))
    ) {
        throw new Error("Invalid ranked position history.");
    }

    const filters = {};
    const names = ["bracketIds", "gameModeIds", "regionIds"];

    if (
        !history.filters ||
        Object.keys(history.filters).length !== names.length
    ) {
        throw new Error("Invalid position history filters.");
    }

    for (const name of names) {
        const value = history.filters[name];

        if (
            value !== null &&
            (
                !Array.isArray(value) ||
                !value.length ||
                !value.every(
                    item =>
                        typeof item === "string" &&
                        /^[A-Z][A-Z0-9_]*$/.test(item)
                ) ||
                new Set(value).size !== value.length
            )
        ) {
            throw new Error(`Invalid position filter: ${name}.`);
        }

        filters[name] =
            value === null ? null : [...value].sort();
    }

    if (
        filters.gameModeIds?.length !== 1 ||
        filters.gameModeIds[0] !== "ALL_PICK_RANKED"
    ) {
        throw new Error(
            "Position profiles require Ranked All Pick history."
        );
    }

    if (
        !Array.isArray(heroIds) ||
        !heroIds.length ||
        !heroIds.every(
            id => Number.isSafeInteger(id) && id > 0
        ) ||
        new Set(heroIds).size !== heroIds.length
    ) {
        throw new Error(
            "Invalid or duplicate expected hero IDs."
        );
    }

    const ids = [...heroIds].sort((a, b) => a - b);
    const known = new Set(ids);
    const unknown = new Set();
    const seen = new Set();
    const hourSets = POSITIONS.map(() => new Set());

    const completedEnd =
        Math.floor(
            Date.parse(history.updatedAt) / (HOUR * 1000)
        ) * HOUR;

    for (const row of history.records) {
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
            row.matchCount < row.winCount ||
            row.hour >= completedEnd
        ) {
            throw new Error(
                "Invalid or unfinished hourly position record."
            );
        }

        const key =
            `${row.heroId}:${row.hour}:${row.position ?? 0}`;

        if (seen.has(key)) {
            throw new Error(
                "Duplicate hourly position record."
            );
        }

        seen.add(key);

        if (!known.has(row.heroId)) {
            unknown.add(row.heroId);
        } else {
            hourSets[row.position ?? 0].add(row.hour);
        }
    }

    const shared = [...hourSets[0]].filter(
        hour => hourSets.every(set => set.has(hour))
    );

    if (!shared.length) {
        throw new Error(
            "No completed hour is shared by all six position slices."
        );
    }

    // Anchor the seven-day target to the latest shared, completed data hour.
    // Export partial coverage explicitly while collection is still filling it.
    const end =
        shared.reduce(
            (latest, hour) => Math.max(latest, hour),
            0
        ) + HOUR;

    const start = end - REQUIRED_HOURS * HOUR;
    const hours = new Set(
        shared.filter(hour => hour >= start)
    );

    const buckets = new Map();

    for (const row of history.records) {
        if (
            !known.has(row.heroId) ||
            !hours.has(row.hour)
        ) {
            continue;
        }

        const key = `${row.heroId}:${row.hour}`;

        if (!buckets.has(key)) {
            buckets.set(key, {
                heroId: row.heroId,
                rows: Array(6).fill(null),
            });
        }

        buckets.get(key).rows[row.position ?? 0] = row;
    }

    const totals = new Map(
        ids.map(heroId => [
            heroId,
            {
                heroId,
                usableHours: 0,
                excludedMissingBaselineHours: 0,
                excludedInconsistentHours: 0,
                baselineMatches: 0,
                baselineWins: 0,
                positions: [1, 2, 3, 4, 5].map(position => ({
                    position,
                    matches: 0,
                    wins: 0,
                    observedHours: 0,
                })),
            },
        ])
    );

    for (const bucket of buckets.values()) {
        const total = totals.get(bucket.heroId);
        const baseline = bucket.rows[0];

        if (!baseline) {
            total.excludedMissingBaselineHours++;
            continue;
        }

        const classified = { matches: 0, wins: 0 };

        for (const row of bucket.rows.slice(1)) {
            if (!row) continue;

            addCount(classified, "matches", row.matchCount);
            addCount(classified, "wins", row.winCount);
        }

        // A valid remainder must contain nonnegative wins AND losses.
        if (
            classified.matches > baseline.matchCount ||
            classified.wins > baseline.winCount ||
            classified.matches - classified.wins >
            baseline.matchCount - baseline.winCount
        ) {
            total.excludedInconsistentHours++;
            continue;
        }

        total.usableHours++;

        addCount(
            total,
            "baselineMatches",
            baseline.matchCount
        );

        addCount(
            total,
            "baselineWins",
            baseline.winCount
        );

        for (let position = 1; position <= 5; position++) {
            const row = bucket.rows[position];
            if (!row) continue;

            const target = total.positions[position - 1];

            addCount(target, "matches", row.matchCount);
            addCount(target, "wins", row.winCount);

            target.observedHours++;
        }
    }

    const heroes = [...totals.values()].map(total => {
        const classified = { matches: 0, wins: 0 };

        for (const position of total.positions) {
            addCount(classified, "matches", position.matches);
            addCount(classified, "wins", position.wins);
        }

        return {
            ...total,
            classifiedMatches: classified.matches,
            classifiedWins: classified.wins,

            unreconciledMatches:
                total.baselineMatches - classified.matches,

            unreconciledWins:
                total.baselineWins - classified.wins,

            classificationCoverage:
                total.baselineMatches
                    ? classified.matches / total.baselineMatches
                    : null,

            positions: total.positions.map(position => ({
                ...position,

                // Conditional frequency among observed, classified matches.
                observedShare:
                    classified.matches
                        ? position.matches / classified.matches
                        : null,

                shareInterval95: shareInterval95(
                    position.matches,
                    classified.matches
                ),
            })),
        };
    });

    return {
        schema: 1,
        profileSchema: "hero-position-observations-v1",
        source: history.source,
        sourceUpdatedAt: history.updatedAt,
        filters,
        sharePopulation:
            "classified-matches-in-usable-hero-hours",
        shareIntervalMethod: "marginal-wilson-95",

        window: {
            start: new Date(start * 1000).toISOString(),
            end: new Date(end * 1000).toISOString(),
            requiredHours: REQUIRED_HOURS,
            commonHoursObserved: hours.size,
            complete: hours.size === REQUIRED_HOURS,
        },

        ignoredUnknownHeroIds:
            [...unknown].sort((a, b) => a - b),

        heroes,
    };
}

module.exports = buildHeroPositionProfiles;

if (require.main === module) {
    const fs = require("node:fs/promises");
    const path = require("node:path");

    const {
        createHash,
        randomUUID,
    } = require("node:crypto");

    async function main() {
        const root = path.resolve(__dirname, "..");

        const [historyText, heroesText] = await Promise.all([
            fs.readFile(
                path.join(root, "rankedPositionHistory.json"),
                "utf8"
            ),
            fs.readFile(
                path.join(root, "heroes.json"),
                "utf8"
            ),
        ]);

        const metadata = JSON.parse(heroesText);

        if (!Array.isArray(metadata)) {
            throw new Error("Invalid heroes.json.");
        }

        const profile = buildHeroPositionProfiles(
            JSON.parse(historyText),
            metadata.map(hero => hero?.HeroId)
        );

        const hash = text =>
            createHash("sha256")
                .update(text.replace(/\r\n/g, "\n"))
                .digest("hex");

        const output = {
            ...profile,
            generatedAt: new Date().toISOString(),
            sourceHashNormalization: "lf",
            sourceHistorySha256: hash(historyText),
            sourceHeroesSha256: hash(heroesText),
        };

        const target = path.join(
            root,
            "heroPositionProfiles.json"
        );

        const temporary = `${target}.${randomUUID()}.tmp`;

        try {
            await fs.writeFile(
                temporary,
                JSON.stringify(output, null, 2) + "\n",
                "utf8"
            );

            await fs.rename(temporary, target);
        } finally {
            await fs.rm(temporary, { force: true });
        }

        const names = new Map(
            metadata.map(hero => [hero.HeroId, hero.name])
        );

        console.log(
            JSON.stringify(
                {
                    profileFile: path.basename(target),
                    heroes: profile.heroes.length,
                    window: profile.window,
                    ignoredUnknownHeroIds:
                        profile.ignoredUnknownHeroIds,

                    excludedHeroHours: profile.heroes.reduce(
                        (n, hero) =>
                            n +
                            hero.excludedMissingBaselineHours +
                            hero.excludedInconsistentHours,
                        0
                    ),

                    examples: profile.heroes
                        .filter(hero =>
                            [57, 155].includes(hero.heroId)
                        )
                        .map(hero => ({
                            hero: names.get(hero.heroId),
                            classifiedMatches:
                                hero.classifiedMatches,
                            classificationCoverage:
                                hero.classificationCoverage,

                            positions: hero.positions.map(position => ({
                                position: position.position,
                                matches: position.matches,

                                sharePercent:
                                    position.observedShare === null
                                        ? null
                                        : Number(
                                            (
                                                position.observedShare * 100
                                            ).toFixed(2)
                                        ),
                            })),
                        })),
                },
                null,
                2
            )
        );
    }

    main().catch(error => {
        console.error(
            "Position profile generation failed:",
            error.message
        );

        process.exitCode = 1;
    });
}