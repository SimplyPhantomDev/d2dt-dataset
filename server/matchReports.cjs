// Validate and normalize the client's saved result before it reaches Postgres.
// Reconstructing the report ignores extra fields and gives retries a stable hash.
class MatchReportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function reject(message, status) {
  throw new MatchReportError(message, status);
}

function object(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value);
}

function timestamp(value, field, optional = false) {
  if (optional && value == null) return null;

  const time = typeof value === "string" ? Date.parse(value) : NaN;

  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    reject(`${field} must be a UTC ISO timestamp.`);
  }

  return value;
}

function text(value, field, maximum, optional = false) {
  if (optional && value == null) return null;

  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maximum
  ) {
    reject(
      `${field} must be a non-empty string of at most ${maximum} characters.`
    );
  }

  return value;
}

function optionalMatchId(value) {
  if (value == null) return null;

  // Keep IDs as strings to avoid rounding large integers in JavaScript.
  // The upper bound matches the database's signed BIGINT column.
  if (
    typeof value !== "string"
    || !/^[1-9][0-9]{0,18}$/.test(value)
    || BigInt(value) > 9223372036854775807n
  ) {
    reject(
      "matchId must be a positive decimal string within the BIGINT range."
    );
  }

  return value;
}

function heroIds(value, field, allowedHeroIds) {
  if (
    !Array.isArray(value)
    || value.length !== 5
    || value.some(id =>
      !Number.isSafeInteger(id) || !allowedHeroIds.has(id)
    )
  ) {
    reject(`${field} must contain five known hero IDs.`);
  }

  return [...value];
}

function normalizeMatchReport(body, allowedHeroIds) {
  let raw;

  try {
    raw = typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    reject("The report must be valid JSON.");
  }

  if (typeof raw !== "string") {
    reject("A JSON report is required.");
  }

  if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
    reject("The report exceeds the 16 KB limit.", 413);
  }

  let input;

  try {
    input = JSON.parse(raw);
  } catch {
    reject("The report must be valid JSON.");
  }

  if (
    !object(input)
    || input.schema !== 1
    || !object(input.draft)
    || input.draft.schema !== 1
  ) {
    reject("Unsupported match-report schema.");
  }

  const draft = input.draft;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    typeof input.draftId !== "string"
    || !uuid.test(input.draftId)
    || typeof draft.id !== "string"
    || draft.id.toLowerCase() !== input.draftId.toLowerCase()
  ) {
    reject("draftId must match the snapshot's UUID.");
  }

  if (!["ally-win", "ally-loss"].includes(input.outcome)) {
    reject("The outcome must be ally-win or ally-loss.");
  }

  const ally = heroIds(
    draft.allyHeroIds, "allyHeroIds", allowedHeroIds
  );

  const enemy = heroIds(
    draft.enemyHeroIds, "enemyHeroIds", allowedHeroIds
  );

  if (new Set([...ally, ...enemy]).size !== 10) {
    reject("A reported draft must contain ten different heroes.");
  }

  const probability = draft.predictedAllyWinRate;

  if (
    !Number.isFinite(probability)
    || probability < 0
    || probability > 1
  ) {
    reject("predictedAllyWinRate must be between 0 and 1.");
  }

  if (!object(draft.dataset)) {
    reject("Dataset metadata is required.");
  }

  const sha256 = draft.dataset.sha256 ?? null;

  if (
    sha256 !== null
    && (
      typeof sha256 !== "string"
      || !/^[0-9a-f]{64}$/i.test(sha256)
    )
  ) {
    reject(
      "The dataset SHA-256 must be 64 hexadecimal characters or null."
    );
  }

  const id = input.draftId.toLowerCase();
  const matchId = optionalMatchId(input.matchId);

  return {
    schema: 1,
    draftId: id,
    outcome: input.outcome,
    reportedAt: timestamp(input.reportedAt, "reportedAt"),
    source: "self-report",
    verification: "unverified",
    draft: {
      schema: 1,
      id,
      draftKey: JSON.stringify([
        [...ally].sort((a, b) => a - b),
        [...enemy].sort((a, b) => a - b),
      ]),
      allyHeroIds: ally,
      enemyHeroIds: enemy,
      capturedAt: timestamp(draft.capturedAt, "capturedAt"),
      firstLeftAt: timestamp(draft.firstLeftAt, "firstLeftAt", true),
      predictedAllyWinRate: probability,
      displayedAllyWinPercent: Math.round(probability * 10000) / 100,
      predictorVersion: text(
        draft.predictorVersion, "predictorVersion", 64
      ),
      appVersion: text(draft.appVersion, "appVersion", 64, true),
      dataset: {
        generatedAt: timestamp(
          draft.dataset.generatedAt, "dataset.generatedAt", true
        ),
        sha256: sha256?.toLowerCase() ?? null,
        patch: text(draft.dataset.patch, "dataset.patch", 32, true),
      },
    },
    // Omit absent IDs so older reports keep their original normalized hash.
    // A submitted ID is a claim; verification remains server-controlled.
    ...(matchId === null ? {} : { matchId }),
  };
}

module.exports = { MatchReportError, normalizeMatchReport };