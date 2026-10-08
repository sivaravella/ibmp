# Deployment: ibmp.apbiz.in (8 October 2026)

IBMP runs on the shared server `168.144.90.151` (Ubuntu 22.04, 1 CPU, 1.9 GB RAM, 2 GB swap added), next to the parcelbox project, which was left running untouched. DNS: an A record for `ibmp.apbiz.in` at GoDaddy.

## Layout

| Path / name | What |
|---|---|
| `/opt/ibmp/docker-compose.yml`, `/opt/ibmp/.env` (mode 600) | The IBMP stack and its secrets (database password, JWT secret, encryption key, admin key, SMTP, social sign-in). Never commit or copy `.env` anywhere. |
| containers `ibmp-ibmp-app-1` (limit 600 MB), `ibmp-ibmp-db-1` (PostgreSQL 17, limit 300 MB) | Own network and database volume `ibmp_ibmp-db`; nothing is published on the host. The app also joins `parcellbox_default` (alias `ibmp-app`) so parcelbox's nginx can reach it. |
| `/opt/parcellbox/nginx/nginx.conf` | Parcelbox's nginx (it owns ports 80 and 443). Two `server` blocks for `ibmp.apbiz.in` were appended at the end: port 80 (certificate challenge and redirect) and port 443 (proxy to `ibmp-app:4000`, looked up per request so nginx starts even if IBMP is down). Backups of the file before each change: `nginx.conf.bak-ibmp-*` in the same folder. |
| `/opt/parcellbox/certbot/conf/live/ibmp.apbiz.in/` | The Let's Encrypt certificate (expires 2027-01-06). `/opt/ibmp/renew-cert.sh` (covering this certificate and the one for apbiz.in) runs weekly from `/etc/cron.d/ibmp-cert-renew` and reloads nginx only if it renewed. It does not touch parcelbox's certificate (`parcellbox.in`, expires 2026-12-02, no automatic renewal found). |
| `/opt/ibmp/backup.sh`, `/etc/cron.d/ibmp-backup` | Nightly 02:30 UTC dump to `/opt/ibmp/backups/ibmp-*.sql.gz`, 14 days kept; log in `/var/log/ibmp-backup.log`. Restore was tested into a scratch database (same 51 tables, 27 migrations). |

## The Apbiz website (apbiz.in, deployed 8 October 2026; redesigned with 13 services and a Login link to ibmp.apbiz.in the same day)

A static page (the `sites/apbiz/` folder of this repository) served by a tiny nginx container, `apbiz-site-site-1`, defined in `/opt/apbiz-site/docker-compose.yml` with the files in `/opt/apbiz-site/html`. Like IBMP it joins `parcellbox_default` (alias `apbiz-site`) and is reached only through parcelbox's nginx, which has three more `server` blocks (port 80 for `apbiz.in` and `www.apbiz.in`, port 443 for `www` (redirect to the bare domain) and for `apbiz.in`). Its certificate (`apbiz.in` plus `www.apbiz.in`, expires 2027-01-06) is renewed by the same weekly job. DNS: A records for `@` and `www` at GoDaddy point to 168.144.90.151.

To publish a change: edit `sites/apbiz/content.mjs` (or the styles), run `node sites/apbiz/build.mjs` and `node sites/apbiz/check.mjs`, then `tar -cf site.tar -C sites/apbiz/site .`, copy it to the server, keep the old files (`cp -a /opt/apbiz-site/html /opt/apbiz-site/html.bak-DATE`), empty `/opt/apbiz-site/html` and unpack the archive into it. No restart is needed. The container's own nginx config is `/opt/apbiz-site/default.conf` (source: `sites/apbiz/nginx-site.conf`); after changing it run `docker compose up -d` there. **Create that file before the first start**: if a mounted file does not exist, Docker creates a folder with that name and the container will not start (this caused a two-minute outage on 8 October 2026).

**Certbot hook note:** parcelbox keeps a deploy hook (`certbot/conf/renewal-hooks/deploy/parcellbox-sync.sh`: rsync, then restart its nginx) in the shared certbot folder. It cannot run inside a throwaway certbot container and reports an error there (harmless: nothing restarts). `/opt/ibmp/renew-cert.sh` passes `--no-directory-hooks` and does a graceful nginx reload itself. Parcelbox's own renewals on the host still run that hook as before.

Current production version: 1.22.0 (apbiz brand kit, deployed 8 October 2026).

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

- **Email (Brevo):** working. `168.144.90.151` is authorised under Brevo → Security → Authorised IPs and a test message was accepted on 8 October 2026. Sender: `IBMP Support <sivaravella@o2labs.com>`.
- **Platform owner console** (`/platform`): create the owner on the server: `docker exec ibmp-ibmp-app-1 node scripts/create-platform-admin.js --email <email> --name "<name>"` (prints a generated password once). Do not seed the demo accounts here.
- **Google and LinkedIn sign-in:** configured in `/opt/ibmp/.env` (both buttons show). A full login with each provider is still to be confirmed by the owner. Redirect URIs: `https://ibmp.apbiz.in/v1/auth/social/google/callback` and `https://ibmp.apbiz.in/v1/auth/social/linkedin/callback`. See `docs/SOCIAL_LOGIN.md`.
- **Not configured:** online payments (Razorpay), the GST portal connection (GSP), SMS and WhatsApp reminders. Simulators are off, so those features report "not set up".

## Server notes

- The firewall rule on port 22 is `LIMIT`: more than a handful of new SSH connections in 30 seconds are blocked for a while. Batch commands in one session.
- UFW also allows ports 2375 and 2376 (Docker's remote API) from anywhere. Nothing listens on them now; the rules should be removed.
