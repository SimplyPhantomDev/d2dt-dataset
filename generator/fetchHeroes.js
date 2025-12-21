// generator/fetchHeroes.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const STRATZ_API_URL = "https://api.stratz.com/graphql";
const ICON_BASE_URL = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/heroes";

// Dawnbreaker exception you mentioned
function heroIconUrl(shortName) {
  if (!shortName) return null;
  if (shortName === "dawnbreaker") return `${ICON_BASE_URL}/${shortName}.png`;
  return `${ICON_BASE_URL}/${shortName}_full.png`;
}

const query = `
  query {
    constants {
      heroes {
        id
        shortName
        displayName
        roles { roleId }
        stats { primaryAttribute }
      }
    }
  }
`;

async function main() {
  const token = process.env.STRATZ_API_TOKEN;
  if (!token) throw new Error("Missing STRATZ_API_TOKEN env var");

  const res = await fetch(STRATZ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "STRATZ_API",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`STRATZ fetch failed: ${res.status} ${res.statusText} ${text}`.slice(0, 400));
  }

  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors).slice(0, 400)}`);

  const heroes = json?.data?.constants?.heroes ?? [];

  // Load existing heroes.json (for aliases) if present
  const outPath = path.resolve(__dirname, "../heroes.json");
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(outPath, "utf-8"));
  } catch {
    existing = [];
  }

  const aliasMap = new Map();
  for (const h of existing) {
    if (h?.HeroId != null && Array.isArray(h.aliases) && h.aliases.length) {
      aliasMap.set(h.HeroId, h.aliases);
    }
  }

  const formatted = heroes.map((hero) => ({
    HeroId: hero.id,
    name: hero.displayName,
    roles: (hero.roles ?? []).map(r => r.roleId.charAt(0) + r.roleId.slice(1).toLowerCase()),
    icon_url: heroIconUrl(hero.shortName),
    primaryAttribute: hero.stats?.primaryAttribute ?? "str",
    ...(aliasMap.has(hero.id) ? { aliases: aliasMap.get(hero.id) } : {}),
  }));

  fs.writeFileSync(outPath, JSON.stringify(formatted, null, 2), "utf-8");
  console.log(`✅ wrote ${formatted.length} heroes to ${outPath}`);
}

main().catch((e) => {
  console.error("❌ fetchHeroes failed:", e);
  process.exit(1);
});
