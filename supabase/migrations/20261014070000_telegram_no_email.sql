-- Forward-only. The Telegram message for a settled payment named the
-- receiving account by display name, or by its EMAIL when no display name
-- was set, and Telegram keeps a copy we cannot delete. Fall back to the
-- public store name, then a short account id, never the email. Body is the
-- production definition (md5 of prosrc matched 2026-10-14) with only that
-- line changed.

CREATE OR REPLACE FUNCTION public.enqueue_payment_settled_telegram()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_link payment_links;
  v_owner profiles;
begin
  -- A message must never stop a payment from settling.
  begin
    if coalesce(new.amount_settled, 0) < hide_threshold_for(new.user_id) then
      return null;
    end if;
    select * into v_link from payment_links where id = new.payment_link_id;
    select * into v_owner from profiles where id = new.user_id;
    insert into telegram_outbox (kind, ref, recipient, chat, payload)
    values ('payment_settled', new.id::text, 'admin', 'admin', jsonb_build_object(
      'payment_id', new.id,
      'link_name', coalesce(nullif(v_link.display_name, ''), v_link.slug),
      'link_slug', v_link.slug,
      'owner_id', new.user_id,
      'owner_name', coalesce(nullif(v_owner.display_name, ''), nullif(v_owner.public_slug, ''), 'account ' || left(new.user_id::text, 8)),
      'amount_usd', coalesce(new.amount_settled, 0),
      'amount_sat', new.amount_sat,
      'fee_usd', coalesce(new.platform_fee_amount, 0),
      'net_usd', coalesce(new.amount_settled, 0) - coalesce(new.platform_fee_amount, 0),
      'settled_at', new.settled_at,
      'show_owner', true
    ))
    on conflict on constraint telegram_outbox_once do nothing;
  exception when others then
    raise warning 'telegram message for payment % not queued: %', new.id, sqlerrm;
  end;
  return null;
end;
$function$;
