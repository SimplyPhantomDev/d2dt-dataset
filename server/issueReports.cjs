// Bound client input and render it as literal text inside server-owned sections.
const { createHmac } = require("node:crypto");
const { isIP } = require("node:net");

const MAX_REPORT_BYTES = 16 * 1024;
const ISSUE_URL = "https://github.com/SimplyPhantomDev/d2dt-dataset/issues";

class IssueReportError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function reject(message, status) {
    throw new IssueReportError(message, status);
}

function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, name, maximum, multiline = false, required = false) {
    if (value == null && !required) return "";

    if (typeof value !== "string" || value.length > maximum) {
        reject(`${name} must be text of at most ${maximum} characters.`);
    }

    if (!multiline && /[\r\n\u2028\u2029]/u.test(value)) {
        reject(`${name} must fit on one line.`);
    }

    // Remove control characters and invisible direction overrides, not punctuation.
    const clean = value.replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
        .trim();

    if (required && !clean) reject(`${name} is required.`);

    return clean;
}

function timestamp(value, name) {
    const result = text(value, name, 32);
    if (!result) return "";

    const milliseconds = Date.parse(result);

    if (!Number.isFinite(milliseconds)
        || new Date(milliseconds).toISOString() !== result) {
        reject(`${name} must be a UTC ISO timestamp.`);
    }

    return result;
}

function normalizeIssueReport(body) {
    let raw;

    try {
        raw = typeof body === "string" ? body : JSON.stringify(body);
    } catch {
        reject("The report must be valid JSON.");
    }

    if (typeof raw !== "string") reject("A JSON report is required.");

    if (Buffer.byteLength(raw, "utf8") > MAX_REPORT_BYTES) {
        reject("The report exceeds the 16 KB limit.", 413);
    }

    let input;

    try {
        input = JSON.parse(raw);
    } catch {
        reject("The report must be valid JSON.");
    }

    if (!object(input)) reject("The report must be a JSON object.");

    const context = input.context ?? {};
    if (!object(context)) reject("context must be a JSON object.");

    return {
        title: text(input.title, "Title", 80, false, true),
        description: text(input.description, "Description", 6000, true, true),
        steps: text(input.steps ?? context.steps, "Steps", 4000, true),
        os: text(context.os, "OS", 32),
        appVersion: text(context.appVersion, "App version", 64),
        datasetGeneratedAt: timestamp(
            context.datasetGeneratedAt, "Dataset timestamp"
        ),
        createdAt: timestamp(context.createdAt, "Client timestamp"),
        userAgent: text(context.userAgent, "User agent", 512),
    };
}

function noMentions(value) {
    return value.replaceAll("@", "@\u200B");
}

function literal(value) {
    const safe = noMentions(value || "(not provided)");

    // A client cannot close this block, even by submitting Markdown fences.
    const longest = Math.max(
        0,
        ...(safe.match(/`+/g) ?? []).map(run => run.length)
    );

    const fence = "`".repeat(Math.max(3, longest + 1));

    return `${fence}\n${safe}\n${fence}`;
}

function buildGithubIssue(report, receivedAt = new Date().toISOString()) {
    return {
        title: `[App report] ${noMentions(report.title)}`,
        body: [
            "Unverified report submitted through the application. All client fields below are user-supplied.",
            "",
            "## What happened?",
            literal(report.description),
            "",
            "## Steps to reproduce",
            literal(report.steps),
            "",
            "## Environment (client-reported)",
            literal([
                `OS: ${report.os || "(unknown)"}`,
                `App version: ${report.appVersion || "(unknown)"}`,
                `Dataset generatedAt: ${report.datasetGeneratedAt || "(unknown)"}`,
                `Client timestamp: ${report.createdAt || "(unknown)"}`,
                `User agent: ${report.userAgent || "(unknown)"}`,
            ].join("\n")),
            "",
            `Received at (server): ${receivedAt}`,
        ].join("\n"),
        labels: ["bug", "from-app"],
    };
}

function reportFingerprints(req, report, secret) {
    if (!/^[a-f0-9]{64}$/i.test(secret ?? "")) {
        reject("Issue reporting is unavailable.", 503);
    }

    // This endpoint is deployed directly on Vercel. Do not trust client-sent IDs
    // or fall back to arbitrary proxy headers when the platform header is absent.
    let ip = req.headers["x-vercel-forwarded-for"];

    if (typeof ip !== "string" || !isIP(ip.trim())) {
        reject("Issue reporting is unavailable.", 503);
    }

    ip = ip.trim();

    if (isIP(ip) === 6) {
        ip = new URL(`http://[${ip}]/`).hostname;
    }

    const key = Buffer.from(secret, "hex");

    const hash = value => createHmac("sha256", key)
        .update(value)
        .digest("hex");

    return {
        client: hash(`client:${ip}`),

        // Ignore changing timestamps/metadata when suppressing immediate retries.
        content: hash(`report:${JSON.stringify([
            report.title,
            report.description,
            report.steps,
        ])}`),
    };
}

module.exports = {
    MAX_REPORT_BYTES,
    ISSUE_URL,
    IssueReportError,
    normalizeIssueReport,
    buildGithubIssue,
    reportFingerprints,
};