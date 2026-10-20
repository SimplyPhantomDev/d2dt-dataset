const { fetchStratzMatch } = require("../server/fetchStratzMatch.cjs");

async function main() {
  if (process.argv.length !== 3) {
    throw new Error(
      "Usage: node scripts/checkStratzMatch.cjs <matchId>"
    );
  }

  const match = await fetchStratzMatch(process.argv[2]);

  console.log(JSON.stringify({
    available: match !== null,
    match,
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});