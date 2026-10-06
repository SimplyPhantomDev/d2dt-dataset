const fs = require("fs/promises");
const path = require("path");
const fetchWinHours = require("./fetchWinHours");

const HISTORY_PATH = path.resolve(__dirname, "../winrateHistory.json");
const HOUR = 3600;
const WEEK_HOURS = 7 * 24;
const RETENTION_HOURS = 8 * 24;

function validateRecord(row) {
  if (
    !row ||
    !Number.isSafeInteger(row.heroId) ||
    row.heroId <= 0 ||
    !Number.isSafeInteger(row.hour) ||
    row.hour <= 0 ||
    row.hour % HOUR !== 0 ||
    !Number.isSafeInteger(row.winCount) ||
    row.winCount < 0 ||
    !Number.isSafeInteger(row.matchCount) ||
    row.matchCount < row.winCount
  ) {
    throw new Error("Invalid hourly history record");
  }
}

async function readHistory() {
  let text;

  try {
    text = await fs.readFile(HISTORY_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { schema: 1, scope: "unfiltered", records: [] };
    }

    throw error;
  }

  const history = JSON.parse(text);

  if (
    history?.schema !== 1 ||
    history.scope !== "unfiltered" ||
    !Array.isArray(history.records)
  ) {
    throw new Error("Invalid hourly history format or query scope");
  }

  return history;
}

async function updateWinrateHistory() {
  const fresh = await fetchWinHours();
  const fetchedAt = Date.parse(fresh.fetchedAt);

  if (!Number.isFinite(fetchedAt)) {
    throw new Error("Invalid collection timestamp");
  }

  // Keep completed hours only.
  // The extra day buffers our seven-day dataset window.
  const end = Math.floor(fetchedAt / (HOUR * 1000)) * HOUR;
  const start = end - RETENTION_HOURS * HOUR;
  const weekStart = end - WEEK_HOURS * HOUR;

  const previous = await readHistory();
  const records = new Map();

  for (const row of previous.records) {
    validateRecord(row);

    if (row.hour >= start && row.hour < end) {
      const key = `${row.heroId}:${row.hour}`;

      if (records.has(key)) {
        throw new Error("Duplicate record in saved hourly history");
      }

      records.set(key, row);
    }
  }

  let accepted = 0;
  let added = 0;
  let revised = 0;

  for (const row of fresh.records) {
    validateRecord(row);

    if (row.hour < start || row.hour >= end) continue;

    accepted++;

    const key = `${row.heroId}:${row.hour}`;
    const old = records.get(key);

    if (!old) {
      added++;
    } else if (
      old.winCount !== row.winCount ||
      old.matchCount !== row.matchCount
    ) {
      revised++;
    }

    // Replace overlapping snapshots.
    // Adding them would count the same matches twice.
    records.set(key, {
      heroId: row.heroId,
      hour: row.hour,
      winCount: row.winCount,
      matchCount: row.matchCount,
    });
  }

  if (accepted === 0) {
    throw new Error(
      "No completed hourly records within the retention window"
    );
  }

  const sorted = [...records.values()].sort(
    (a, b) => a.hour - b.hour || a.heroId - b.heroId
  );

  const history = {
    schema: 1,
    scope: "unfiltered",
    updatedAt: fresh.fetchedAt,
    retentionHours: RETENTION_HOURS,
    records: sorted,
  };

  // Complete the new file before replacing the previous archive.
  const temporaryPath = HISTORY_PATH + ".tmp";

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

  return {
    historyFile: path.basename(HISTORY_PATH),
    requests: fresh.requests,
    addedRecords: added,
    revisedRecords: revised,
    storedRecords: sorted.length,
    storedHours: new Set(sorted.map((row) => row.hour)).size,
    weeklyHoursObserved: new Set(
      sorted
        .filter((row) => row.hour >= weekStart)
        .map((row) => row.hour)
    ).size,
    weeklyHoursRequired: WEEK_HOURS,
    earliestHour: new Date(sorted[0].hour * 1000).toISOString(),
    latestHour: new Date(
      sorted[sorted.length - 1].hour * 1000
    ).toISOString(),
  };
}

module.exports = updateWinrateHistory;

if (require.main === module) {
  updateWinrateHistory()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error("Hourly history update failed:", error.message);
      process.exitCode = 1;
    });
}