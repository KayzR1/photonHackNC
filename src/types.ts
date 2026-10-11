export type CourtMode = "open" | "closed";

export type CaseStatus =
  | "summoned"
  | "mode_vote"
  | "testimony"
  | "cross_examination"
  | "jury_vote"
  | "verdict"
  | "closed";

/** "A" is the summoner, "B" is the other party. */
export type PartyKey = "A" | "B";

export interface RecusalResult {
  shouldRecuse: boolean;
  reason?: string;
}

export interface CrossExamResult {
  questionsForPartyA: string[];
  questionsForPartyB: string[];
}

export interface VerdictResult {
  ruling: string;
  reasoning: string;
  sentence: string;
  citesPrecedent?: string[];
}

export interface PrecedentForJudge {
  title: string;
  ruling: string;
  sentence: string;
}

export interface JuryTally {
  forA: number;
  forB: number;
}
