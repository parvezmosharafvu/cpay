-- Read-only wallet responses (balance info, fiat rates, withdraw routes)
-- cached across Edge isolates, so an admin page load does not need the
-- wallet lease for every read. Same lockdown as the rest of the schema.
create table if not exists breez_wallet.response_cache (
  key text primary key,
  status int not null,
  body text not null,
  updated_at timestamptz not null default now()
);
alter table breez_wallet.response_cache enable row level security;
revoke all on breez_wallet.response_cache from public, anon, authenticated;
