#!/bin/bash
# Host setup + (re)start on Ubuntu 22.04. Run as root from an unpacked tree at /opt/myartifacts. Idempotent.
set -euo pipefail
NODE=v26.3.0
cd /opt/myartifacts

# Node: official tarball, no distro packaging games.
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "^$NODE"; then
	curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
fi
/usr/local/bin/npm ci --omit=dev --no-audit --no-fund

# Caddy with the Aliyun DNS plugin (ADR-0007: wildcard needs DNS-01).
if ! caddy list-modules 2>/dev/null | grep -q dns.providers.alidns; then
	curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/alidns" -o /usr/bin/caddy.new
	chmod 755 /usr/bin/caddy.new && mv /usr/bin/caddy.new /usr/bin/caddy
fi
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy/conf.d
[ -f /etc/systemd/system/caddy.service ] || cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network.target

[Service]
User=caddy
EnvironmentFile=/etc/myartifacts.env
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always

[Install]
WantedBy=multi-user.target
UNIT

id myartifacts >/dev/null 2>&1 || useradd --system --home /var/lib/myartifacts --create-home --shell /usr/sbin/nologin myartifacts
mkdir -p /var/lib/myartifacts
chown -R myartifacts:myartifacts /var/lib/myartifacts
[ -f /etc/myartifacts.env ] || { cp deploy/myartifacts.env /etc/myartifacts.env; chmod 640 /etc/myartifacts.env; chown root:caddy /etc/myartifacts.env; }
cp deploy/Caddyfile /etc/caddy/Caddyfile
# The wildcard vhost only once the DNS key exists; an empty key would keep Caddy from starting at all.
if grep -qE '^ALICLOUD_ACCESS_KEY_ID=.+' /etc/myartifacts.env; then cp deploy/usercontent.caddy /etc/caddy/conf.d/; else rm -f /etc/caddy/conf.d/usercontent.caddy; fi
cp deploy/myartifacts.service /etc/systemd/system/myartifacts.service
systemctl daemon-reload
systemctl enable caddy myartifacts >/dev/null 2>&1
systemctl restart myartifacts
systemctl reload caddy 2>/dev/null || systemctl restart caddy
sleep 2
systemctl --no-pager --lines=5 status myartifacts caddy | grep -E 'Active|●|node|caddy\['
