# Deployment: ibmp.apbiz.in (8 October 2026)

IBMP runs on the shared server `168.144.90.151` (Ubuntu 22.04, 1 CPU, 1.9 GB RAM, 2 GB swap added), next to the parcelbox project, which was left running untouched. DNS: an A record for `ibmp.apbiz.in` at GoDaddy.

## Layout

| Path / name | What |
|---|---|
| `/opt/ibmp/docker-compose.yml`, `/opt/ibmp/.env` (mode 600) | The IBMP stack and its secrets (database password, JWT secret, encryption key, admin key, SMTP, social sign-in). Never commit or copy `.env` anywhere. |
| containers `ibmp-ibmp-app-1` (limit 600 MB), `ibmp-ibmp-db-1` (PostgreSQL 17, limit 300 MB) | Own network and database volume `ibmp_ibmp-db`; nothing is published on the host. The app also joins `parcellbox_default` (alias `ibmp-app`) so parcelbox's nginx can reach it. |
| `/opt/parcellbox/nginx/nginx.conf` | Parcelbox's nginx (it owns ports 80 and 443). Two `server` blocks for `ibmp.apbiz.in` were appended at the end: port 80 (certificate challenge and redirect) and port 443 (proxy to `ibmp-app:4000`, looked up per request so nginx starts even if IBMP is down). Backups of the file before each change: `nginx.conf.bak-ibmp-*` in the same folder. |
| `/opt/parcellbox/certbot/conf/live/ibmp.apbiz.in/` | The Let's Encrypt certificate (expires 2027-01-06). `/opt/ibmp/renew-cert.sh` runs weekly from `/etc/cron.d/ibmp-cert-renew` and reloads nginx only if it renewed. It does not touch parcelbox's certificate (`parcellbox.in`, expires 2026-12-02, no automatic renewal found). |
| `/opt/ibmp/backup.sh`, `/etc/cron.d/ibmp-backup` | Nightly 02:30 UTC dump to `/opt/ibmp/backups/ibmp-*.sql.gz`, 14 days kept; log in `/var/log/ibmp-backup.log`. Restore was tested into a scratch database (same 51 tables, 27 migrations). |

## Updating to a new version

The server is too small to build the image, so build it on a workstation and send it:

```bash
git archive HEAD | tar -x -C /tmp/build && cd /tmp/build
docker build -t ibmp/app:X.Y.Z .
docker save ibmp/app:X.Y.Z | gzip -1 > ibmp-app.tar.gz
scp ibmp-app.tar.gz root@168.144.90.151:/opt/ibmp/incoming/
# on the server (one SSH session; the firewall rate-limits rapid new connections):
cd /opt/ibmp && /opt/ibmp/backup.sh
gunzip -c incoming/ibmp-app.tar.gz | nice -n 19 docker load
sed -i 's/^IBMP_VERSION=.*/IBMP_VERSION=X.Y.Z/' .env && docker compose up -d      # migrations run on start
curl -s https://ibmp.apbiz.in/v1/health                                        # shows the version
```

Roll back by setting `IBMP_VERSION` to the previous tag (kept in Docker until pruned) and running `docker compose up -d`; restore a dump only if a migration damaged data.

## Restoring a backup

```bash
cd /opt/ibmp && docker compose stop ibmp-app
docker exec ibmp-ibmp-db-1 dropdb -U ibmp ibmp && docker exec ibmp-ibmp-db-1 createdb -U ibmp ibmp
gunzip -c backups/<file>.sql.gz | docker exec -i ibmp-ibmp-db-1 psql -U ibmp -d ibmp -v ON_ERROR_STOP=1
docker compose up -d
```

## Settings still to complete

- **Email (Brevo):** SMTP login is accepted but Brevo answers `525 5.7.1 Unauthorized IP address` until `168.144.90.151` is added under Brevo → Security → Authorised IPs. Sender: `IBMP Support <sivaravella@o2labs.com>`.
- **Platform owner console** (`/platform`): create the owner on the server: `docker exec ibmp-ibmp-app-1 node scripts/create-platform-admin.js --email <email> --name "<name>"` (prints a generated password once). Do not seed the demo accounts here.
- **Google and LinkedIn sign-in:** fill the four `IBMP_GOOGLE_*` / `IBMP_LINKEDIN_*` values in `/opt/ibmp/.env`, then `docker compose up -d`. Redirect URIs to register: `https://ibmp.apbiz.in/v1/auth/social/google/callback` and `https://ibmp.apbiz.in/v1/auth/social/linkedin/callback`. See `docs/SOCIAL_LOGIN.md`.
- **Not configured:** online payments (Razorpay), the GST portal connection (GSP), SMS and WhatsApp reminders. Simulators are off, so those features report "not set up".

## Server notes

- The firewall rule on port 22 is `LIMIT`: more than a handful of new SSH connections in 30 seconds are blocked for a while. Batch commands in one session.
- UFW also allows ports 2375 and 2376 (Docker's remote API) from anywhere. Nothing listens on them now; the rules should be removed.
