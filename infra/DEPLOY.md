# Deploying Suuper

Target: a small shared server (1 vCPU / 4 GB + 4 GB swap) that also runs another site.
The rules that keep it light:

- **Images are built by GitHub Actions** and pushed to GHCR; the server only pulls them.
- **Every container has a memory and CPU cap** (`infra/docker-compose.prod.yml`), about 3.6 GB at most in total (normally ~0.5 GB, ~2 GB while a local model is loaded).
- **Only nginx is public.** api-gateway and web listen on `127.0.0.1`; everything else is on
  the internal Docker network.
- **Ollama runs `nomic-embed-text` (embeddings) and `llama3.2:1b` (chat).** Pick
  "Llama 3.2 1B (local)" for bots/agents unless there's an Anthropic key; `llama3.2:3b` is too
  big and slow for this server.

URL: `https://app.suuper.cc` (web), `https://app.suuper.cc/api` (api-gateway).
DNS (Hostinger): `A  app  187.77.118.163`.

## One-time setup

**GitHub**
1. Push both repos. The pushes start the "Docker image" workflow (Actions tab).
2. In the web repo: Settings → Secrets and variables → Actions → Variables, add
   `NEXT_PUBLIC_API_URL` = `https://app.suuper.cc/api`, then re-run the workflow.
3. In this repo: Settings → Deploy keys → add the server's `/root/.ssh/github_suuper.pub` (read-only).
4. Create a classic personal access token with only `read:packages`, so the server can pull images.

**Server**
```sh
cd /opt/suuper
git clone git@github.com:<owner>/ai-automation-platform.git
cd ai-automation-platform
echo <token> | docker login ghcr.io -u <github-username> --password-stdin

cp infra/production.env.example .env && chmod 600 .env
# fill in: image names, POSTGRES_PASSWORD / JWT_SECRET / INTEGRATIONS_ENCRYPTION_KEY
# (openssl rand -hex 32), ANTHROPIC_API_KEY, SMTP

./infra/deploy.sh
docker compose -f infra/docker-compose.prod.yml --env-file .env exec ollama ollama pull nomic-embed-text
docker compose -f infra/docker-compose.prod.yml --env-file .env exec ollama ollama pull llama3.2:1b

# Certificate (needs the DNS record and a port-80 server block for app.suuper.cc serving
# /.well-known/acme-challenge/ from /var/www/letsencrypt):
certbot certonly --webroot -w /var/www/letsencrypt -d app.suuper.cc --cert-name app.suuper.cc \
  --deploy-hook 'systemctl reload nginx'

# "zz-" so it loads after the other site: its IP-only HTTPS block must stay the default for :443
ln -s /opt/suuper/ai-automation-platform/infra/nginx/suuper.conf /etc/nginx/sites-enabled/zz-suuper
nginx -t && systemctl reload nginx
```

## Updating

Push to `master` / `main`, wait for the workflow to go green, then on the server:
```sh
cd /opt/suuper/ai-automation-platform && ./infra/deploy.sh
```

## Checking resource use

```sh
docker stats --no-stream
docker compose -f infra/docker-compose.prod.yml --env-file .env logs -f api-gateway
```
If a service is OOM-killed (`docker inspect <c> --format '{{.State.OOMKilled}}'`), raise its
`mem_limit` a little rather than removing it.
