const { fetchPublicMatches } = require("../generator/fetchPublicMatches.cjs");

async function main() {
  if (process.argv.length > 3) {
    throw new Error("Usage: node scripts/checkPublicMatches.cjs [lessThanMatchId]");
  }

  const { matches, ...page } = await fetchPublicMatches(process.argv[2] ?? null);
  const dates = matches.map(match => match.startedAt).sort();

  console.log(JSON.stringify({
    requests: 1,
    ...page,
    accepted: matches.length,
    withRankMetadata: matches.filter(match =>
      match.metadata.averageRankTier !== null
    ).length,
    earliestMatch: dates[0] ?? null,
    latestMatch: dates.at(-1) ?? null,
    sample: matches[0] ?? null,
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});