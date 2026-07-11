# Ferry Hello World

A dependency-free Node.js Hello World app packaged for [Ferry](https://github.com/gastonmorixe/ferry).

## Run locally

```bash
npm start
```

Open <http://localhost:3000>. The app also exposes `GET /api/hello` and `GET /health`.

## Try Ferry entirely in GitHub Actions

Create one repository secret named `FERRY_ENV`. Its value is a raw `.env` file:

```dotenv
CF_EMAIL=you@example.com
CF_GLOBAL_APIKEY=your-cloudflare-global-api-key
DOKKU_HOSTNAME=example.com
# Optional override. Default: ferry-hello-world.example.com
# APP_HOSTNAME=hello.example.com
# Optional when the key can access multiple Cloudflare accounts
# CF_ACCOUNT_ID=your-account-id
```

Then open **Actions → Ferry Cloudflare Demo → Run workflow**. The workflow automatically:

1. Resolves the Cloudflare account and DNS zone.
2. Creates a tunnel named `ferry-hello-world`, or reuses it when it already exists.
3. Creates or updates the proxied CNAME record.
4. Starts Ferry, Dokku, and cloudflared on the GitHub runner.
5. Deploys this repository through Ferry and verifies `/health` publicly.

The URL is printed in the workflow summary. No Cloudflare credential, tunnel token, or generated key is committed. Public defaults live in the tracked `.env`; secrets are written only to the runner's temporary filesystem.

> GitHub-hosted runners are temporary. The demo URL stays online only while the workflow is running, up to 350 minutes by default. Re-running the workflow reuses the existing tunnel and DNS record but starts a fresh Dokku host.

## Docker

```bash
docker build -t ferry-hello-world .
docker run --rm -p 3000:3000 ferry-hello-world
```
