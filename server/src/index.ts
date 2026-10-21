import { env } from "./env.js";
import { migrate } from "./db.js";
import { createApp } from "./app.js";
import { startBackgroundJobs } from "./lib/jobs.js";

async function main() {
  const e = env();
  await migrate();
  createApp().listen(e.PORT, () => {
    console.log(`MatouRun prêt sur le port ${e.PORT}`);
  });
  startBackgroundJobs();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
