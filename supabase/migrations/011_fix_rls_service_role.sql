-- 011_fix_rls_service_role.sql
-- Service Role 키를 사용하는 Admin 클라이언트가 RLS에 차단되는 문제 수정.
-- auth.uid()가 NULL인 Service Role 요청도 모든 행에 접근 가능하도록 변경.

-- ============================================================
-- contracts
-- ============================================================
drop policy if exists "contracts_select_own" on public.contracts;
create policy "contracts_select_own"
  on public.contracts for select
  using (auth.role() = 'service_role' or user_id = auth.uid());

drop policy if exists "contracts_insert_own" on public.contracts;
create policy "contracts_insert_own"
  on public.contracts for insert
  with check (auth.role() = 'service_role' or user_id = auth.uid());

drop policy if exists "contracts_update_own" on public.contracts;
create policy "contracts_update_own"
  on public.contracts for update
  using (auth.role() = 'service_role' or user_id = auth.uid());

drop policy if exists "contracts_delete_own" on public.contracts;
create policy "contracts_delete_own"
  on public.contracts for delete
  using (auth.role() = 'service_role' or user_id = auth.uid());

-- ============================================================
-- document_zones
-- ============================================================
drop policy if exists "document_zones_select_own" on public.document_zones;
create policy "document_zones_select_own"
  on public.document_zones for select
  using (
    auth.role() = 'service_role'
    or contract_id in (select id from public.contracts where user_id = auth.uid())
  );

drop policy if exists "document_zones_insert_own" on public.document_zones;
create policy "document_zones_insert_own"
  on public.document_zones for insert
  with check (
    auth.role() = 'service_role'
    or contract_id in (select id from public.contracts where user_id = auth.uid())
  );

drop policy if exists "document_zones_update_own" on public.document_zones;
create policy "document_zones_update_own"
  on public.document_zones for update
  using (
    auth.role() = 'service_role'
    or contract_id in (select id from public.contracts where user_id = auth.uid())
  );

drop policy if exists "document_zones_delete_own" on public.document_zones;
create policy "document_zones_delete_own"
  on public.document_zones for delete
  using (
    auth.role() = 'service_role'
    or contract_id in (select id from public.contracts where user_id = auth.uid())
  );

-- ============================================================
-- clauses
-- ============================================================
drop policy if exists "clauses_select_own" on public.clauses;
create policy "clauses_select_own"
  on public.clauses for select
  using (
    auth.role() = 'service_role'
    or contract_id in (select id from public.contracts where user_id = auth.uid())
  );

drop policy if exists "clauses_insert_own" on public.clauses;
create policy "clauses_insert_own"
  on public.clauses for insert
  with check (
    auth.role() = 'service_role'
    or contract_id in (select id from public.contracts where user_id = auth.uid())
  );

drop policy if exists "clauses_update_own" on public.clauses;
create policy "clauses_update_own"
  on public.clauses for update
  using (
    auth.role() = 'service_role'
    or contract_id in (select id from public.contracts where user_id = auth.uid())
  );

drop policy if exists "clauses_delete_own" on public.clauses;
create policy "clauses_delete_own"
  on public.clauses for delete
  using (
    auth.role() = 'service_role'
    or contract_id in (select id from public.contracts where user_id = auth.uid())
  );

-- ============================================================
-- clause_analyses
-- ============================================================
drop policy if exists "clause_analyses_select_own" on public.clause_analyses;
create policy "clause_analyses_select_own"
  on public.clause_analyses for select
  using (
    auth.role() = 'service_role'
    or clause_id in (
      select c.id from public.clauses c
      join public.contracts ct on ct.id = c.contract_id
      where ct.user_id = auth.uid()
    )
  );

drop policy if exists "clause_analyses_insert_own" on public.clause_analyses;
create policy "clause_analyses_insert_own"
  on public.clause_analyses for insert
  with check (
    auth.role() = 'service_role'
    or clause_id in (
      select c.id from public.clauses c
      join public.contracts ct on ct.id = c.contract_id
      where ct.user_id = auth.uid()
    )
  );

drop policy if exists "clause_analyses_update_own" on public.clause_analyses;
create policy "clause_analyses_update_own"
  on public.clause_analyses for update
  using (
    auth.role() = 'service_role'
    or clause_id in (
      select c.id from public.clauses c
      join public.contracts ct on ct.id = c.contract_id
      where ct.user_id = auth.uid()
    )
  );

drop policy if exists "clause_analyses_delete_own" on public.clause_analyses;
create policy "clause_analyses_delete_own"
  on public.clause_analyses for delete
  using (
    auth.role() = 'service_role'
    or clause_id in (
      select c.id from public.clauses c
      join public.contracts ct on ct.id = c.contract_id
      where ct.user_id = auth.uid()
    )
  );
