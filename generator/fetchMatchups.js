const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  override: false,
});

const STRATZ_API_URL = "https://api.stratz.com/graphql";

const matchupQuery = `
  query HeroVsHeroMatchup($heroId: Short!) {
    heroStats {
      heroVsHeroMatchup(heroId: $heroId) {
        advantage {
          vs { heroId2 synergy }
          with { heroId2 synergy }
        }
      }
    }
  }
`;

function validatePairs(pairs, kind, heroId) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error(
      `Hero ${heroId} has missing or empty ${kind} matchup data`
    );
  }

  const seen = new Set();

  for (const pair of pairs) {
    if (
      !pair ||
      !Number.isInteger(pair.heroId2) ||
      pair.heroId2 <= 0 ||
      pair.heroId2 === heroId ||
      !Number.isFinite(pair.synergy)
    ) {
      throw new Error(
        `Hero ${heroId} has an invalid ${kind} matchup entry`
      );
    }

    if (seen.has(pair.heroId2)) {
      throw new Error(
        `Hero ${heroId} has duplicate ${kind} entries for hero ${pair.heroId2}`
      );
    }

    seen.add(pair.heroId2);
  }

  return pairs;
}

async function fetchMatchups(heroId) {
  const token = process.env.STRATZ_API_TOKEN;

  if (!token) {
    throw new Error("Missing STRATZ_API_TOKEN environment variable");
  }

  const response = await fetch(STRATZ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "STRATZ_API",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: matchupQuery,
      variables: { heroId },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `STRATZ HTTP error ${response.status} for hero ${heroId}`
    );
  }

  const bodyText = await response.text();
  let json;

  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `STRATZ returned non-JSON data for hero ${heroId}`
    );
  }

  if (
    json?.errors &&
    (!Array.isArray(json.errors) || json.errors.length > 0)
  ) {
    throw new Error(
      `STRATZ GraphQL error for hero ${heroId}: ` +
      JSON.stringify(json.errors).slice(0, 300)
    );
  }

  const advantages =
    json?.data?.heroStats?.heroVsHeroMatchup?.advantage;

  if (!Array.isArray(advantages) || !advantages[0]) {
    throw new Error(
      `STRATZ returned no matchup data for hero ${heroId}`
    );
  }

  const advantage = advantages[0];

  return {
    heroId,
    vs: validatePairs(advantage.vs, "vs", heroId),
    with: validatePairs(advantage.with, "with", heroId),
  };
}

module.exports = fetchMatchups;
