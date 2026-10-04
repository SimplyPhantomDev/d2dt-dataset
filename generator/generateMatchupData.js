const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const fetchMatchups = require("./fetchMatchups");

const HEROES_PATH = path.resolve(__dirname, "../heroes.json");
const OUTPUT_PATH = path.resolve(__dirname, "../synergyMatrix.json");
const MANIFEST_PATH = path.resolve(__dirname, "../manifest.json");

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Record Valve's latest released patch with the dataset being generated.
// Abort generation on lookup failure rather than publish a guessed patch label.
async function fetchCurrentPatch() {
  const response = await fetch(
    "https://www.dota2.com/datafeed/patchnoteslist?language=english",
    { signal: AbortSignal.timeout(20_000) }
  );

  if (!response.ok) {
    throw new Error("Patch lookup failed: HTTP " + response.status);
  }

  const body = await response.json();
  if (
    body?.success !== true ||
    !Array.isArray(body.patches) ||
    body.patches.length === 0
  ) {
    throw new Error("Valve returned an invalid patch list");
  }

  let latest = null;
  const now = Math.floor(Date.now() / 1000);

  for (const entry of body.patches) {
    if (
      !entry ||
      typeof entry.patch_number !== "string" ||
      !/^\d+\.\d+[a-z]?$/i.test(entry.patch_number) ||
      !Number.isSafeInteger(entry.patch_timestamp) ||
      entry.patch_timestamp <= 0
    ) {
      throw new Error("Valve returned an invalid patch entry");
    }

    // Exclude any future-dated releases.
    if (entry.patch_timestamp > now) continue;

    if (
      !latest ||
      entry.patch_timestamp > latest.patch_timestamp ||
      (entry.patch_timestamp === latest.patch_timestamp &&
        entry.patch_number.toLowerCase().localeCompare(
          latest.patch_number.toLowerCase(),
          "en",
          { numeric: true }
        ) > 0)
    ) {
      latest = entry;
    }
  }

  if (!latest) throw new Error("Valve returned no released patches");
  return latest.patch_number.toLowerCase();
}

function validateCoverage(data, heroId, expectedIds) {
  if (!data || data.heroId !== heroId) {
    throw new Error(
      `Missing or mismatched result for hero ${heroId}`
    );
  }

  for (const kind of ["vs", "with"]) {
    const pairs = data[kind];

    if (!Array.isArray(pairs)) {
      throw new Error(
        `Hero ${heroId} has no ${kind} matchup array`
      );
    }

    const returnedIds = new Set(
      pairs.map((pair) => pair.heroId2)
    );

    const missing = [...expectedIds].filter(
      (id) => id !== heroId && !returnedIds.has(id)
    );

    const unexpected = [...returnedIds].filter(
      (id) => id === heroId || !expectedIds.has(id)
    );

    if (
      missing.length ||
      unexpected.length ||
      returnedIds.size !== pairs.length
    ) {
      throw new Error(
        `Incomplete ${kind} data for hero ${heroId}: ` +
        `missing [${missing.join(", ")}], ` +
        `unexpected [${unexpected.join(", ")}] or duplicate entries`
      );
    }
  }
}

async function generateMatchups() {
  const patch = await fetchCurrentPatch();
  console.log("Detected Dota 2 patch: " + patch);
  const heroesBuf = fs.readFileSync(HEROES_PATH);
  const heroes = JSON.parse(heroesBuf.toString("utf8"));

  if (!Array.isArray(heroes) || heroes.length < 2) {
    throw new Error(
      "heroes.json must contain at least two heroes"
    );
  }

  const entries = heroes.map((hero) => {
    const heroId = hero?.HeroId ?? hero?.heroId ?? hero?.id;

    if (!Number.isInteger(heroId) || heroId <= 0) {
      throw new Error(
        "heroes.json contains a hero with an invalid ID"
      );
    }

    return {
      heroId,
      name: hero.name ?? hero.localized_name ?? `Hero ${heroId}`,
    };
  });

  const expectedIds = new Set(
    entries.map((hero) => hero.heroId)
  );

  if (expectedIds.size !== entries.length) {
    throw new Error(
      "heroes.json contains duplicate hero IDs"
    );
  }

  const allMatchups = {};

  for (const { heroId, name } of entries) {
    console.log(
      `Fetching matchups for ${name} (ID: ${heroId})`
    );

    try {
      const data = await fetchMatchups(heroId);
      validateCoverage(data, heroId, expectedIds);
      allMatchups[heroId] = data;
    } catch (error) {
      throw new Error(
        `Failed to generate data for ${name} (ID: ${heroId}): ` +
        error.message
      );
    }

    await sleep(150);
  }

  // All requests and validation have succeeded before writing outputs.
  const datasetBuf = Buffer.from(
    JSON.stringify(allMatchups, null, 2),
    "utf8"
  );

  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    file: path.basename(OUTPUT_PATH),
    bytes: datasetBuf.length,
    sha256: crypto
      .createHash("sha256")
      .update(datasetBuf)
      .digest("hex"),
    heroesFile: path.basename(HEROES_PATH),
    heroesBytes: heroesBuf.length,
    heroesSha256: crypto
      .createHash("sha256")
      .update(heroesBuf)
      .digest("hex"),
    patch: patch,
  };

  const manifestText = JSON.stringify(manifest, null, 2);

  fs.writeFileSync(OUTPUT_PATH, datasetBuf);
  fs.writeFileSync(MANIFEST_PATH, manifestText);

  console.log(
    `Saved a validated dataset for ${entries.length} heroes`
  );
}

generateMatchups().catch((error) => {
  console.error("Dataset generation failed:", error.message);
  process.exitCode = 1;
});
