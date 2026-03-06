export type ContractStatus =
  | "uploading"
  | "filtering"
  | "parsing"
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

