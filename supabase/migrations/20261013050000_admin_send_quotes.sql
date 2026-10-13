-- Admin platform-wallet send quotes, shared across wallet instances.
-- The wallet Edge Function hands the wallet between isolates per request,
-- so a quote kept in memory was lost before confirm ("Nothing to confirm").
-- Single use (consumed_at), tied to the admin, expires with the quote.
-- Not exposed to PostgREST; RLS on with no policies.
create table if not exists breez_wallet.admin_send_quotes (
  id uuid primary key,
  admin_id uuid not null,
  kind text not null,
  request jsonb not null,
  view jsonb not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists admin_send_quotes_created_idx on breez_wallet.admin_send_quotes (created_at);
alter table breez_wallet.admin_send_quotes enable row level security;
revoke all on breez_wallet.admin_send_quotes from public, anon, authenticated;
