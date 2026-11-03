import { DatabaseSync } from "node:sqlite";
import { stableJson, normalizePages } from "./financial-data";
type Report = ReturnType<typeof normalizePages>;

// Каждый run — отдельная версия распознавания; запросы фактов должны выбирать run_id.
// Сырые/сомнительные результаты хранятся в runs; facts — только проверенные.
export function saveReport(
  databasePath: string,
  report: Report,
): { inserted: boolean; facts: number } {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        document_hash TEXT NOT NULL REFERENCES documents(hash),
        status TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), logical_key TEXT NOT NULL,
        organization_id TEXT NOT NULL, organization_name TEXT NOT NULL,
        form TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
        report_period_start TEXT NOT NULL, report_period_end TEXT NOT NULL,
        period_start TEXT, period_end TEXT NOT NULL, indicator_date TEXT,
        currency TEXT NOT NULL, unit TEXT NOT NULL, multiplier INTEGER NOT NULL,
        capital_component TEXT, value REAL, status TEXT NOT NULL,
        document_hash TEXT NOT NULL REFERENCES documents(hash), page INTEGER NOT NULL,
        png TEXT NOT NULL, source_name TEXT, raw_cell TEXT NOT NULL, source_column TEXT NOT NULL,
        model TEXT NOT NULL, pipeline_version TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version TEXT NOT NULL,
        observation_json TEXT NOT NULL,
        UNIQUE(run_id,logical_key)
      );
      CREATE INDEX IF NOT EXISTS facts_lookup ON facts(organization_id,form,code,period_end);
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      const json = stableJson(report);
      const existing = db
        .prepare("SELECT report_json FROM runs WHERE id=?")
        .get(report.run_id);
      if (existing) {
        if (existing.report_json !== json)
          throw new Error(
            "Повтор обработки имеет тот же run_id, но другой результат. Сохраните новую версию обработки; предыдущие данные не перезаписаны.",
          );
        db.exec("COMMIT");
        return { inserted: false, facts: 0 };
      }
      db.prepare("INSERT OR IGNORE INTO documents(hash) VALUES (?)").run(
        report.document_hash,
      );
      db.prepare(
        "INSERT INTO runs(id,document_hash,status,report_json) VALUES (?,?,?,?)",
      ).run(report.run_id, report.document_hash, report.status, json);
      if (report.status === "ready") {
        for (const row of report.observations) {
          const { provenance, ...fact } = row;
          const record = {
            ...fact,
            ...provenance,
            observation_json: stableJson(row),
          };
          const columns = Object.keys(record);
          const statement = db.prepare(
            `INSERT INTO facts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          );
          statement.run(...Object.values(record));
        }
      }
      db.exec("COMMIT");
      return {
        inserted: true,
        facts: report.status === "ready" ? report.observations.length : 0,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
