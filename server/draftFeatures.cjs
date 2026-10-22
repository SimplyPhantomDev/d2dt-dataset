const { createHash } = require("node:crypto");

const FEATURE_SCHEMA = "draft-tags-v1";

const ROLES = Object.freeze([
    "Carry", "Disabler", "Durable", "Escape",
    "Initiator", "Nuker", "Pusher", "Support",
]);

const ATTRIBUTES = Object.freeze(["agi", "all", "int", "str"]);

function createDraftFeatureExtractor(heroes) {
    if (!Array.isArray(heroes) || heroes.length < 10) {
        throw new Error("Hero profiles require at least ten heroes.");
    }

    const seen = new Set();

    const profiles = [...heroes].map(hero => {
        if (!Number.isSafeInteger(hero?.HeroId) || hero.HeroId <= 0 || seen.has(hero.HeroId)
            || !ATTRIBUTES.includes(hero.primaryAttribute)
            || !Array.isArray(hero.roles) || !hero.roles.length
            || [...hero.roles].some(role => !ROLES.includes(role))
            || new Set(hero.roles).size !== hero.roles.length) {
            throw new Error("Invalid hero profile or unknown role tag; review heroes.json.");
        }

        seen.add(hero.HeroId);

        return Object.freeze({
            heroId: hero.HeroId,
            primaryAttribute: hero.primaryAttribute,
            roles: Object.freeze([...hero.roles].sort()),
        });
    }).sort((a, b) => a.heroId - b.heroId);

    // Snapshot only fields that influence features.
    // Names, icons and aliases do not affect the profile hash.
    const catalog = Object.freeze({
        schema: 1,
        featureSchema: FEATURE_SCHEMA,
        roleTags: ROLES,
        attributeTags: ATTRIBUTES,
        heroes: Object.freeze(profiles),
    });

    const profileSha256 = createHash("sha256")
        .update(JSON.stringify(catalog))
        .digest("hex");

    const byId = new Map(profiles.map(hero => [hero.heroId, hero]));

    const featureNames = Object.freeze([
        ...profiles.map(hero => `hero.${hero.heroId}`),

        ...ROLES.flatMap(role =>
            Array.from({ length: 6 }, (_, count) => `role.${role}.count.${count}`)
        ),

        ...ATTRIBUTES.flatMap(attr =>
            Array.from({ length: 6 }, (_, count) => `attribute.${attr}.count.${count}`)
        ),
    ]);

    function describeTeam(ids) {
        const roleCounts = Object.fromEntries(ROLES.map(role => [role, 0]));
        const attributeCounts = Object.fromEntries(ATTRIBUTES.map(attr => [attr, 0]));

        for (const id of ids) {
            const hero = byId.get(id);

            for (const role of hero.roles) {
                roleCounts[role]++;
            }

            attributeCounts[hero.primaryAttribute]++;
        }

        return { roleCounts, attributeCounts };
    }

    function extract(radiantHeroIds, direHeroIds) {
        const validTeam = ids => Array.isArray(ids) && ids.length === 5
            && [...ids].every(id => Number.isSafeInteger(id) && byId.has(id));

        if (!validTeam(radiantHeroIds) || !validTeam(direHeroIds)
            || new Set([...radiantHeroIds, ...direHeroIds]).size !== 10) {
            throw new Error(
                "Draft features require ten distinct, known hero IDs: five per team."
            );
        }

        const radiantIds = new Set(radiantHeroIds);
        const direIds = new Set(direHeroIds);

        const radiant = describeTeam(radiantHeroIds);
        const dire = describeTeam(direHeroIds);

        const values = profiles.map(hero =>
            Number(radiantIds.has(hero.heroId)) - Number(direIds.has(hero.heroId))
        );

        // Separate indicators let training learn a different effect for each count.
        // Each additional Support/Carry tag can therefore have a different influence.
        for (const [tags, field] of [
            [ROLES, "roleCounts"],
            [ATTRIBUTES, "attributeCounts"],
        ]) {
            for (const tag of tags) {
                for (let count = 0; count <= 5; count++) {
                    values.push(
                        Number(radiant[field][tag] === count)
                        - Number(dire[field][tag] === count)
                    );
                }
            }
        }

        // Every feature is Radiant minus Dire.
        // Swapping teams negates the vector; hero order changes nothing.
        return { values, radiant, dire };
    }

    return Object.freeze({
        featureSchema: FEATURE_SCHEMA,
        profileSha256,
        catalog,
        featureNames,
        extract,
    });
}

module.exports = { createDraftFeatureExtractor };