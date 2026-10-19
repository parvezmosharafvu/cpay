# CPAY Wallet: Lightning addresses

A CPAY Wallet user can pick a Lightning address, `name@ln.pay-cashapp.buzz`,
that anyone can pay at any time. The money goes straight to the keys on the
user's phone. CPAY never holds it.

**Domain (owner decision, 2026-10-18): `ln.pay-cashapp.buzz`.** It is a
DNS-only CNAME to the vendor's hosted LNURL server. The website needs no
code or secret for it.

## How it works

- The wallet library (Breez SDK Spark 0.26.0) registers the name with the
  vendor's LNURL server for the domain. Each check and registration is
  signed with the wallet's own identity key.
- A payer's wallet looks up
  `https://ln.pay-cashapp.buzz/.well-known/lnurlp/<name>`. The vendor's
  server answers with an invoice for the user's wallet.
- **One address per wallet per domain.** Registering a new name replaces
  the old one. A removed name stays reserved for that wallet, so nobody
  else can take it.
- **Plain names only.** The wallet offers lowercase letters and digits,
  with single `.`, `-` or `_` between them, at most 32 characters
  (`wallet/src/lnaddress.js`).

## Configuration

| Setting | Where | Value |
|---|---|---|
| `LIGHTNING_ADDRESS_DOMAIN` | build variable of the `cpay-wallet` Workers project | `ln.pay-cashapp.buzz` |
| DNS record | Cloudflare DNS for `pay-cashapp.buzz` | `ln` CNAME `breez.tips`, **DNS only** (grey cloud, not proxied) |

Leaving `LIGHTNING_ADDRESS_DOMAIN` unset means no Lightning address option.
The library's own default domain is never used. The wallet's CSP allows
exactly `https://<domain>` for the registration calls.

## Owner steps before it works

1. **Dedicated API key** ([release gate G1](../docs/WALLET-RELEASE-GATES.md)).
   The domain is registered with the vendor for the wallet's own key.
2. **DNS.** In Cloudflare, add `ln` as a CNAME record pointing to
   `breez.tips`, set to **DNS only**. Nothing else may sit under
   `ln.pay-cashapp.buzz`.
3. **Register the domain with the vendor.** Email
   `contact@breez.technology` (draft below). They verify the domain and
   add it to their allowed list.
4. **Build the wallet with `LIGHTNING_ADDRESS_DOMAIN=ln.pay-cashapp.buzz`.**
   The vendor's server is mainnet only, so a real address can only be
   tested on the production build with a small amount (gate G7).
5. **If `DIRECT_PROVIDER_HOSTS` is set** for CPAY direct payments, add
   `ln.pay-cashapp.buzz` (and the callback host the vendor's server
   returns, if it differs) to it.

## Using it for CPAY direct payments

After registering, the wallet shows **Use for CPAY direct payments**. It
opens `https://pay-cashapp.buzz/dashboard.html#direct=<address>` with the
address filled in on the desk.

- **The member still saves it on the desk.** They tap Check and Save
  there. CPAY checks the address with its provider, asks for a fresh
  sign-in, and uses it 24 hours later.
- **The wallet never writes to CPAY.** With the optional CPAY link, it
  reads where direct payments go (`get_my_direct_settlement`) and says so.

## Risks the owner accepts

- **It reads as CPAY.** `name@ln.pay-cashapp.buzz` sits under the website's
  domain, and anyone with the wallet can pick a name. CPAY cannot filter
  names on a domain the vendor serves. The wallet's plain-name rule blocks
  only lookalike characters, not names such as `support`. The email asks
  the vendor whether names can be restricted.
- **A third party serves a subdomain of the website.** The vendor's server
  answers for `ln.pay-cashapp.buzz`. This is acceptable because:
  - The website keeps its session in browser storage, not cookies, so a
    cookie scoped to the parent domain carries nothing CPAY relies on.
    Never add parent-domain cookies while this record exists.
  - Passkeys for CPAY accounts name their origin, and the account service
    accepts only the website's own origin.
  - Wallet passkeys are bound to `wallet.pay-cashapp.buzz`, which a sibling
    host cannot use.
- **The vendor's server makes the invoices.** If it is down, the address
  cannot be paid, but invoices made directly in the wallet still work. The
  server sees each payment's amount and the payer's comment. It does not
  hold the money.
- **Changing the domain later** leaves every registered address on the
  old domain. A move means:
  1. registering the new domain with the vendor;
  2. rebuilding with the new `LIGHTNING_ADDRESS_DOMAIN`;
  3. each user registering again;
  4. keeping the old CNAME until old addresses are no longer used.

## Draft email to the vendor

> **To:** contact@breez.technology
> **Subject:** Lightning address domain registration: ln.pay-cashapp.buzz
>
> Hello,
>
> We would like to use your hosted LNURL server for Lightning addresses on
> **ln.pay-cashapp.buzz**, with the Breez SDK Spark (0.26.0, WASM) in our
> non-custodial CPAY Wallet.
>
> - Domain: ln.pay-cashapp.buzz (CNAME to breez.tips, DNS only, as in your
>   custom-domain guide)
> - API key to associate: the CPAY Wallet key (we will send it, or confirm
>   the key id, over the channel you prefer)
>
> Could you verify the domain and add it to your allowed domains? We would
> also like to confirm three things:
>
> 1. Do the `/lnurlpay/*` endpoints send CORS headers for browser wallets on
>    another origin? Our wallet runs at https://wallet.pay-cashapp.buzz.
> 2. Can usernames be restricted for our domain (for example, reserving
>    `support`, `admin`, `billing`, `security`, `cpay`)?
> 3. Is the LNURL-pay callback (and the LUD-21 verify URL) served on
>    ln.pay-cashapp.buzz itself, or on another host?
>
> Thank you,
> CPAY
