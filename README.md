# Ferry multi-app demo

GitHub Actions runs Ferry, Dokku, and Cloudflare Tunnel on one ephemeral runner.

Apps:

- `hello`: Node.js Hello World
- `hello2`: editorial landing page
- `omiroute`: OmniRoute launched through `npx omniroute`, port `20128`

## Required secret

Create `FERRY_ENV` as a raw `.env` value:

```dotenv
CF_EMAIL=you@example.com
CF_GLOBAL_APIKEY=your-global-api-key
DOKKU_HOSTNAME=example.com
INITIAL_PASSWORD=use-a-long-random-password
# Optional: CF_ACCOUNT_ID=account-id
```

Push to `main` or run **Ferry Cloudflare Demo** manually. Public defaults live in `.env`; all automation scripts are `.mjs`.
