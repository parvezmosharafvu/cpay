// Test helper: save payout addresses for a user and move them past the 24 h
// cooldown (20261009010000). The cooldown trigger ignores client values, so
// the backdate runs with triggers off in its own transaction (superuser test
// database only). Not loaded by the service.
import { TRON, EVM } from './fake-breez.mjs';

export async function saveReadyAddresses(db, userId, addresses = { tron: TRON, ethereum: EVM }) {
  for (const [network, address] of Object.entries(addresses)) {
    await db.query(
      `insert into usdt_wallets(user_id, network, address) values ($1, $2, $3)
       on conflict (user_id, network) do update set address = excluded.address`, [userId, network, address]);
  }
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(`update usdt_wallets set usable_after = now() - interval '1 minute' where user_id = $1`, [userId]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
