// Write the labeled feedback on posted comments as JSON lines, for filter training:
//   pnpm export:feedback feedback.jsonl
//   python -m rlfilter.cli dataset --feedback feedback.jsonl
import { writeFile } from 'node:fs/promises';
import { createDb, feedbackRows } from '@reviewlens/db';

for (const path of ['.env', new URL('../../../.env', import.meta.url)]) {
  try {
    process.loadEnvFile(path);
    break;
  } catch {
    // Not there; try the next location.
  }
}

const out = process.argv[2];
const url = process.env.DATABASE_URL;
if (!out || !url) {
  console.error('usage: export-feedback <out.jsonl>   (needs DATABASE_URL)');
  process.exit(2);
}
const db = createDb(url);
try {
  const rows = await feedbackRows(db);
  await writeFile(out, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const useful = rows.filter((r) => r.label === 1).length;
  console.error(`wrote ${rows.length} labeled comments (${useful} useful) -> ${out}`);
} finally {
  await db.$disconnect();
}
