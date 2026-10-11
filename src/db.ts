import DatabaseConstructor, { type Database } from "better-sqlite3";
import type { CaseStatus, CourtMode } from "./types.js";

const DB_PATH = process.env.HUNG_JURY_DB_PATH ?? "./hung-jury.db";

export const db: Database = new DatabaseConstructor(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    title TEXT NOT NULL,
    mode TEXT,
    parties TEXT NOT NULL,
    status TEXT NOT NULL,
    ruling TEXT,
    reasoning TEXT,
    sentence TEXT,
    cites_precedent TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_cases_group_decided
    ON cases (group_id, decided_at DESC);
`);

export interface CaseRow {
  id: string;
  group_id: string;
  title: string;
  mode: CourtMode | null;
  parties: string; // JSON string[]
  status: CaseStatus;
  ruling: string | null;
  reasoning: string | null;
  sentence: string | null;
  cites_precedent: string | null; // JSON string[]
  created_at: number;
  decided_at: number | null;
}

export interface PrecedentCase {
  title: string;
  ruling: string;
  sentence: string;
}

const insertStmt = db.prepare(`
  INSERT INTO cases (id, group_id, title, mode, parties, status, created_at)
  VALUES (@id, @group_id, @title, @mode, @parties, @status, @created_at)
`);

export function insertCase(row: {
  id: string;
  groupId: string;
  title: string;
  parties: string[];
  status: CaseStatus;
}): void {
  insertStmt.run({
    id: row.id,
    group_id: row.groupId,
    title: row.title,
    mode: null,
    parties: JSON.stringify(row.parties),
    status: row.status,
    created_at: Date.now(),
  });
}

const updateStatusStmt = db.prepare(`UPDATE cases SET status = @status WHERE id = @id`);
export function updateCaseStatus(id: string, status: CaseStatus): void {
  updateStatusStmt.run({ id, status });
}

const updateModeStmt = db.prepare(`UPDATE cases SET mode = @mode WHERE id = @id`);
export function updateCaseMode(id: string, mode: CourtMode): void {
  updateModeStmt.run({ id, mode });
}

const recordVerdictStmt = db.prepare(`
  UPDATE cases
  SET status = @status, ruling = @ruling, reasoning = @reasoning, sentence = @sentence,
      cites_precedent = @citesPrecedent, decided_at = @decidedAt
  WHERE id = @id
`);
export function recordVerdict(
  id: string,
  verdict: { ruling: string; reasoning: string; sentence: string; citesPrecedent?: string[] },
): void {
  recordVerdictStmt.run({
    id,
    status: "verdict" satisfies CaseStatus,
    ruling: verdict.ruling,
    reasoning: verdict.reasoning,
    sentence: verdict.sentence,
    citesPrecedent: JSON.stringify(verdict.citesPrecedent ?? []),
    decidedAt: Date.now(),
  });
}

const recentDecidedStmt = db.prepare(`
  SELECT title, ruling, sentence FROM cases
  WHERE group_id = @groupId AND decided_at IS NOT NULL AND ruling IS NOT NULL
  ORDER BY decided_at DESC
  LIMIT @limit
`);
export function getRecentPrecedent(groupId: string, limit = 5): PrecedentCase[] {
  return recentDecidedStmt.all({ groupId, limit }) as PrecedentCase[];
}

const getCaseStmt = db.prepare(`SELECT * FROM cases WHERE id = @id`);
export function getCaseRow(id: string): CaseRow | undefined {
  return getCaseStmt.get({ id }) as CaseRow | undefined;
}
