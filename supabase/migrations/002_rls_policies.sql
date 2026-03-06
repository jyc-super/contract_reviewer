-- 002_rls_policies.sql
-- RLS 정책: contracts는 user_id = auth.uid(), 나머지는 contract 소유권으로 접근 제어.
-- Service Role 사용 API는 RLS를 우회합니다. Supabase Auth 연동 시 anon/authenticated 키로 호출하면 적용됩니다.

alter table public.contracts enable row level security;
alter table public.document_zones enable row level security;
alter table public.clauses enable row level security;
alter table public.clause_analyses enable row level security;

-- contracts: 본인 계약만 접근
create policy "contracts_select_own"
  on public.contracts for select
  using (user_id = auth.uid());

create policy "contracts_insert_own"
  on public.contracts for insert
  with check (user_id = auth.uid());

create policy "contracts_update_own"
  on public.contracts for update
  using (user_id = auth.uid());

create policy "contracts_delete_own"
  on public.contracts for delete
  using (user_id = auth.uid());

-- document_zones: 본인 계약의 구역만 접근
create policy "document_zones_select_own"
  on public.document_zones for select
  using (
    contract_id in (select id from public.contracts where user_id = auth.uid())
  );

create policy "document_zones_insert_own"
  on public.document_zones for insert
  with check (
    contract_id in (select id from public.contracts where user_id = auth.uid())
  );

create policy "document_zones_update_own"
  on public.document_zones for update
  using (
    contract_id in (select id from public.contracts where user_id = auth.uid())
  );

create policy "document_zones_delete_own"
  on public.document_zones for delete
  using (
    contract_id in (select id from public.contracts where user_id = auth.uid())
  );

-- clauses: 본인 계약의 조항만 접근
create policy "clauses_select_own"
  on public.clauses for select
  using (
    contract_id in (select id from public.contracts where user_id = auth.uid())
  );

create policy "clauses_insert_own"
  on public.clauses for insert
  with check (
    contract_id in (select id from public.contracts where user_id = auth.uid())
  );

create policy "clauses_update_own"
  on public.clauses for update
  using (
    contract_id in (select id from public.contracts where user_id = auth.uid())
  );

create policy "clauses_delete_own"
  on public.clauses for delete
  using (
    contract_id in (select id from public.contracts where user_id = auth.uid())
  );

-- clause_analyses: 본인 계약의 조항 분석만 접근 (clause_id -> clauses -> contract_id)
create policy "clause_analyses_select_own"
  on public.clause_analyses for select
  using (
    clause_id in (
      select c.id from public.clauses c
      join public.contracts ct on ct.id = c.contract_id
      where ct.user_id = auth.uid()
    )
  );

create policy "clause_analyses_insert_own"
  on public.clause_analyses for insert
  with check (
    clause_id in (
      select c.id from public.clauses c
      join public.contracts ct on ct.id = c.contract_id
      where ct.user_id = auth.uid()
    )
  );

create policy "clause_analyses_update_own"
  on public.clause_analyses for update
  using (
    clause_id in (
      select c.id from public.clauses c
      join public.contracts ct on ct.id = c.contract_id
      where ct.user_id = auth.uid()
    )
  );

create policy "clause_analyses_delete_own"
  on public.clause_analyses for delete
  using (
    clause_id in (
      select c.id from public.clauses c
      join public.contracts ct on ct.id = c.contract_id
      where ct.user_id = auth.uid()
    )
  );
