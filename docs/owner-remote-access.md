# Permanent HTTPS access for BillMitra Owner

The owner phone app needs a stable HTTPS origin. The cashier/POS listener stays on the restaurant PC. A separate loopback listener serves only `/api/owner/*` and `/api/health` to the public tunnel; it does not publish cashier, waiter, setup, or static POS routes.

## What the owner must arrange

1. Register a domain and keep its renewal active. A domain bought through [Cloudflare Registrar](https://developers.cloudflare.com/registrar/get-started/register-domain/) is one option. A domain from another registrar can also be [added to Cloudflare DNS](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/).
2. Create a Cloudflare account and add the domain. Choose a subdomain such as `owner.yourdomain.com`.
3. In Cloudflare **Networking → Tunnels**, create a permanent tunnel. Add a **Published application** route: hostname `owner.yourdomain.com`, service URL `http://127.0.0.1:3018`. Keep the HTTP Host Header at its default, or set it to `owner.yourdomain.com` if a proxy changes it. See [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/) and [origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/).
4. Install `cloudflared` on the restaurant PC and run it as a Windows service using Cloudflare's installation flow. Keep its tunnel token private. Never put the token, MySQL password, or owner password in this repository or chat.

## Restaurant server configuration

Build the repository with `npm run build`. Keep the existing MySQL config in the Git-ignored `.env.mysql.local` file. Set these environment variables for the BillMitra server process:

```text
BILLMITRA_WEB_HOST=127.0.0.1
BILLMITRA_WEB_PORT=3017
BILLMITRA_OWNER_PUBLIC_ORIGIN=https://owner.yourdomain.com
BILLMITRA_OWNER_PORT=3018
```

Set `BILLMITRA_WEB_DATA_DIR`, `BILLMITRA_WEB_ORIGIN`, and `BILLMITRA_SETUP_TOKEN` using the restaurant's existing deployment configuration. Start `node electron-dist/electron/web.cjs`. The public owner listener binds to `127.0.0.1` only; do not open ports 3017, 3018, or MySQL 3306 in the Windows firewall for internet access. Cloudflare Tunnel connects outbound from the PC.

Use a unique owner password suitable for internet sign-in. A short POS PIN such as `1111` is not suitable for the public owner account. Keep Windows, MySQL, BillMitra, and `cloudflared` running; arrange automatic startup and database backups before relying on the owner app daily.

## Check before using the phone

From the restaurant PC, substitute the real hostname:

```powershell
curl.exe -i -H "Host: owner.yourdomain.com" http://127.0.0.1:3018/api/health
curl.exe -i -H "Host: owner.yourdomain.com" http://127.0.0.1:3018/api/branches
```

The first should return HTTP 200 and the second HTTP 404. From a different network, check `https://owner.yourdomain.com/api/health`. Then enter `https://owner.yourdomain.com` in the BillMitra Owner app and sign in with the owner account. Do not use the local `127.0.0.1` address on the phone.

Cloudflare's [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) is temporary and its address changes when restarted, so it is not the permanent route for daily use.
