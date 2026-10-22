const { stratzQuery } = require("../server/stratzApi.cjs");

// null means the unfiltered baseline, not STRATZ's UNKNOWN category.
const POSITIONS = [null, 1, 2, 3, 4, 5];
const GAME_MODE_IDS = Object.freeze(["ALL_PICK_RANKED"]);

async function fetchPositionHours() {
    const startedAt = new Date().toISOString();
    const deadline = Date.now() + 4 * 60 * 1000;
    const records = [];
    let requests = 0;

    for (const position of POSITIONS) {
        const label =
            position === null ? "allPositions" : `POSITION_${position}`;

        const filter =
            position === null ? "" : `, positionIds: [${label}]`;

        const query = `
            query PositionWinHours(
                $take: Int!
                $skip: Int!
                $gameModeIds: [GameModeEnumType!]!
            ) {
                heroStats {
                    winHour(take: $take, skip: $skip, gameModeIds: $gameModeIds${filter}) {
                        heroId
                        hour
                        matchCount
                        winCount
                    }
                }
            }
        `;

        const collected = new Map();
        let skip = 0;
        let finished = false;

        for (let page = 0; page < 100; page++) {
            if (Date.now() >= deadline) {
                throw new Error(
                    "Position collection exceeded its four-minute budget."
                );
            }

            if (requests > 0) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            const body = await stratzQuery(query, {
                take: 100,
                skip,
                gameModeIds: GAME_MODE_IDS,
            });
            requests++;

            const rows = body.data?.heroStats?.winHour;

            if (!Array.isArray(rows)) {
                throw new Error(
                    `STRATZ returned no winHour array for ${label}.`
                );
            }

            // A short page is not proof of completion:
            // the API has dynamic limits.
            if (rows.length === 0) {
                if (collected.size === 0) {
                    throw new Error(
                        `STRATZ returned no hourly data for ${label}.`
                    );
                }

                finished = true;
                break;
            }

            let added = 0;

            for (const row of rows) {
                if (
                    !row ||
                    !Number.isSafeInteger(row.heroId) ||
                    row.heroId <= 0 ||
                    !Number.isSafeInteger(row.hour) ||
                    row.hour <= 0 ||
                    row.hour % 3600 !== 0 ||
                    !Number.isSafeInteger(row.winCount) ||
                    row.winCount < 0 ||
                    !Number.isSafeInteger(row.matchCount) ||
                    row.matchCount < row.winCount
                ) {
                    throw new Error(
                        `STRATZ returned an invalid record for ${label}.`
                    );
                }

                const key = `${row.heroId}:${row.hour}`;

                if (!collected.has(key)) added++;

                collected.set(key, {
                    heroId: row.heroId,
                    hour: row.hour,
                    position,
                    matchCount: row.matchCount,
                    winCount: row.winCount,
                });
            }

            if (added === 0) {
                throw new Error(
                    `Pagination stopped making progress for ${label}.`
                );
            }

            skip += rows.length;
        }

        if (!finished) {
            throw new Error(
                `Pagination exceeded 100 pages for ${label}.`
            );
        }

        for (const row of collected.values()) {
            records.push(row);
        }
    }

    records.sort(
        (a, b) =>
            a.hour - b.hour ||
            a.heroId - b.heroId ||
            (a.position ?? 0) - (b.position ?? 0)
    );

    return {
        schema: 1,
        source: "stratz.heroStats.winHour",
        startedAt,
        fetchedAt: new Date().toISOString(),

        // Ranked All Pick; rank and region selections use provider defaults.
        filters: {
            bracketIds: null,
            gameModeIds: [...GAME_MODE_IDS],
            regionIds: null,
        },

        requests,
        records,
    };
}

module.exports = fetchPositionHours;

if (require.main === module) {
    fetchPositionHours()
        .then(result => {
            const slices = POSITIONS.map(position => {
                const rows = result.records.filter(
                    row => row.position === position
                );

                return {
                    position,
                    records: rows.length,
                    heroes: new Set(rows.map(row => row.heroId)).size,
                    hours: new Set(rows.map(row => row.hour)).size,
                    earliestHour: new Date(
                        rows[0].hour * 1000
                    ).toISOString(),
                    latestHour: new Date(
                        rows[rows.length - 1].hour * 1000
                    ).toISOString(),
                };
            });

            console.log(
                JSON.stringify(
                    {
                        fetchedAt: result.fetchedAt,
                        requests: result.requests,
                        records: result.records.length,
                        filters: result.filters,
                        slices,
                    },
                    null,
                    2
                )
            );
        })
        .catch(error => {
            console.error(
                "Position collection failed:",
                error.message
            );
            process.exitCode = 1;
        });
}