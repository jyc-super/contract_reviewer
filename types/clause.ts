export interface Clause {
  id: string;
  contractId: string;
  zoneId: string;
  clausePrefix: string; // GC-, PC-, MAIN-
  number?: string; // 예: 14.1
  title?: string;
  text: string;
  isAutoSplit: boolean;
  needsReview: boolean;
  contentHash: string;
}

