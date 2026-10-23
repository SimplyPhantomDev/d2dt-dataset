const path = require("path");
require("dotenv").config({
    path: path.resolve(__dirname, "../.env"),
    override: false,
});

const { stratzQuery } = require("../server/stratzApi.cjs");

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
    const json = await stratzQuery(matchupQuery, { heroId });

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
