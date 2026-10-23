# Dota 2 Drafting Tool — Dataset and Backend

Data generation, match reporting and prediction research for the [Dota 2 Drafting Tool](https://github.com/SimplyPhantomDev/dota2-draft-frontend).

This repository:

- Publishes hero information, matchup statistics and baseline winrates for the application.
- Collects hourly observations of hero winrates and playing positions.
- Receives bug reports and match outcomes submitted through the application.
- Verifies reported matches against STRATZ.
- Collects public Ranked All Pick matches for model development.
- Exports reproducible training datasets and evaluates experimental draft prediction models.

The application and its data are maintained separately, allowing dataset updates without distributing another application build.

**Model training is currently an offline development process.** Collecting reports or training a benchmark does not automatically change the application's prediction algorithm.

## Data files

| File | Purpose |
| --- | --- |
| `heroes.json` | Hero IDs, names, capability tags, primary attributes, image URLs and optional search aliases. |
| `synergyMatrix.json` | Matchup and ally synergy values, plus baseline hero winrates when sufficient history is available. |
| `manifest.json` | Published dataset timestamp, patch label, file sizes, SHA-256 checksums and baseline winrate readiness. |
| `winrateHistory.json` | Rolling archive of hourly, unfiltered hero winrate observations from STRATZ. |
| `rankedPositionHistory.json` | Rolling archive of Ranked All Pick observations, collected without a position filter and separately for positions 1–5. |
| `heroPositionProfiles.json` | Position frequencies, coverage information and uncertainty estimates derived from the ranked position history. |
| `positionHistory.json` | Earlier unfiltered position archive, retained separately from the current ranked collection. |

The published application dataset consists of **`heroes.json`, `synergyMatrix.json` and `manifest.json`**. Keep these files from the same generated snapshot together.

The root manifest records checksums for the hero and synergy files. It does not currently include the position profiles or experimental model artifacts.

### Matchup data

Each entry in `synergyMatrix.json` contains:

- `heroId`: the hero being evaluated.
- `vs`: matchup values against opposing heroes.
- `with`: synergy values with allied heroes.
- `baseline`: aggregated `winCount`, `matchCount` and `winRate`, or `null` when the required history is unavailable.

Entries in `vs` and `with` contain `heroId2` and the `synergy` value returned by STRATZ.

These synergy values are used by the application's recommendation logic. They should not be treated as raw pair winrates or directly interpreted as complete draft win probabilities.

A baseline `winRate` is stored as a fraction from 0 to 1.

### Patch metadata

The generator detects the latest released patch from Valve's patch-notes feed.

The published patch label is metadata. The STRATZ matchup query does not explicitly filter its results to that patch, and a labelled snapshot should not be interpreted as containing exclusively matches played on that patch.

## Local setup

Use Node.js 22 and npm to match the automated workflows.

The collection and verification tools also need a PostgreSQL database. The current implementation uses Neon.

```bash
git clone https://github.com/SimplyPhantomDev/d2dt-dataset.git
cd d2dt-dataset
npm ci
```

Run the commands in this README from the repository root.

Create a root `.env` file:

```dotenv
STRATZ_API_TOKEN=replace_with_your_stratz_token
DATABASE_URL=replace_with_your_neon_connection_string
```

`DATABASE_URL` is required by the shared request-budget system as well as the match database. It is therefore needed when running the STRATZ generators.

Apply every SQL migration in [`database/`](database/) in numeric order, from `001_match_reports.sql` through `007_public_match_sampling.sql`. These can be run through Neon's SQL Editor.

The migrations create the report storage, verification queue, trusted match cache, API request budgets and public-match collection state.

The `.env` file and `node_modules/` are excluded from Git.

## Generate the application dataset

```bash
node generator/fetchHeroes.js
node generator/updateWinrateHistory.js
node generator/generateMatchupData.js
```

These commands:

1. Refresh hero metadata while preserving existing search aliases.
2. Update the hourly winrate archive.
3. Fetch and validate each hero's matchup data.
4. Attach baseline winrates when the history is complete.
5. Write the synergy matrix and its manifest.

Generation rejects incomplete or invalid matchup responses. The automated workflow publishes changes only after its generation steps succeed.

### Baseline winrate requirements

Baseline winrates use the same **seven completed UTC days** for every expected hero.

Each hero needs all 168 hourly records and a positive total match count. The calculation divides total wins by total matches, rather than averaging hourly percentages.

If any expected hero lacks the required coverage, the generated baseline window is marked unavailable and matrix entries receive `baseline: null`.

Check readiness without changing files:

```bash
node generator/buildHeroWinrates.js
```

The hourly archive retains eight days of completed hours. When a fetched hero/hour overlaps an existing record, its counts replace the previous observation; overlapping counts are not added together.

## Collect position observations

```bash
node generator/updatePositionHistory.cjs
node generator/buildHeroPositionProfiles.cjs
```

The collector requests Ranked All Pick statistics for six separate slices:

- No position filter.
- Position 1: carry.
- Position 2: mid.
- Position 3: offlane.
- Position 4: soft support.
- Position 5: hard support.

The profile builder reads the stored history without making another STRATZ request.

Its target window is 168 hours, anchored to the latest completed hour shared by all six slices. Partial profiles can be produced while history accumulates; their coverage and incomplete-window status remain explicit.

Profiles record observed position frequencies, classification coverage, excluded inconsistent observations and confidence intervals.

**Position frequency describes how a hero was played.** It does not establish that a position is optimal or that choosing it causes a higher winrate.

The five position slices may not account for every match in the unfiltered slice. Remaining counts are recorded as unreconciled observations rather than silently assigned to a position.

The capability tags in `heroes.json`, such as `Support` or `Initiator`, are separate from these numbered playing positions.

## Automated workflows

All schedules below use **UTC**.

| Workflow | Schedule | Runner | Responsibility |
| --- | --- | --- | --- |
| [Generate dataset](.github/workflows/generate-dataset.yml) | Monday at 03:00 | `windows-latest` | Refresh and publish the application dataset and winrate history. |
| [Collect winrates](.github/workflows/collect-winrates.yml) | 00:35, 06:35, 12:35 and 18:35 | `windows-latest` | Update and publish hourly winrate history. |
| [Collect positions](.github/workflows/collect-positions.yml) | 00:50, 06:50, 12:50 and 18:50 | `windows-latest` | Update and publish ranked position history and profiles. |
| [Verify match reports](.github/workflows/verify-match-reports.yml) | Hourly at minute 17 | `ubuntu-latest` | Process up to 50 queued match IDs. |
| [Sample public matches](.github/workflows/sample-public-matches.yml) | Hourly at minute 43 | `ubuntu-latest` | Sample mature match windows and report collection coverage. |

Every workflow also supports manual execution through GitHub Actions.

These are GitHub-hosted runners, so scheduled collection does not depend on a personal computer remaining switched on. Scheduled start times can still be delayed.

Configure these repository secrets:

- `STRATZ_API_TOKEN`
- `DATABASE_URL`

The workflows that publish JSON files use the GitHub Actions token with repository write permission. Their shared concurrency group serializes dataset-writing jobs.

## Application reporting endpoints

The `api/` directory contains serverless handlers for deployment through Vercel.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/report-issue` | Create a GitHub issue from an application bug report. |
| `POST /api/report-match` | Validate and store a completed-draft outcome report in Neon. |

Configure the deployment environment as needed:

| Variable | Used for |
| --- | --- |
| `GITHUB_TOKEN` | Server-side token permitted to create issues in this repository. |
| `DATABASE_URL` | Store match reports in Neon. |
| `MATCH_REPORTS_ENABLED` | Set to the exact value `true` to enable match reporting. |

The deployment's `GITHUB_TOKEN` is a separately configured credential, distinct from the token automatically supplied to GitHub Actions.

Keep all credentials on the server or in the collection environment.

### Bug reports

Issue reports can include a title, description, reproduction steps and application context.

Accepted reports become **public GitHub issues** in this repository.

### Match reports

Match reports contain a completed draft, the claimed ally outcome and snapshot metadata. A match ID can also be supplied for verification.

Reports are initially stored as **unverified**. Receiving a report does not establish that its outcome is correct.

Repeated submissions of the same draft are handled idempotently. Conflicting submissions for an existing draft ID are rejected instead of overwriting the original report.

The endpoint stores reports without performing an immediate STRATZ lookup.

## Match verification

Run a small verification batch locally:

```bash
node scripts/verifyMatchReports.cjs 5
```

The worker:

1. Claims queued match IDs using database leases.
2. Reuses trusted cached match data where available.
3. Fetches missing match data from STRATZ.
4. Compares both reported lineups with the actual teams.
5. Determines whether the user's allies were Radiant or Dire.
6. Checks the claimed outcome against the actual winner.

A matching report becomes verified. A mismatching draft or outcome becomes rejected, with verification details recorded separately.

Reports without a match ID remain unverified and are excluded from verified training data.

Multiple reports about the same match share a lookup and cache entry. Retry scheduling and shared request budgets limit unnecessary API usage.

STRATZ generators and verification workers reserve requests through the same database-backed quota system. OpenDota collection uses a separate request budget.

## Public match collection

Public training candidates are collected from OpenDota's public-match data.

The current sampler selects **Ranked All Pick** matches and rotates across hourly windows within mature UTC days. Windows must have ended at least 24 hours earlier.

Run a sampling batch and inspect coverage:

```bash
node scripts/samplePublicMatches.cjs 20 7
node scripts/checkPublicMatchCoverage.cjs
```

The arguments request up to 20 hourly windows across seven eligible days. Persistent cursors and visit timestamps allow later runs to continue collection and distribute observations across time.

Normalized matches and collection progress are stored in Neon, rather than committed as individual match files.

The scheduled workflow currently stops adding public samples once the database reaches its initial target of 100,000 public matches.

That target is a collection limit, not proof that temporal coverage or model evaluation is sufficient.

## Training datasets

Training exports combine public samples with trusted match facts associated with verified reports.

Matches are deduplicated by actual match ID. A reported prediction is retained as report context; it is not used as the training outcome.

### Export a snapshot

```bash
node scripts/exportTrainingMatches.cjs
```

The command creates a new directory:

```text
training-data/dataset-<unique-id>/
```

Use the `directory` printed by the command in subsequent steps.

| Export file | Contents |
| --- | --- |
| `manifest.json` | Export provenance, counts, file sizes and checksums. |
| `matches.jsonl` | Resolved match facts. |
| `unresolvedMatches.jsonl` | Matches whose patch could not be resolved safely. |
| `patchTimeline.json` | Patch timeline used during resolution. |
| `featureSpec.json` | Frozen feature definitions, hero metadata and position-profile snapshot. |
| `features.jsonl` | Training features and outcomes. |
| `featureExclusions.jsonl` | Matches excluded from feature generation, with reasons. |

Patch inference uses match start times and a saved release timeline. Matches near uncertain release boundaries are kept separate.

A match may be retained in the export but excluded from features because it does not match the feature profile's patch or lacks required position observations.

The export's `manifest.json` describes that training snapshot. It is separate from the root manifest used by the desktop application.

### Check the split and train

Replace `dataset-YOUR-ID` with the exported folder name:

```bash
node scripts/checkTrainingSplit.cjs "training-data/dataset-YOUR-ID"
node scripts/trainDraftBenchmark.cjs "training-data/dataset-YOUR-ID"
```

The split is chronological and keeps complete UTC days together, targeting approximately:

- 70% training.
- 15% validation.
- 15% test.

Actual proportions depend on the number of matches in each day.

The benchmark compares constant baselines with regularized logistic regression models using hero identities, composition tags and, for position-aware exports, position features.

Training fits model parameters. Validation selects the candidate and regularization strength. The selected model is then evaluated on the test partition.

Results include log loss, Brier score, accuracy and mean prediction.

Training creates a separate directory:

```text
training-data/benchmark-<unique-id>/
```

It contains `model.json` and `report.json`.

### Inspect a benchmark

Supply the benchmark and its original source dataset:

```bash
node scripts/inspectDraftBenchmark.cjs "training-data/benchmark-YOUR-ID" "training-data/dataset-YOUR-ID"
```

The inspector checks provenance and reports validation prediction spread, calibration summaries and example draft contributions.

Feature contributions are expressed in log odds, not percentage points.

## Frozen position evaluation

Position features use observed data, so evaluation must respect when those observations became available.

The position-aware trainer requires validation and test matches to start after the frozen position profile's `sourceUpdatedAt`.

Choose one position-aware export as the reference and name its folder `dataset-positions-reference`. For example, rename your chosen export once:

```bash
mv "training-data/dataset-YOUR-ID" "training-data/dataset-positions-reference"
```

Keep this reference unchanged while later matches accumulate.

Check current database coverage against it:

```bash
node scripts/checkPositionEvaluationReadiness.cjs
```

The checker uses:

```text
training-data/dataset-positions-reference/featureSpec.json
```

It reads current stored matches and evaluates the split in memory. It does **not** create another dataset or benchmark folder.

`readyForPositionEvaluation: true` means validation and test both start after the frozen snapshot. It confirms the timing requirement, not predictive quality or adequate statistical power.

When ready, export newer matches using the same frozen feature specification:

```bash
node scripts/exportTrainingMatches.cjs --feature-spec "training-data/dataset-positions-reference/featureSpec.json"
```

Then check the split and train against the newly printed dataset directory.

This refreshes the match sample while preserving the reference feature definitions and position observations.

## Managing local experiment folders

`training-data/` is excluded from Git.

| Folder | Purpose |
| --- | --- |
| `dataset-<unique-id>` | An immutable export of matches, features and provenance. |
| `benchmark-<unique-id>` | A trained model and its evaluation report. |
| `dataset-positions-reference` | A manually named export used as the frozen position reference. |

Exports and training runs create new folders rather than replacing earlier results. Readiness checks do not.

Folders may be renamed for clarity, but preserve their contents. A benchmark identifies its source dataset through the source manifest checksum.

Keep a benchmark together with its matching source export if you want to reproduce or inspect it later. Archive obsolete experiments rather than confusing them with the active reference.

## Feature development and checks

The feature extractors support:

- `draft-tags-v1`: hero identities, capability-tag counts and primary-attribute counts.
- `draft-tags-positions-v2`: the same features plus empirical position-assignment and coverage measurements.

Position assignment evaluates all 120 ways to assign five heroes to five positions. Its compatibility scores describe observed position fit and assignment ambiguity; they are not match win probabilities.

Run the relevant development checks:

```bash
node scripts/checkDraftFeatures.cjs
node scripts/checkDraftPositions.cjs
node scripts/checkDraftPositionFeatures.cjs
```

The extractors are designed to be independent of hero ordering within a team. Swapping the teams negates the draft features.

Feature specifications freeze the metadata needed to reproduce an experiment, rather than silently using whichever profiles happen to exist later.

The repository currently has no configured `npm test` suite; its npm test command remains a placeholder.

## Project layout

| Directory | Responsibility |
| --- | --- |
| `generator/` | Fetch observations and build published JSON data. |
| `api/` | Application-facing serverless endpoints. |
| `database/` | Ordered PostgreSQL migrations. |
| `server/` | Shared validation, database, API, feature and modelling logic. |
| `scripts/` | Collection workers, diagnostics, exports and benchmark commands. |
| `.github/workflows/` | Scheduled collection, verification and publishing. |
| `training-data/` | Local experiment artifacts, excluded from Git. |

## Data and model limitations

Historical observations reflect the matches included by each source and query. The unfiltered baseline winrate history and ranked position history represent different scopes.

Collection volume alone does not guarantee representative coverage. Inspect dates, hours, missing observations and rank coverage alongside match counts.

A completed position window does not guarantee that every hero-position combination has a useful sample size.

Draft-only models cannot observe every factor affecting a match, including player skill, execution, item choices and communication. Model improvements should be demonstrated on suitable held-out matches rather than judged only by whether individual examples look convincing.

## Author

Tomi Niemelä — [SimplyPhantomDev](https://github.com/SimplyPhantomDev)