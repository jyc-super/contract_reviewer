export type ZoneType =
  | "cover_page"
  | "table_of_contents"
  | "contract_body"
  | "general_conditions"
  | "particular_conditions"
  | "technical_specification"
  | "drawing_list"
  | "schedule"
  | "bill_of_quantities"
  | "correspondence"
  | "quotation"
  | "signature_page"
  | "appendix_other"
  | "unknown";

export interface DocumentZone {
  id: string;
  contractId: string;
  pageFrom: number;
  pageTo: number;
  type: ZoneType;
  confidence: number;
  isAnalysisTarget: boolean;
  userConfirmed: boolean | null;
}

