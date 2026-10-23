const { resolve } = require("node:path");
const { exportTrainingMatches } = require("./exportTrainingMatches.cjs");
const { splitChronologically } = require("../server/trainingDataset.cjs");

async function checkPositionEvaluationReadiness(
  referenceFile = resolve(
    __dirname,
    "../training-data/dataset-positions-reference/featureSpec.json"
  )
) {
  const data = await exportTrainingMatches(
    undefined,
    referenceFile,
    { preview: true }
  );

  const profile = data.featureSpec.catalog.positionProfile;

  if (data.featureSpec.featureSchema !== "draft-tags-positions-v2"
    || !profile) {
    throw new Error(
      "The reference must contain a position-aware feature snapshot."
    );
  }

  const cutoff = Date.parse(profile.sourceUpdatedAt);

  const summary = {
    checkedAt: new Date().toISOString(),
    referenceFile: resolve(referenceFile),
    profileSha256: data.featureSpec.profileSha256,
    positionProfileUpdatedAt: profile.sourceUpdatedAt,
    matches: data.rows.length,
    excludedMatches: data.features.excludedMatches,

    matchesAfterSnapshot: data.rows.filter(
      row => Date.parse(row.startedAt) > cutoff
    ).length,
  };

  let split;

  try {
    split = splitChronologically(data.rows);
  } catch (error) {
    return {
      ...summary,
      readyForPositionEvaluation: false,
      reason: error.message,
    };
  }

  const describe = rows => ({
    matches: rows.length,
    observedDays: new Set(
      rows.map(row => row.startedAt.slice(0, 10))
    ).size,
    earliestMatch: rows[0].startedAt,
    latestMatch: rows.at(-1).startedAt,
  });

  const ready =
    Date.parse(split.validation[0].startedAt) > cutoff
    && Date.parse(split.test[0].startedAt) > cutoff;

  return {
    ...summary,
    readyForPositionEvaluation: ready,

    reason: ready
      ? "Validation and test both start after the frozen position snapshot."
      : "The chronological split still includes pre-snapshot matches in validation or test.",

    validation: describe(split.validation),
    test: describe(split.test),
  };
}

module.exports = { checkPositionEvaluationReadiness };

if (require.main === module) {
  checkPositionEvaluationReadiness().then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}