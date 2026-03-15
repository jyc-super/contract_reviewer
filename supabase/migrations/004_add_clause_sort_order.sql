ALTER TABLE clauses ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;

-- Backfill existing data: assign sort_order based on created_at order within each contract
UPDATE clauses c SET sort_order = sub.rn FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY contract_id ORDER BY created_at, id) - 1 AS rn
  FROM clauses
) sub WHERE c.id = sub.id;
