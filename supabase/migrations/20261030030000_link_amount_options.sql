-- M2: optional link-level payment amount options.
-- Existing links keep their original $1-$5000 cap until explicitly configured.
-- This migration never changes settled payments or platform fees.
alter table public.payment_links add column if not exists min_usd numeric(12,2);
alter table public.payment_links add column if not exists max_usd numeric(12,2);
alter table public.payment_links add column if not exists quick_amounts numeric(12,2)[];
alter table public.payment_links add column if not exists note text;

create or replace function public.paylink_quick_amounts_valid(
  p_amounts numeric[], p_min numeric, p_max numeric
) returns boolean language sql immutable set search_path=public as $$
  select p_amounts is null or (
    p_min is not null and p_max is not null and
    cardinality(p_amounts) between 1 and 8 and
    array_position(p_amounts, null) is null and
    (select count(*)=count(distinct x) and
            bool_and(x between p_min and p_max and scale(x)<=2)
     from unnest(p_amounts) as a(x))
  )
$$;
comment on function public.paylink_quick_amounts_valid(numeric[],numeric,numeric) is
  'Immutable shape check for display-only quick amount choices; no financial settlement effect.';

-- Add once to permit migration replay in CI.
do $$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.payment_links'::regclass
    and conname='payment_links_amount_options_check') then
    alter table public.payment_links add constraint payment_links_amount_options_check check(
      ((min_usd is null and max_usd is null and quick_amounts is null)
        or (min_usd between 10 and 1000 and max_usd between min_usd and 1000
            and public.paylink_quick_amounts_valid(quick_amounts,min_usd,max_usd)))
      and (note is null or length(note)<=240)
    );
  end if;
end $$;

-- Validation, ownership and audit are in the database. A direct update to
-- payment_links cannot bypass the bounds constraint.
create or replace function public.set_link_amount_options(
  p_link_id uuid, p_min_usd numeric, p_max_usd numeric,
  p_quick_amounts numeric[], p_note text
) returns void language plpgsql security definer set search_path=public as $$
declare v_link public.payment_links%rowtype; v_note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
  select * into v_link from public.payment_links
    where id=p_link_id and deleted_at is null for update;
  if not found then raise exception 'Payment link not found'; end if;
  if not coalesce(is_admin() or (auth.uid()=v_link.user_id and account_is_active(v_link.user_id)),false) then
    raise exception 'Not authorized';
  end if;
  if p_min_usd is null or p_max_usd is null
     or p_min_usd < 10 or p_max_usd > 1000 or p_max_usd < p_min_usd
     or scale(p_min_usd)>2 or scale(p_max_usd)>2
     or not public.paylink_quick_amounts_valid(p_quick_amounts,p_min_usd,p_max_usd)
     or (v_note is not null and length(v_note)>240) then
    raise exception 'Invalid amount options';
  end if;
  update public.payment_links
     set min_usd=p_min_usd, max_usd=p_max_usd,
         quick_amounts=p_quick_amounts, note=v_note
   where id=p_link_id;
  perform record_audit('payment_link.amount_options','payment_link',p_link_id::text,
    jsonb_build_object('min_usd',v_link.min_usd,'max_usd',v_link.max_usd,
                       'quick_amounts',v_link.quick_amounts,'note',v_link.note),
    jsonb_build_object('min_usd',p_min_usd,'max_usd',p_max_usd,
                       'quick_amounts',p_quick_amounts,'note',v_note));
end $$;
revoke all on function public.set_link_amount_options(uuid,numeric,numeric,numeric[],text)
  from public,anon;
grant execute on function public.set_link_amount_options(uuid,numeric,numeric,numeric[],text)
  to authenticated;

-- Dedicated public projection: no email, id, wallet or other users' data.
-- Legacy links return NULL options; checkout preserves the old $1-$5000 range.
create or replace function public.get_link_amount_options(p_slug text)
returns table(min_usd numeric,max_usd numeric,quick_amounts numeric[],note text)
language sql security definer stable set search_path=public as $$
  select l.min_usd,l.max_usd,l.quick_amounts,l.note
  from public.payment_links l
  join public.profiles p on p.id=l.user_id
  where l.slug=p_slug and l.deleted_at is null and l.is_active=true
    and p.account_status='active'
  limit 1
$$;
revoke all on function public.get_link_amount_options(text) from public;
grant execute on function public.get_link_amount_options(text) to anon,authenticated;
