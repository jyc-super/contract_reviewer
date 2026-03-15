export type ContractStatus =
  | "uploading"
  | "parsing"
  | "quality_checking"
  | "filtering"
  | "analyzing"
  | "ready"
  | "partial"
  | "error";

export interface ContractSummary {
  id: string;
  name: string;
  status: ContractStatus;
  uploadedAt: string;
  updatedAt: string;
}

