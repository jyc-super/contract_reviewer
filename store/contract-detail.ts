import { create } from "zustand";

interface ContractDetailState {
  /** 현재 계약 상세에서 선택된 조항 ID */
  selectedClauseId: string | null;
  setSelectedClauseId: (id: string | null) => void;
}

export const useContractDetailStore = create<ContractDetailState>((set) => ({
  selectedClauseId: null,
  setSelectedClauseId: (id) => set({ selectedClauseId: id }),
}));
