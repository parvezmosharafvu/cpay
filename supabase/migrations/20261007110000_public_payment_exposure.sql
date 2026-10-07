-- ============================================================
-- P2 item 6: public endpoints reveal only what the payer needs
-- ============================================================
-- 1. payments: drop the anon Realtime SELECT policy.
--    0018 let anon SELECT (id, amount_requested, amount_settled, method,
--    status, expires_at) of EVERY payment whose expiry is within the last
--    two hours, so anyone with the public anon key could list recent
--    payment ids and amounts (GET /rest/v1/payments?select=...) and then
--    resolve merchant name and slug for each through get_invoice_public().
--    The invoice page now follows its own payment by polling
--    get_invoice_public(<uuid>) (it already polled as a fallback), so anon
--    needs no table access at all. Owners and admins keep their own RLS
--    policies and Realtime on their own rows.
--
-- 2. public_settled_feed(): amounts of other people's payments. No page
--    calls it (feed toggle is off in production); revoke it from browser
--    roles so it cannot be switched on by accident. service_role keeps it.
--
-- Unchanged: get_invoice_public(uuid) (unguessable id, the payer's own
-- invoice), lookup_payment_status(text) (exact full payment hash or
-- invoice only), get_link_preview(text), get_public_store(uuid).
--
-- Rollback (documented, not automatic):
--   create policy "anon can watch live invoice status" on public.payments
--     for select to anon using (expires_at > now() - interval '2 hours');
--   grant select (id, amount_requested, amount_settled, method, status, expires_at)
--     on public.payments to anon;
--   grant execute on function public.public_settled_feed(integer) to anon, authenticated;
--   (anon INSERT/UPDATE/DELETE on payments were never used; RLS blocked them.)
-- ============================================================

drop policy if exists "anon can watch live invoice status" on public.payments;
drop policy if exists "anon can watch invoice status for realtime" on public.payments;
revoke select on public.payments from anon;
-- Column-level grants are separate from the table grant; clear them too.
revoke select (id, amount_requested, amount_settled, method, status, expires_at) on public.payments from anon;

-- Defence in depth: anon never writes payments (create-invoice uses the
-- service role). RLS already has no anon write policy; Supabase default
-- privileges still granted the table-level INSERT/UPDATE/DELETE.
revoke insert, update, delete on public.payments from anon;

revoke execute on function public.public_settled_feed(integer) from public, anon, authenticated;
grant execute on function public.public_settled_feed(integer) to service_role;
