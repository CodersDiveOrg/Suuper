#!/usr/bin/env bash
# Serves agencies' verified custom domains (white-label). Run on the server as
# root from cron, e.g. every 5 minutes:
#   */5 * * * * /opt/suuper/ai-automation-platform/infra/custom-domains.sh >> /var/log/suuper-domains.log 2>&1
#
# For each Agency.customDomain with domainVerifiedAt set and no nginx config yet:
#   1. writes an HTTP-only block so Let's Encrypt can reach the webroot,
#   2. issues a certificate (certbot webroot),
#   3. writes the full HTTPS block (same routing as suuper.conf) and reloads nginx.
# Domains that are no longer verified get their config removed (the cert is kept).
set -euo pipefail
cd "$(dirname "$0")/.."

CONF_DIR=/etc/nginx/sites-enabled
PREFIX=zz-suuper-domain-
WEBROOT=/var/www/letsencrypt
compose="docker compose -f infra/docker-compose.prod.yml --env-file .env"

domains=$($compose exec -T postgres psql -U suuper -d suuper -tAc \
  "SELECT \"customDomain\" FROM \"Agency\" WHERE \"customDomain\" IS NOT NULL AND \"domainVerifiedAt\" IS NOT NULL")

valid() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; }

http_block() {
  cat <<CONF
server {
    listen 80;
    listen [::]:80;
    server_name $1;
    location ^~ /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://\$host\$request_uri; }
}
CONF
}

https_block() {
  cat <<CONF
server {
    listen 443 ssl;
    http2 on;
    server_name $1;

    ssl_certificate     /etc/letsencrypt/live/$1/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$1/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 10M;

    proxy_http_version 1.1;
    proxy_set_header Host \$http_host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$http_host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Real-IP \$remote_addr;

    location /api/ {
        proxy_pass http://127.0.0.1:3110/;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 60s;
    }
}
CONF
}

changed=0
for domain in $domains; do
  valid "$domain" || { echo "skip invalid domain: $domain"; continue; }
  conf="$CONF_DIR/$PREFIX$domain"
  grep -q "listen 443" "$conf" 2>/dev/null && continue

  echo "$(date -Is) setting up $domain"
  http_block "$domain" > "$conf"
  nginx -t && systemctl reload nginx
  if certbot certonly --webroot -w "$WEBROOT" -d "$domain" --cert-name "$domain" \
       --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring \
       --deploy-hook 'systemctl reload nginx'; then
    { http_block "$domain"; https_block "$domain"; } > "$conf"
    changed=1
  else
    # Usually the CNAME isn't pointing here yet; try again on the next run.
    echo "certbot failed for $domain"
    rm -f "$conf"
    changed=1
  fi
done

# Drop configs for domains that were removed or unverified.
for conf in "$CONF_DIR/$PREFIX"*; do
  [ -e "$conf" ] || continue
  domain=${conf#"$CONF_DIR/$PREFIX"}
  if ! grep -qx "$domain" <<<"$domains"; then
    echo "$(date -Is) removing $domain"
    rm -f "$conf"
    changed=1
  fi
done

if [ "$changed" = 1 ]; then nginx -t && systemctl reload nginx; fi
