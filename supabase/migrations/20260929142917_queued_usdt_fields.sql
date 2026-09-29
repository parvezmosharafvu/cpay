-- Instant Breez sends still store quote_id + amount_sat.
-- Queued USDT payouts (threshold / reseller / manual) are method=stablecoin
-- with coin+chain+destination only. The old check rejected those rows.

alter table public.withdrawals drop constraint if exists withdrawals_stablecoin_fields;
alter table public.withdrawals add constraint withdrawals_stablecoin_fields
  check (
    method <> 'stablecoin'
    or (coin is not null and chain is not null and destination is not null)
  );
