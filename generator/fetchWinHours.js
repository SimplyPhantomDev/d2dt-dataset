const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  quiet: true,
});

const QUERY = `
  query HeroWinHours($take: Int!, $skip: Int!) {
    heroStats {
      winHour(take: $take, skip: $skip) {
        heroId
        winCount
        matchCount
        hour
      }
    }
  }
`;

async function fetchWinHours() {
  const token = process.env.STRATZ_API_TOKEN;
  if (!token) throw new Error("Missing STRATZ_API_TOKEN");

  const records = new Map();
  let skip = 0;
  let requests = 0;

  for (let page = 0; page < 100; page++) {
    // Pace requests below the token's 250 calls/minute limit.
    if (page > 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const response = await fetch("https://api.stratz.com/graphql", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "STRATZ_API",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { take: 100, skip },
      }),
    });

    requests++;

    if (!response.ok) {
      throw new Error(`STRATZ HTTP ${response.status}`);
    }

    const body = await response.json();

    if (body.errors?.length) {
      const message = body.errors
        .map((error) => error.message)
        .join("; ");

      throw new Error(message.replaceAll(token, "[redacted]"));
    }

    const rows = body.data?.heroStats?.winHour;

    if (!Array.isArray(rows)) {
      throw new Error("STRATZ returned no winHour array");
    }

    // The API's dynamic limit may return fewer rows than requested.
    // Only an empty page ends collection; advance by the actual row count.
    if (rows.length === 0) {
      if (records.size === 0) {
        throw new Error("STRATZ returned no hourly records");
      }

      return {
        fetchedAt: new Date().toISOString(),
        requests,
        records: [...records.values()].sort(
          (a, b) => a.hour - b.hour || a.heroId - b.heroId
        ),
      };
    }

    let newRecords = 0;

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
        throw new Error("STRATZ returned an invalid hourly record");
      }

      const key = `${row.heroId}:${row.hour}`;

      if (!records.has(key)) newRecords++;

      records.set(key, {
        heroId: row.heroId,
        hour: row.hour,
        winCount: row.winCount,
        matchCount: row.matchCount,
      });
    }

    if (newRecords === 0) {
      throw new Error(
        "Pagination returned only previously collected records"
      );
    }

    skip += rows.length;
  }

  throw new Error(
    "Pagination exceeded 100 pages; collection was stopped"
  );
}

module.exports = fetchWinHours;

if (require.main === module) {
  fetchWinHours()
    .then(({ fetchedAt, requests, records }) => {
      console.log(JSON.stringify({
        fetchedAt,
        requests,
        records: records.length,
        heroes: new Set(records.map((row) => row.heroId)).size,
        earliestHour: new Date(
          records[0].hour * 1000
        ).toISOString(),
        latestHour: new Date(
          records[records.length - 1].hour * 1000
        ).toISOString(),
        latestSample: records.slice(-3),
      }, null, 2));
    })
    .catch((error) => {
      console.error("Hourly collection failed:", error.message);
      process.exitCode = 1;
    });
}