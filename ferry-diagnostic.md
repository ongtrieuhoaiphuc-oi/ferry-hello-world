# Ferry failure diagnostics
```text

[1;36m[ferry-action][0m Resolving Cloudflare account

[1;36m[ferry-action][0m Finding or creating tunnel ferry-hello-world

[1;36m[ferry-action][0m Reusing tunnel a56d8cad-3a66-44e5-b039-461d7363efc0

[1;36m[ferry-action][0m Fetching tunnel run token

[1;36m[ferry-action][0m Resolving DNS zone for hello.dockflarestacktemplate.dpdns.org

[1;36m[ferry-action][0m Creating or updating proxied DNS record

[1;36m[ferry-action][0m Cloning Ferry
Cloning into '/home/runner/work/_temp/ferry-runtime'...

[1;36m[ferry-action][0m Starting the ephemeral Ferry stack
 Container dokku  Creating
 Container dokku  Created
 Container cloudflared  Creating
 Container cloudflared  Created
 Container dokku  Starting
 Container dokku  Started
 Container cloudflared  Starting
 Container cloudflared  Started

[1;36m[ferry-action][0m Waiting for Dokku
SHA256:aHMq2foXBcxdZipTIg1ftSHmgz6EQ0+dVtChEEyAbmA
=====> Setting attach-post-deploy to webserver

[1;36m[ferry-action][0m Initializing Cloudflare ingress before Ferry preflight

[1;36m[ferry-action][0m Deploying the checked-out app through Ferry
  ferry v0.11.0
  2026-07-11 11:58 +0000

  Deploy Application ─────────────────────

  ✗ Hostname 'hello.dockflarestacktemplate.dpdns.org' already has an ingress rule.
```
