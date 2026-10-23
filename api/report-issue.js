// Validate first, reserve shared quota, then make one GitHub creation attempt.
const { neon } = require("@neondatabase/serverless");
const {
    MAX_REPORT_BYTES,
    ISSUE_URL,
    IssueReportError,
    normalizeIssueReport,
    buildGithubIssue,
    reportFingerprints,
} = require("../server/issueReports.cjs");

module.exports = async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

    const fail = (status, error) =>
        res.status(status).json({ ok: false, error });

    if (req.method === "OPTIONS") return res.status(204).end();

    if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return fail(405, "Use POST to submit an issue report.");
    }

    const secret = process.env.ISSUE_REPORT_RATE_LIMIT_SECRET;

    if (process.env.ISSUE_REPORTS_ENABLED !== "true"
        || !process.env.GITHUB_TOKEN
        || !process.env.DATABASE_URL
        || !/^[a-f0-9]{64}$/i.test(secret ?? "")) {
        return fail(503, "Issue reporting is unavailable.");
    }

    const type = String(req.headers["content-type"] ?? "")
        .split(";")[0].trim().toLowerCase();

    if (type !== "application/json") {
        return fail(415, "Send the report as application/json.");
    }

    const length = req.headers["content-length"];

    if (length !== undefined) {
        if (typeof length !== "string" || !/^[0-9]+$/.test(length)) {
            return fail(400, "Invalid Content-Length.");
        }

        if (Number(length) > MAX_REPORT_BYTES) {
            return fail(413, "The report exceeds the 16 KB limit.");
        }
    }

    let report, fingerprints;

    try {
        // Vercel's body getter can itself throw for malformed JSON.
        report = normalizeIssueReport(req.body);
        fingerprints = reportFingerprints(req, report, secret);
    } catch (error) {
        return fail(
            error instanceof IssueReportError ? error.status : 400,
            error instanceof IssueReportError
                ? error.message
                : "The report must be valid JSON."
        );
    }

    try {
        const sql = neon(process.env.DATABASE_URL, {
            fetchOptions: { signal: AbortSignal.timeout(10000) },
        });

        const [result] = await sql`
      SELECT decision, retry_after FROM public.reserve_issue_report(
        ${fingerprints.client}, ${fingerprints.content}
      )
    `;

        if (["limited", "duplicate"].includes(result?.decision)) {
            const seconds = Number(result.retry_after);

            if (!Number.isSafeInteger(seconds) || seconds < 1) {
                throw new Error("Invalid quota response.");
            }

            res.setHeader("Retry-After", String(seconds));

            return fail(
                429,
                result.decision === "duplicate"
                    ? "An identical report was attempted recently. Check the issue list before trying again."
                    : "Issue reporting has reached its request limit. Please try again later."
            );
        }

        if (result?.decision !== "allowed") {
            return fail(503, "Issue reporting is unavailable.");
        }
    } catch {
        // Database errors can contain credentials. Do not log the raw exception.
        console.error("[issue-report] Quota storage unavailable.");

        return fail(503, "Issue reporting is temporarily unavailable.");
    }

    try {
        const response = await fetch(
            "https://api.github.com/repos/SimplyPhantomDev/d2dt-dataset/issues",
            {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(10000),
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "D2DT-Issue-Reporter",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(buildGithubIssue(report)),
            }
        );

        if (response.status !== 201) {
            console.error("[issue-report] GitHub rejected creation.", {
                status: response.status,
            });

            return fail(
                503,
                "The report could not be submitted. Please try again later."
            );
        }

        const data = await response.json();

        if (!Number.isSafeInteger(data?.number) || data.number < 1) {
            throw new Error("Invalid GitHub response.");
        }

        return res.status(200).json({
            ok: true,
            issueUrl: `${ISSUE_URL}/${data.number}`,
        });
    } catch {
        // Never retry an uncertain POST automatically: GitHub may have created it.
        console.error("[issue-report] GitHub submission could not be confirmed.");

        return fail(
            503,
            "Submission could not be confirmed. Check the issue list before trying again."
        );
    }
};