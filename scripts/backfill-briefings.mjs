import { readFileSync } from 'node:fs';
import postgres from 'postgres';
const j = JSON.parse(readFileSync(process.env.HOME + '/.restart-org/briefings.json','utf8'));
const sql = postgres('postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp');
let n = 0;
for (const b of j.briefings ?? []) {
  await sql`INSERT INTO papercusp_shared.briefings
    (id, title, quarter, status, created_at, script_path, duration_seconds,
     youtube_url, youtube_video_id, thumbnail_url, render_log, error, summary)
    VALUES (${b.id}, ${b.title}, ${b.quarter ?? ''}, ${b.status},
            ${b.created_at}, ${b.script_path}, ${b.duration_seconds},
            ${b.youtube_url}, ${b.youtube_video_id}, ${b.thumbnail_url},
            ${b.render_log}, ${b.error}, ${b.summary})
    ON CONFLICT (id) DO NOTHING`;
  n++;
}
console.log('inserted', n);
const rows = await sql`SELECT id, title, status FROM papercusp_shared.briefings ORDER BY id`;
for (const r of rows) console.log('  ', r.id, r.status, r.title);
await sql.end();
