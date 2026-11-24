# Hosting the app server on Cloudflare

The app server (`h5p-mcp-app`) runs as a Cloudflare Worker from `apps/mcp-worker`, at
`https://mcp.embed-my.org/mcp`. Deploying needs a sign-in to the Cloudflare account that holds the
`embed-my.org` zone. Nothing deploys on its own.

## Once per computer

```sh
git checkout main && git pull
pnpm install
cd apps/mcp-worker
pnpm exec wrangler login --use-keyring
```

The sign-in opens the browser. `--use-keyring` keeps its token in the macOS Keychain; without it,
the token is a plain-text file in `~/.config/.wrangler/`. Never share the token.
`pnpm exec wrangler whoami` shows the account, and `pnpm exec wrangler logout` removes the token.

## Deploy

From `apps/mcp-worker`:

```sh
pnpm deploy:worker
```

It gathers the library pack, the type files and the card into `staged/`, then uploads the Worker
`h5p-mcp`, about 17 MB. On the first deploy Cloudflare creates the DNS record and the certificate
for `mcp.embed-my.org` itself. It ends with `Worker Startup Time`, `Deployed h5p-mcp triggers` and
`Current Version ID`. If the login sees several accounts, pick the one with the zone.

Deploy again after a merged change to the MCP or author package, the skill's type files, the
library pack or this app.

## Check

```sh
curl https://mcp.embed-my.org/
```

One line of text answers. A new certificate can take a few minutes. In ChatGPT, the app's address
is `https://mcp.embed-my.org/mcp`.

## Watch

Dashboard → Workers & Pages → h5p-mcp → Metrics: requests, errors and CPU time per call, kept for
three months. "Exceeded CPU Time Limits" under Errors → Invocation Statuses means a call needed more
than the free plan's 10 ms and its caller got error 1102. If it shows often, move to Workers Paid
($5 a month) and set a cap under Billing → Spend Management.

`pnpm exec wrangler tail` shows calls as they come, for debugging, and stores nothing. The Worker's
stored logs (Workers Logs) are off in `wrangler.jsonc`.

## The free plan's limits

100,000 calls a day for the whole account, until midnight UTC, and 10 ms of CPU a call. Over the
daily limit the address answers no call until the reset. Nothing on another host is affected: the
demo and the organisation's site stay up.

## Undo

- `pnpm exec wrangler rollback` goes back to the previous version at once (dashboard: the Worker's
  Deployments).
- `pnpm exec wrangler delete --dry-run`, then without `--dry-run`, removes the Worker. Then remove
  its certificate under SSL/TLS → Edge Certificates, and check DNS for a leftover `mcp` record.
