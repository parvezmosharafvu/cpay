-- Freelancer withdrawal quotes, shared across wallet instances (same design
-- as admin_send_quotes): tied to the user, expires with the quote, claimed
-- once via consumed_at. Not exposed to PostgREST; RLS on, no policies.
create table if not exists breez_wallet.withdraw_quotes (
  id uuid primary key,
  user_id uuid not null,
  request jsonb not null,
  view jsonb not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists withdraw_quotes_created_idx on breez_wallet.withdraw_quotes (created_at);
alter table breez_wallet.withdraw_quotes enable row level security;
revoke all on breez_wallet.withdraw_quotes from public, anon, authenticated;
