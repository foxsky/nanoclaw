export type SemanticField = 'scheduled_at' | 'due_date' | 'assignee';

export interface QualifyingMutation {
  taskId: string;
  boardId: string;
  action: 'updated';
  by: string | null;
  at: string;
  details: string;
  fieldKind: SemanticField;
  extractedValue: string | null;
}

export interface FactCheckContext {
  userMessage: string | null;
  userDisplayName: string | null;
  messageTimestamp: string | null;
  boardTimezone: string;
  headerToday: string;
  headerWeekday: string;
}

export interface SemanticDeviation {
  taskId: string;
  boardId: string;
  fieldKind: SemanticField;
  at: string;
  by: string;
  userMessage: string | null;
  storedValue: string | null;
  intentMatches: boolean;
  deviation: string | null;
  confidence: 'high' | 'med' | 'low';
  rawResponse: string;
}
