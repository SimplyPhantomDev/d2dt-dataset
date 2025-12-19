export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ ok: false });

    const {
        title,
        description,
        steps,
        context = {}
    } = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
    if (!title || !description) return res.status(400).json({ ok: false, error: "Missing fields" });

    const reproSteps = steps ?? context.steps ?? "";

    const issueBody = [
        `## What happened?`,
        description ? String(description) : "(missing)",
        ``,
        `## Steps to reproduce`,
        reproSteps ? String(reproSteps) : "(not provided)",
        ``,
        `## Environment`,
        `- OS: ${context.os ?? "(unknown)"}`,
        `- App version: ${context.appVersion ?? "(unknown)"}`,
        `- Dataset generatedAt: ${context.datasetGeneratedAt ?? "(unknown)"}`,
        `- Submitted at: ${context.createdAt ?? new Date().toISOString()}`,
        ``,
        `## Technical`,
        `- userAgent: ${context.userAgent ?? "(unknown)"}`
    ].join("\n");

    const r = await fetch("https://api.github.com/repos/SimplyPhantomDev/d2dt-dataset/issues", {
        method: "POST",
        headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
            "X-Github-Api-Version": "2022-11-28",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            title: String(title ?? "Untitled issue"),
            body: issueBody,
            labels: ["bug", "from-app"]
        })
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data?.message ?? "GitHub error" });

    return res.status(200).json({ ok: true, issueUrl: data.html_url });
}