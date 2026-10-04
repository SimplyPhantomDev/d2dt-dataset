# Dota 2 Drafting Tool - Dataset

This repository contains the data-generation pipeline and JSON datasets used by the [Dota 2 Drafting Tool](https://github.com/SimplyPhantomDev/dota2-draft-frontend).

It retrieves hero information and matchup statistics from the STRATZ GraphQL API, prepares them for use by the application, and publishes dataset snapshots through GitHub Actions. Keeping the data separate from the desktop application allows it to be updated without distributing a new application build.

The repository also includes a serverless endpoint for submitting bug reports from within the application.

## Published data

| File | Contents |
| --- | --- |
| `heroes.json` | Hero IDs, names, roles, primary attributes, image URLs, and optional search aliases. |
| `synergyMatrix.json` | Hero matchup and synergy data, organised by hero ID. |
| `manifest.json` | Generation timestamp, filenames, file sizes, SHA-256 checksums, schema version, and a patch label. |

Each hero entry in `synergyMatrix.json` contains:

- `heroId`: the hero being evaluated.
- `vs`: matchup entries against opposing heroes.
- `with`: synergy entries with allied heroes.

The entries in `vs` and `with` contain `heroId2` and the corresponding `synergy` value returned by STRATZ. The drafting application uses these values in its own recommendation and draft-analysis logic.

## How generation works

1. **Fetch hero information.** The generator retrieves hero metadata from STRATZ, formats it for the application, and preserves existing search aliases from `heroes.json`.
2. **Fetch matchup data.** Heroes are processed sequentially, with a short delay between requests.
3. **Write the dataset.** Matchup results are collected into `synergyMatrix.json`.
4. **Generate the manifest.** The generator records the timestamp, file sizes, and SHA-256 checksums of the generated files.
5. **Publish changes.** The GitHub Actions workflow commits and pushes updated JSON files when changes are detected.

## Automated updates

The workflow is configured to run every Monday at **03:00 UTC** and can also be triggered manually through GitHub Actions.

It uses:

- A self-hosted runner with PowerShell available.
- Node.js 22.
- A repository secret named `STRATZ_API_TOKEN`.
- The patch label is detected automatically from Valve's patch-notes feed during generation. The STRATZ matchup query does not explicitly filter statistics to that patch.
- Generation stops if patch detection or a matchup request fails validation. A failed workflow does not publish replacement dataset files.

Scheduled updates depend on runner availability and successful API requests. Check `generatedAt` in `manifest.json` for the timestamp of the published snapshot.

## Running the generators locally

Use Node.js 22 to match the automated workflow, npm, and a valid STRATZ API token.

Clone the repository and install its dependencies:

```bash
git clone https://github.com/SimplyPhantomDev/d2dt-dataset.git
cd d2dt-dataset
npm ci
```

Create a `.env` file in the repository root:

```dotenv
STRATZ_API_TOKEN=replace_with_your_token
```

Run both generators from the repository root:

```bash
node generator/fetchHeroes.js
node generator/generateMatchupData.js
```

These commands update `heroes.json`, `synergyMatrix.json`, and `manifest.json` locally. Review the output before committing the generated files. The `.env` file is excluded by `.gitignore`.

## Desktop application integration

The desktop application maintains a local copy of the dataset and checks the published manifest on GitHub.

When the remote generation timestamp is newer than its local timestamp, the application downloads the updated hero and matchup files, replaces its local copies, updates the local manifest, and reloads.

This separates dataset updates from application releases and keeps the STRATZ API token within the generation environment.

## In-app issue reporting

`api/report-issue.js` receives bug reports submitted through the desktop application and creates issues in this repository.

Reports can include:

- A title and description.
- Steps to reproduce the problem.
- Operating system and application version.
- Dataset generation timestamp.
- Submission time and user-agent information.

The deployed handler requires a server-side `GITHUB_TOKEN` with permission to create issues in this repository. This token is separate from the STRATZ token used for dataset generation.

## Main project files

| File | Responsibility |
| --- | --- |
| `generator/fetchHeroes.js` | Retrieves and formats hero metadata while preserving existing aliases. |
| `generator/fetchMatchups.js` | Requests matchup and synergy data for an individual hero. |
| `generator/generateMatchupData.js` | Generates the combined matchup dataset and manifest. |
| `.github/workflows/generate-dataset.yml` | Runs generation and publishes updated files. |
| `api/report-issue.js` | Converts application bug reports into GitHub issues. |

## Data notes

- The published files are snapshots of data retrieved from STRATZ.

## Author

Tomi Niemelä - [SimplyPhantomDev](https://github.com/SimplyPhantomDev)
