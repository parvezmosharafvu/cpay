# Deploying the payment service

`payment-service/` is one long-running Node 22 process. It holds the cpay
platform wallet, so it needs four things from any host:

1. **Exactly one instance.** Two processes on the same wallet would race
   each other. No autoscaling, no blue-green, no second region.
2. **A persistent disk** for `BREEZ_DATA_DIR` (the wallet cache). The wallet
   words alone restore the wallet if the disk is lost, but a cold start
   resyncs from scratch.
3. **A stop timeout longer than `SHUTDOWN_TIMEOUT_SECS`** (default 90). On
   SIGTERM the service stops taking requests and waits for sends in flight;
   the host must not kill it before that. Use the timeout plus 10 seconds.
4. **The wallet words as a file** readable only by the service user, named
   by `BREEZ_MNEMONIC_FILE`. `BREEZ_MNEMONIC` (inline) works too, but an
   environment variable is easier to leak through a dashboard or a crash dump.

Every variable is described in [`ENV_VARS.md`](ENV_VARS.md#payment-service).
The service answers `GET /health` without a secret (200 healthy, 503 not),
which is what the host's health check should call.

Nothing here has been deployed. Pick one of the three options below.

## Option A: Fly.io

Fly builds the `Dockerfile` in `payment-service/`, keeps a volume per
machine, and can write a secret to a file.

`payment-service/fly.toml` (create it; the app name is yours to choose):

```toml
app = "cpay-payments"
primary_region = "sin"            # Singapore, closest to Dhaka

kill_signal = "SIGTERM"
kill_timeout = 100                # SHUTDOWN_TIMEOUT_SECS (90) + 10; Fly allows up to 300

[env]
  BREEZ_NETWORK = "mainnet"
  BREEZ_DATA_DIR = "/data"
  BREEZ_MNEMONIC_FILE = "/run/cpay/mnemonic"
  SHUTDOWN_TIMEOUT_SECS = "90"

[[files]]
  guest_path = "/run/cpay/mnemonic"
  secret_name = "BREEZ_MNEMONIC_B64"

[mounts]
  source = "cpay_wallet"
  destination = "/data"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"      # must stay up to receive payment events
  auto_start_machines = false
  min_machines_running = 1

[[http_service.checks]]
  grace_period = "60s"            # first sync can take a while
  interval = "30s"
  timeout = "5s"
  method = "GET"
  path = "/health"

[deploy]
  strategy = "rolling"            # stops the old machine, then starts the new one on the same volume
```

Then, from `payment-service/`:

```sh
fly apps create cpay-payments
fly volumes create cpay_wallet --region sin --size 1
# Type the words into a file on your own machine, never into a chat:
fly secrets set BREEZ_MNEMONIC_B64="$(base64 -w0 < /path/to/mnemonic.txt)"
fly secrets set PAYMENT_SERVICE_SECRET="$(openssl rand -hex 32)" \
                DATABASE_URL="postgres://..." BREEZ_API_KEY="..."
fly deploy
fly scale count 1
```

The volume is mounted owned by root. The image runs as the `node` user, so
if the service logs a permission error on `/data`, run once:
`fly ssh console -C "chown -R 1000:1000 /data"` (as root).

`PAYMENT_SERVICE_URL` is then `https://cpay-payments.fly.dev`.

## Option B: Railway

Railway builds the same `Dockerfile` (set the service root to
`payment-service/`).

- **Volume:** add one mounted at `/data`. Railway mounts volumes as root; if
  the service cannot write there, set the service variable
  `RAILWAY_RUN_UID=0`. That runs the process as root inside the container,
  which is the trade Railway forces.
- **Stop timeout:** set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=100`. The
  default is 0, which kills the process at once on every deploy.
- **One instance:** replicas 1. Railway never runs two deployments on one
  volume, so each deploy has a short gap.
- **Wallet words:** Railway has no secret files, so use `BREEZ_MNEMONIC` as
  a sealed variable. This is the weakest of the three options for the words.
- **Health check:** path `/health`.
- Other variables: `BREEZ_NETWORK=mainnet`, `BREEZ_API_KEY`, `DATABASE_URL`,
  `PAYMENT_SERVICE_SECRET`.

`PAYMENT_SERVICE_URL` is the service's public Railway domain.

## Option C: a VPS with systemd

Any small Linux server (1 vCPU, 1 GB RAM is enough) with Node 22.

```sh
sudo useradd --system --home /var/lib/cpay --shell /usr/sbin/nologin cpay
sudo mkdir -p /opt/cpay /var/lib/cpay /etc/cpay
sudo cp -r payment-service/* /opt/cpay/ && cd /opt/cpay && sudo npm ci --omit=dev
sudo chown -R cpay:cpay /var/lib/cpay
# The words: typed into the file directly, root-only.
sudo install -m 600 -o root -g root /dev/null /etc/cpay/mnemonic
sudo nano /etc/cpay/mnemonic
sudo install -m 600 -o root -g root /dev/null /etc/cpay/env
sudo nano /etc/cpay/env   # BREEZ_NETWORK, BREEZ_API_KEY, DATABASE_URL, PAYMENT_SERVICE_SECRET
```

`/etc/systemd/system/cpay-payments.service`:

```ini
[Unit]
Description=cpay payment service
After=network-online.target
Wants=network-online.target

[Service]
User=cpay
WorkingDirectory=/opt/cpay
EnvironmentFile=/etc/cpay/env
Environment=BREEZ_DATA_DIR=/var/lib/cpay
Environment=SHUTDOWN_TIMEOUT_SECS=90
# systemd copies the root-only file to a private path only this unit can read.
LoadCredential=mnemonic:/etc/cpay/mnemonic
Environment=BREEZ_MNEMONIC_FILE=%d/mnemonic
ExecStart=/usr/bin/node server.mjs
KillSignal=SIGTERM
TimeoutStopSec=100
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/cpay
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now cpay-payments
journalctl -u cpay-payments -f
```

Put HTTPS in front (Caddy is the least work:
`pay.example.com { reverse_proxy 127.0.0.1:8080 }`). `PAYMENT_SERVICE_URL`
is then `https://pay.example.com`.

## Connecting Supabase to the service

After the service answers `GET <url>/health` with 200, set the two edge
function secrets. This is a live change; do it only when the service is up.

```sh
supabase secrets set --project-ref riumaeihemgznvgattoc \
  PAYMENT_SERVICE_URL="https://<your service host>" \
  PAYMENT_SERVICE_SECRET="<the same value the service has>"
```

Or in the dashboard: Edge Functions → Secrets. `create-invoice`,
`user-withdraw`, `admin-actions` and `health` read them on their next call;
no redeploy is needed.

Check: open the admin desk wallet tab (it calls the service through
`admin-actions`), then create a small invoice on a test link.

## Updating and stopping

A deploy or `systemctl restart` sends SIGTERM. The service logs
`{"event":"shutdown"}`, finishes sends in flight, then logs
`{"event":"stopped","drained":true,"disconnected":true}` and exits 0. If the
log shows `"drained":false`, the timeout cut a send off; the withdrawal stays
`sending` and the next start checks it against the wallet. It is never sent
twice.
