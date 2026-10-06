const HOUR = 3600;
const DAY = 24 * HOUR;
const REQUIRED_HOURS = 7 * 24;

function buildHeroWinrates(history, heroIds, now = Date.now()) {
  if (
    history?.schema !== 1 || history.scope !== "unfiltered" ||
    !Array.isArray(history.records)
  ) {
    throw new Error("Invalid hourly history format or query scope");
  }

  if (
    !Array.isArray(heroIds) || heroIds.length === 0 ||
    !heroIds.every(id => Number.isSafeInteger(id) && id > 0) ||
    new Set(heroIds).size !== heroIds.length
  ) {
    throw new Error("Invalid or duplicate expected hero IDs");
  }

  if (!Number.isFinite(now) || now <= 0) {
    throw new Error("Invalid aggregation timestamp");
  }

  // Use the same seven completed UTC days for every hero.
  // Today's hours are excluded even if some have already been collected.
  const end = Math.floor(now / (DAY * 1000)) * DAY;
  const start = end - REQUIRED_HOURS * HOUR;
  const totals = new Map(heroIds.map(id => [id, {
    winCount: 0,
    matchCount: 0,
    hours: new Set(),
  }]));

  for (const row of history.records) {
    if (
      ![row?.heroId, row?.hour, row?.winCount, row?.matchCount]
        .every(Number.isSafeInteger) ||
      row.heroId <= 0 || row.hour <= 0 || row.hour % HOUR !== 0 ||
      row.winCount < 0 || row.matchCount < row.winCount
    ) {
      throw new Error("Invalid hourly history record");
    }

    const total = totals.get(row.heroId);
    if (!total || row.hour < start || row.hour >= end) continue;

    if (total.hours.has(row.hour)) {
      throw new Error(`Duplicate hourly record for hero ${row.heroId}`);
    }

    total.hours.add(row.hour);
    total.winCount += row.winCount;
    total.matchCount += row.matchCount;

    if (
      !Number.isSafeInteger(total.winCount) ||
      !Number.isSafeInteger(total.matchCount)
    ) {
      throw new Error("Aggregated counts exceed safe integer precision");
    }
  }

  const summary = {
    ready: false,
    scope: history.scope,
    windowStart: new Date(start * 1000).toISOString(),
    windowEnd: new Date(end * 1000).toISOString(),
    requiredHours: REQUIRED_HOURS,
    minimumHeroHours: Math.min(
      ...[...totals.values()].map(total => total.hours.size)
    ),
    heroesExpected: heroIds.length,
  };

  // Missing hours are not assumed to contain zero matches.
  // An incomplete week stays unavailable instead of producing partial rates.
  if (summary.minimumHeroHours !== REQUIRED_HOURS) {
    return {
      ...summary,
      reason: "Incomplete hourly coverage",
      heroes: {},
    };
  }

  if ([...totals.values()].some(total => total.matchCount === 0)) {
    return {
      ...summary,
      reason: "No matches for one or more heroes",
      heroes: {},
    };
  }

  return {
    ...summary,
    ready: true,
    heroes: Object.fromEntries([...totals].map(([heroId, total]) => [heroId, {
      winCount: total.winCount,
      matchCount: total.matchCount,
      // Store a fraction from 0 to 1 at full precision; round only for display.
      winRate: total.winCount / total.matchCount,
    }])),
  };
}

module.exports = buildHeroWinrates;

// Running this file directly checks readiness without changing dataset files.
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");

  try {
    const history = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, "../winrateHistory.json"), "utf8"
    ));
    const heroes = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, "../heroes.json"), "utf8"
    ));

    if (!Array.isArray(heroes)) throw new Error("Invalid heroes.json");
    const heroIds = heroes.map(hero => hero?.HeroId ?? hero?.heroId ?? hero?.id);
    const { heroes: rates, ...summary } = buildHeroWinrates(history, heroIds);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error("Winrate aggregation failed:", error.message);
    process.exitCode = 1;
  }
}