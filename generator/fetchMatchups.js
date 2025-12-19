const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  override: false
});

if (!process.env.STRATZ_API_TOKEN) {
  throw new Error(
    "Missing STRATZ_API_TOKEN. Put STRATZ_API_TOKEN=... in the repo root .env (d2dt-dataset/.env)."
  );
}

const STRATZ_API_URL = 'https://api.stratz.com/graphql';

async function fetchMatchups(heroId) {
  const matchupQuery = `
    query HeroVsHeroMatchup($heroId: Short!) {
      heroStats {
        heroVsHeroMatchup(heroId: $heroId) {
          advantage {
            vs {
              heroId2
              synergy
            }
            with {
              heroId2
              synergy
            }
          }
        }
      }
    }
  `;

  try {
    const variables = { heroId };

    const response = await fetch(STRATZ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "STRATZ_API",
        Authorization: `Bearer ${process.env.STRATZ_API_TOKEN}`,
      },
      body: JSON.stringify({ query: matchupQuery, variables }),
    });

    const bodyText = await response.text();

    if (!response.ok) {
      console.error("STRATZ HTTP error:", response.status, bodyText.slice(0, 300));
      return;
    }

    let json;

    try {
      json = JSON.parse(bodyText);
    } catch (e) {
      console.error("STRATZ returned non-JSON:", bodyText.slice(0, 300));
      return;
    }

    if (json.errors) {
      console.error("GraphQL errors:", json.errors);
      return;
    }

    const advantageData = json?.data?.heroStats?.heroVsHeroMatchup?.advantage?.[0];

    if (!advantageData) {
      console.error("Missing matchup data for heroId:", heroId);
      return;
    }

    const vsArray = Array.isArray(advantageData.vs) ? advantageData.vs : [];
    const withArray = Array.isArray(advantageData.with) ? advantageData.with : [];

    return {
      heroId,
      vs: vsArray,
      with: withArray,
    };

  } catch (err) {
    console.error("Error fetching matchups:", err);
  }
}


module.exports = fetchMatchups;
