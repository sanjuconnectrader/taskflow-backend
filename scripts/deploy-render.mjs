const base = `https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}/deploys`;
const headers = {
  Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
  "Content-Type": "application/json",
};
const started = await fetch(base, {
  method: "POST",
  headers,
  body: JSON.stringify({
    commitId: process.env.COMMIT_SHA,
    clearCache: "do_not_clear",
  }),
});
if (!started.ok)
  throw new Error(`Render rejected deployment (${started.status})`);
const { id } = await started.json();
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const response = await fetch(`${base}/${id}`, { headers });
  if (!response.ok) throw new Error("Could not read Render deploy status");
  const data = await response.json();
  if (data.status === "live") {
    console.log("Validated commit is live on Render.");
    process.exit(0);
  }
  if (
    ["build_failed", "update_failed", "canceled", "deactivated"].includes(
      data.status,
    )
  )
    throw new Error(`Render deploy ${data.status}`);
}
throw new Error("Render deployment did not finish within ten minutes.");
