-- CPAY — 20261015010000: payout-address ready time on the desk; names from Google sign-in
--
-- 1. my_payout_book() also returns each saved wallet's usable_after (the
--    24-hour wait from 20261009010000), so the Freelancer desk can show
--    "ready" or "usable from <time>" next to every network. Read-only; the
--    caller still sees only their own wallets.
-- 2. handle_new_user() takes the profile name from Google sign-in metadata
--    (full_name / name) when the sign-up form's display_name is absent, so
--    a Google account does not start with an email prefix as its name.
--    Everything else (role creator, pending unless auto-approval, the
--    application row) is unchanged.
--
-- Both bodies are the production definitions (md5 checked on 2026-10-15)
-- with only those lines changed. Forward-only; rollback = re-create them
-- from 20261004020000 / 20261005020000.

CREATE OR REPLACE FUNCTION public.my_payout_book()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_p profiles;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_p from profiles where id = v_uid;
  return jsonb_build_object(
    'withdraw_threshold', v_p.withdraw_threshold,
    'preferred_usdt_network', v_p.preferred_usdt_network,
    'auto_withdraw_enabled', coalesce(v_p.auto_withdraw_enabled, false),
    'wallets', coalesce((
      select jsonb_agg(jsonb_build_object('network', network, 'address', address, 'usable_after', usable_after) order by network)
      from usdt_wallets where user_id = v_uid
    ), '[]'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- Sign-up form sends display_name; Google sign-in sends full_name / name.
  v_name text := left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
                               nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                               nullif(trim(new.raw_user_meta_data->>'name'), ''),
                               split_part(new.email, '@', 1)), 80);
  v_default_links int;
  v_auto boolean := cpay_auto_approval_enabled('freelancer');
  v_status text := case when v_auto then 'active' else 'pending' end;
begin
  select coalesce((value->>'count')::int, 5)
    into v_default_links
  from app_settings where key = 'default_max_payment_links';

  insert into public.profiles
    (id, email, display_name, role, account_status,
     withdrawal_fee_percent, max_payment_links)
  values
    (new.id, new.email, v_name, 'creator', v_status,
     null, coalesce(v_default_links, 5))
  on conflict (id) do nothing;

  insert into public.account_applications
    (user_id, email, display_name, requested_role, status, reviewed_at)
  values
    (new.id, new.email, v_name, 'freelancer',
     case when v_auto then 'approved' else 'pending' end,
     case when v_auto then now() else null end)
  on conflict (user_id) do update
    set email = excluded.email,
        display_name = excluded.display_name,
        requested_role = excluded.requested_role,
        updated_at = now();

  return new;
end;
$function$;
