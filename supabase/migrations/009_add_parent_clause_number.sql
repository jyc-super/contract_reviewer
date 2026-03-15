-- Migration 009: Add parent_clause_number to clauses table
-- Purpose: Support hierarchical clause structure (e.g. 1.1.1.x Definitions, (a)(b)(c) sub-items)
-- parent_clause_number stores the normalized clause_number of the immediate parent clause.
-- NULL means the clause is top-level within its zone.

ALTER TABLE public.clauses
  ADD COLUMN IF NOT EXISTS parent_clause_number TEXT;

-- Index for efficient subtree queries (e.g. fetch all children of a given clause)
CREATE INDEX IF NOT EXISTS idx_clauses_parent_clause_number
  ON public.clauses (contract_id, parent_clause_number)
  WHERE parent_clause_number IS NOT NULL;

COMMENT ON COLUMN public.clauses.parent_clause_number IS
  'Normalized clause number of the immediate parent clause. NULL for top-level clauses. '
  'Examples: "1.1.1" for clause "1.1.1.2", or "1.1.1" for sub-item "(a)" under "1.1.1".';
