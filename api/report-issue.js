export default async function handler (req, res) {
    if (req.method !== "POST") return res.status(405).json({ ok: false });

    // basic CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();

    const { title, description, context } = req.body || {};
    if (!title || !description) return res.status(400).json({ ok: false, error: "Missing fields" });

    const body = [
        "",
        "----",
        "Context:",
        "```json",
        JSON.stringify(context ?? {}, null, 2),
        "```"
    ].join("\n");

    const r = await fetch ("https://api.github.com/repos/SimplyPhantomDev/d2dt-dataset/issues", {
        method: "POST",
        headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
            "X-Github-Api-Version": "2022-11-28",
            "Conent-Type": "application/json"
        },
        body: JSON.stringify({
            title: `[APP] ${title}`,
            body,
            labels: ["bug", "from-app"]
        })
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data?.message ?? "GitHub error" });

    return res.status(200).json({ ok: true, issueUrl: data.html_url });
}