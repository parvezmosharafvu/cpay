-- CPAY operator-only, READ-ONLY solvency evidence snapshot.
-- Run with a trusted operator's direct PostgreSQL access; never expose this
-- query as an anonymous RPC or send raw outputs to public logs/repositories.
-- It deliberately NEVER asserts solvency or compares satoshis to USD.
-- Separate owner-reviewed BTC/USD valuation, liabilities audit, wallet
-- provider proof and financial sign-off remain mandatory.
WITH
  account_claims AS (
    SELECT count(*) AS accounts_checked,
           coalesce(sum(greatest(coalesce(b.available, 0), 0)), 0) AS available_usd,
           count(*) FILTER (WHERE b.available IS NULL OR b.available < 0) AS anomalous_accounts
    FROM public.profiles p
    CROSS JOIN LATERAL public.get_balance_for(p.id) b
  ),
  pending_withdrawals AS (
    SELECT count(*) AS pending_count,
           coalesce(sum(greatest(coalesce(amount_requested, 0), 0)), 0) AS pending_usd,
           count(*) FILTER (WHERE amount_requested IS NULL OR amount_requested < 0) AS anomalous_count
    FROM public.withdrawals
    WHERE status IS NULL OR status NOT IN ('paid', 'rejected', 'failed')
  ),
  pending_forwards AS (
    SELECT count(*) AS pending_count,
           coalesce(sum(greatest(coalesce(amount_usd, 0), 0)), 0) AS pending_usd,
           count(*) FILTER (WHERE amount_usd IS NULL OR amount_usd < 0) AS anomalous_count
    FROM public.payment_forwards
    -- Future/unknown states remain liabilities until explicitly reconciled.\n    WHERE status IS NULL OR status NOT IN ('forwarded', 'released')
  ),
  registered_wallets AS (
    SELECT count(*) FILTER (WHERE w.network = 'mainnet') AS mainnet_count,
           count(*) FILTER (WHERE w.network <> 'mainnet') AS non_mainnet_count,
           count(*) FILTER (WHERE w.network = 'mainnet' AND w.status = 'active') AS active_mainnet_count,
           count(*) FILTER (
             WHERE w.network = 'mainnet' AND
               (s.balance_sat IS NULL OR s.balance_sat < 0 OR
                s.synced_at IS NULL OR s.synced_at > statement_timestamp() OR
                s.synced_at < statement_timestamp() - interval '15 minutes' OR
                s.last_error IS NOT NULL)
           ) AS unverified_mainnet_count,
           coalesce(sum(s.balance_sat) FILTER (
             WHERE w.network = 'mainnet' AND w.status = 'active' AND
                   s.balance_sat >= 0 AND s.synced_at IS NOT NULL AND
                   s.synced_at BETWEEN statement_timestamp() - interval '15 minutes' AND statement_timestamp()
                   AND s.last_error IS NULL
           ), 0) AS recently_reported_active_sat
    FROM breez_wallet.wallets w
    LEFT JOIN breez_wallet.wallet_status s ON s.wallet_id = w.id
    WHERE w.status <> 'removed'
  )
SELECT jsonb_build_object(
  'checked_at', statement_timestamp(),
  'verdict', 'UNVERIFIED',
  'verdict_reason', 'USD liabilities and satoshi balances cannot establish coverage without an independent current exchange-rate floor, settlement/fee adjustments and actual wallet proof',
  'liabilities_usd', jsonb_build_object(
    'accounts_checked', a.accounts_checked,
    'available_positive', round(a.available_usd, 2),
    'unpaid_withdrawals', round(d.pending_usd, 2),
    'unsettled_forwards', round(f.pending_usd, 2),
    'gross_claims_minimum', round(a.available_usd + d.pending_usd + f.pending_usd, 2),
    'outstanding_withdrawal_count', d.pending_count,
    'outstanding_forward_count', f.pending_count,
    'anomaly_count', a.anomalous_accounts + d.anomalous_count + f.anomalous_count
  ),
  'wallet_evidence_sat', jsonb_build_object(
    'mainnet_wallet_count', w.mainnet_count,
    'active_mainnet_wallet_count', w.active_mainnet_count,
    'non_mainnet_wallet_count_excluded', w.non_mainnet_count,
    'mainnet_wallets_without_usable_recent_report', w.unverified_mainnet_count,
    'recently_reported_active_sat', w.recently_reported_active_sat
  )
) AS solvency_evidence
FROM account_claims a CROSS JOIN pending_withdrawals d
CROSS JOIN pending_forwards f CROSS JOIN registered_wallets w;
