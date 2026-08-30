import { readFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || "fishdawg90/fpl-transfer-scout";
const data = JSON.parse(await readFile(new URL("../site/data/latest.json", import.meta.url), "utf8"));

if (!token) {
  console.log("GITHUB_TOKEN is not set; skipping GitHub issue alert.");
  process.exit(0);
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...options.headers
    }
  });
  if (!response.ok) throw new Error(`GitHub ${options.method || "GET"} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

const issues = await github(`/repos/${repository}/issues?state=open&per_page=100`);
const existing = issues.find(issue => !issue.pull_request && issue.body?.includes("<!-- fpl-transfer-scout -->"));

if (!data.alert.shouldNotify) {
  if (existing) {
    await github(`/repos/${repository}/issues/${existing.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
    console.log(`Closed resolved FPL alert #${existing.number}.`);
  } else {
    console.log("No projected squad fall; no issue needed.");
  }
  process.exit(0);
}

const title = `FPL: ${data.alert.headline} · ${data.decision.label}`;
const fingerprintMarker = `<!-- fingerprint:${data.alert.fingerprint} -->`;
if (!existing) {
  const owner = repository.split("/")[0];
  const created = await github(`/repos/${repository}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body: data.alert.issueMarkdown, assignees: [owner] })
  });
  console.log(`Created FPL alert #${created.number}.`);
} else if (existing.body?.includes(fingerprintMarker)) {
  console.log(`FPL alert #${existing.number} is unchanged; not sending a duplicate notification.`);
} else {
  await github(`/repos/${repository}/issues/${existing.number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: data.alert.issueMarkdown })
  });
  await github(`/repos/${repository}/issues/${existing.number}`, {
    method: "PATCH",
    body: JSON.stringify({ title, body: data.alert.issueMarkdown })
  });
  console.log(`Updated FPL alert #${existing.number}.`);
}
