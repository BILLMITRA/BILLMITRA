# Online deployment preparation

No hosting account, domain, certificate, or public deployment has been created. The Docker and Caddy files are a deployment starter and have not been executed in this Windows environment, which does not have Docker available.

## Requirements

- A Linux server with Docker Compose, persistent disk, and a domain directed to that server.
- Ports 80 and 443 available for the HTTPS gateway. The billing container's port 3000 is not published to the host.
- An external backup destination and a tested recovery procedure.

## Configuration

Copy `.env.example` to `.env`. Set the actual domain, a random setup token of at least 32 characters, and the branch list. Do not commit `.env`. Keep branch IDs stable after bills have been created: they select separate database files. Each branch has its own owner/staff accounts, menu, stock, bills, cash closings, and backups.

Generate a token locally using:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The setup token protects first-owner creation for every branch. Enter it in the owner-setup screen; existing staff logins use their username and password.

On the server, review configuration with `docker compose config`, then build and start with `docker compose up -d --build`. Caddy terminates HTTPS and forwards the original Host header to the app. Browser requests and cookies use the configured public HTTPS origin. See [Caddy's reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) and [Docker Compose interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation).

The named `billing-data` volume holds the databases and automatic snapshots. Preserve it through upgrades; do not run volume removal commands as part of an update. Snapshot files on the same disk do not protect against losing the server.

## Required validation before launch

Verify HTTPS access and redirects, setup-token rejection, staff sign-in and permission denial, branch isolation, order/payment retries, stock movements, kitchen and waiter flows, printing in target browsers, backup export to separate storage, and a restore rehearsal using copied data. Review monitoring, request-rate controls, account recovery, invoice/tax requirements, and expected peak load before business use.

Desktop/cloud synchronization is not implemented. Hosting this browser application shares branch data among online browsers; it does not replicate existing desktop databases or enable offline browser billing. Do not point the desktop and a cloud instance at a shared SQLite file or copy active database files between them.
