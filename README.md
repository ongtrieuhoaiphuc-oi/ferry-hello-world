# Ferry multi-app demo

Two Node.js apps deployed by Ferry, Dokku, and a remotely managed Cloudflare Tunnel from one GitHub-hosted runner.

- `hello`: the root application at `HELLO1_HOST_PREFIX.DOKKU_HOSTNAME`
- `hello2`: an editorial landing page at `HELLO2_HOST_PREFIX.DOKKU_HOSTNAME`

## Required secret

Create one GitHub Actions secret named `FERRY_ENV` containing a raw `.env` file:

```dotenv
CF_EMAIL=you@example.com
CF_GLOBAL_APIKEY=your-global-api-key
DOKKU_HOSTNAME=example.com
# Optional when the key can access multiple accounts
# CF_ACCOUNT_ID=account-id
# Optional full hostname overrides
# HELLO1_HOSTNAME=hello.example.com
# HELLO2_HOSTNAME=hello2.example.com
```

Run **Ferry Cloudflare Demo** from Actions, or push to `main`. The workflow creates or reuses the tunnel, reconciles both DNS records, deploys both apps, verifies their public `/health` endpoints, and keeps the ephemeral runner alive for up to 350 minutes.

Secrets are only written to the runner's temporary filesystem. Public defaults are in `.env`.
