require("dotenv").config();

const fs = require("fs");
const path = require("path");
const fetchMatchups = require("./fetchMatchups");
const crypto = require("crypto");

// TODO: change this to the hero list JSON your frontend uses
const HEROES_PATH = path.resolve(__dirname, "./heroes.json");

// Where to write the generated dataset
const OUTPUT_PATH = path.resolve(__dirname, "./matchupData.json");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const generateMatchups = async () => {
  const heroesRaw = fs.readFileSync(HEROES_PATH, "utf-8");
  const heroes = JSON.parse(heroesRaw);

  const allMatchups = {};

  for (const hero of heroes) {
    const heroId = hero.HeroId ?? hero.heroId ?? hero.id;
    const name = hero.name ?? hero.localized_name ?? `Hero ${heroId}`;

    if (!heroId) {
      console.warn("Skipping hero with no id:", hero);
      continue;
    }

    console.log(`Fetching matchups for ${name} (ID: ${heroId})`);

    try {
      const data = await fetchMatchups(heroId); // uses STRATZ token env var :contentReference[oaicite:1]{index=1}
      if (data) allMatchups[heroId] = data;
      else console.warn(`No data for ${name}`);
    } catch (err) {
      console.error(`Failed to fetch data for ${name}:`, err);
    }

    await sleep(150); // rate limit prevention (keep for now)
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allMatchups, null, 2));

  const datasetBuf = fs.readFileSync(OUTPUT_PATH);
  const sha256 = crypto.createHash("sha256").update(datasetBuf).digest("hex");
  const bytes = datasetBuf.length;

  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    file: path.basename(OUTPUT_PATH),
    bytes,
    sha256,
  };

  const MANIFEST_PATH = path.resolve(__dirname, "./manifest.json");
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`Manifest saved to ${MANIFEST_PATH}`);
  console.log(`Matchup data saved to ${OUTPUT_PATH}`);
  process.exit(0);
};

generateMatchups();