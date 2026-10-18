# CPAY Wallet: Lightning addresses

A CPAY Wallet user can pick a Lightning address, `name@pay-cashapp.buzz`,
that anyone can pay at any time. The money goes straight to the keys on the
user's phone. CPAY never holds it.

## How it works

- The wallet library (Breez SDK Spark 0.26.0) registers the name with the
  vendor's LNURL server for the domain. Each check and registration is
  signed with the wallet's own identity key.
- A payer's wallet looks up `https://pay-cashapp.buzz/.well-known/lnurlp/<name>`.
  The LNURL server answers with an invoice for the user's wallet.
- One address per wallet per domain. Registering a new name replaces the
  old one. A removed name stays reserved for that wallet, so nobody else
  can take it.
- The wallet only offers plain names: lowercase letters and digits, with
  single `.`, `-` or `_` between them, at most 32 characters
  (`wallet/src/lnaddress.js`).

## Configuration

| Setting | Where | Value |
|---|---|---|
| `LIGHTNING_ADDRESS_DOMAIN` | build variable of the `cpay-wallet` Workers project | `pay-cashapp.buzz` (for now; see "Changing the domain") |

Unset means no Lightning address option. The library's own default domain
is never used. The wallet's CSP allows exactly `https://<domain>` for the
registration calls.

## Owner steps before it works

1. **Dedicated API key ([release gate G1](../docs/WALLET-RELEASE-GATES.md)).** The domain is registered with
   the vendor for the wallet's own key.
2. **Register the domain with the vendor.** `pay-cashapp.buzz` also serves
   the CPAY website, so it needs the vendor's **reverse proxy** option. A
   CNAME on the root would send the whole website to the vendor (a CNAME on a
   subdomain is fine: see the simpler option below). Email
   `contact@breez.technology` (draft below). The vendor replies with a
   shared secret.
3. **Forward three paths on `pay-cashapp.buzz` to `https://breez.tips`.**
   This is a separate, reviewed website PR, made once the secret exists:
   - `/.well-known/lnurlp/*`
   - `/lnurlp/*`
   - `/lnurlpay/*`

   Forward any method, unchanged, without caching. On every forwarded
   request, set three headers:
   - `Host: pay-cashapp.buzz`
   - `X-Breez-Reverse-Proxy-Shared-Secret`: the vendor's secret, stored as
     a Worker secret and never in the repository
   - `X-Forwarded-For`: the client IP (Cloudflare's `CF-Connecting-IP`),
     replacing any value the request arrived with

   The forwarder will also refuse names that could pass for CPAY itself
   (`support`, `admin`, `cpay`, `billing`, `security` and similar), both
   on registration and on lookup.
   **Open question:** a Cloudflare Worker cannot set a `Host` header that
   differs from the target's host, which this option asks for. The email
   asks the vendor for an alternative header. If there is none, use the
   simpler option below.

   **Simpler option, no website code: a CNAME subdomain.** Add a DNS record
   `ln.pay-cashapp.buzz` → CNAME `breez.tips`, set to **DNS only** (not
   proxied), and register `ln.pay-cashapp.buzz` with the vendor. Addresses
   become `name@ln.pay-cashapp.buzz`. The vendor serves that subdomain
   entirely, so it needs no shared secret and no forwarder. The website
   cannot filter names there; ask the vendor about restrictions. Build with
   `LIGHTNING_ADDRESS_DOMAIN=ln.pay-cashapp.buzz` and include that host in
   `DIRECT_PROVIDER_HOSTS` if it is set.
4. **Build the wallet with `LIGHTNING_ADDRESS_DOMAIN=pay-cashapp.buzz`**
   (or `ln.pay-cashapp.buzz` with the CNAME option).
   Test on staging first (regtest). Note: the vendor's server is mainnet,
   so a real address can only be tested on the production build with a
   small amount (gate G7).

## Using it for CPAY direct payments

After registering, the wallet shows **Use for CPAY direct payments**. It
opens `https://pay-cashapp.buzz/dashboard.html#direct=<address>` with the
address filled in on the desk. The member still taps Check and Save there:
CPAY checks the address with its provider, asks for a fresh sign-in and
uses it 24 hours later. The wallet never writes to CPAY. With the optional
CPAY link, it reads where direct payments go (`get_my_direct_settlement`)
and says so. If the owner sets `DIRECT_PROVIDER_HOSTS`, it must include
`pay-cashapp.buzz`.

## Risks the owner accepts

- **Same domain as the website.** `name@pay-cashapp.buzz` reads as CPAY.
  Anyone with the wallet can pick a name. The reserved-name list in the
  forwarder limits obvious impersonation, but not every lookalike.
- **The vendor's server makes the invoices.** If it is down, the address
  cannot be paid; direct invoices from the wallet still work. The server
  sees each payment's amount and the payer's comment. It does not hold
  the money.
- **Changing the domain** leaves every registered address on the old
  domain. People who saved `name@pay-cashapp.buzz` keep paying the old
  domain for as long as the forwarder serves it. Moving means:
  1. registering the new domain with the vendor;
  2. rebuilding with the new `LIGHTNING_ADDRESS_DOMAIN`;
  3. each user registering again on the new domain;
  4. keeping the old forwarder running until the old addresses are no
     longer used.

## Draft email to the vendor

> **To:** contact@breez.technology
> **Subject:** Lightning address domain registration (reverse proxy): pay-cashapp.buzz
>
> Hello,
>
> We would like to use your hosted LNURL server for Lightning addresses on
> our domain **pay-cashapp.buzz** with the Breez SDK Spark (0.26.0, WASM, in
> our non-custodial CPAY Wallet).
>
> The domain also serves our website, so we will use the **reverse proxy**
> option: our web server will forward `/.well-known/lnurlp/*`, `/lnurlp/*`
> and `/lnurlpay/*` to `https://breez.tips` with the `Host`,
> `X-Breez-Reverse-Proxy-Shared-Secret` and `X-Forwarded-For` headers, as
> described in your custom-domain guide.
>
> - Domain: pay-cashapp.buzz
> - API key to associate: the CPAY Wallet key (we will send it, or confirm
>   the key id, over the channel you prefer)
>
> Could you add the domain and send us the shared secret? We would also
> like to confirm three things:
>
> 1. Our forwarder is a Cloudflare Worker, which cannot set a `Host` header
>    different from the target URL's host. Does your server also accept
>    the domain in another header (for example `X-Forwarded-Host`), or
>    should we use a CNAME subdomain instead (for example
>    `ln.pay-cashapp.buzz` → `breez.tips`)?
> 2. Do the `/lnurlpay/*` endpoints send CORS headers for browser wallets on
>    another origin? Our wallet runs at https://wallet.pay-cashapp.buzz.
> 3. Can usernames be restricted server-side for the domain?
>
> Thank you,
> CPAY
