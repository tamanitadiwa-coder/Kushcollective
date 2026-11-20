# Lightspeed connection module

A separate, manager-controlled connection between Kush Collective and Lightspeed Retail (X-Series). The main app (`index.html`) only links to it and reads a public "connected or not" status.

- `worker/`: Cloudflare Worker with a free D1 database. It runs the OAuth flow and holds the tokens.
- `../lightspeed.html`: the manager settings page. It needs a manager passcode that is separate from staff PINs.
- `../kush-config.js`: the Worker address. The deploy workflow fills it in.

## How it works

1. The manager signs in on `lightspeed.html` and taps **Connect Lightspeed**.
2. The Worker creates a single-use `state` that lasts 10 minutes and sends the manager to `https://secure.retail.lightspeed.app/connect`.
3. The manager logs in to Lightspeed there, reviews the permissions and approves. Kush never sees the password.
4. Lightspeed redirects to `/oauth/callback`. The Worker checks `state`, exchanges the code at `https://{domain_prefix}.retail.lightspeed.app/api/1.0/token`, encrypts both tokens with AES-256-GCM and stores them in D1.
5. Access tokens are refreshed only when they expire. Each refresh stores the new refresh token, because Lightspeed rotates them. If Lightspeed rejects a refresh, the connection becomes **Reconnect required** and the dead tokens are deleted.

Source: https://x-series-api.lightspeedhq.com/docs/authorization

## Permissions (read-only)

`retailer:read outlets:read products:read sales:read inventory:read consignments:read`

The Worker refuses to request any scope containing `write`, `payments`, `register:` or `billing`. `inventory:write` is deliberately excluded. Lightspeed requires it even to *list* stock adjustments, but it would also allow changing stock. Lightspeed's removals and write-offs therefore stay manual in Kush.

## Endpoints

| | Path | Who |
|---|---|---|
| GET | `/public-status` | anyone. Returns only connected or not, plus last sync |
| GET | `/oauth/callback` | Lightspeed |
| POST | `/session` | manager passcode → 8-hour session |
| GET | `/status`, `/audit` · POST `/oauth/start`, `/check`, `/disconnect` | manager session only |
| `/mock/*` | | test mode only. A built-in imitation of Lightspeed |

## Test mode

`MOCK_LIGHTSPEED` is `"true"` until you switch to live. Every Lightspeed call is then answered inside the Worker by `src/mock.js`, which includes a consent screen with Approve, Deny and partial approval. Nothing is sent to Lightspeed, and all data is labelled as test data.

```
cd integration/worker
npm install
npm test        # 19 tests: initiation, callback, denied/invalid/replayed/expired auth,
                # token expiry + rotation, revoked access, missing permissions,
                # API and network failure, disconnect, CORS, no token leaks
```

## Setup (all free, no purchases)

Add these as **GitHub repo secrets** (Settings › Secrets and variables › Actions). Never paste them in chat or commit them.

| Secret | What |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token from the "Edit Cloudflare Workers" template, plus D1 edit permission |
| `CLOUDFLARE_ACCOUNT_ID` | Shown on the Cloudflare dashboard |
| `KUSH_MANAGER_PASSCODE` | The passcode managers use on the Lightspeed page |
| `LIGHTSPEED_CLIENT_ID` / `LIGHTSPEED_CLIENT_SECRET` | From the app you register at Lightspeed's developer portal. Add these later |

Then run **Actions › Deploy Lightspeed connection**. The workflow:
- runs the tests
- creates the D1 database
- deploys the Worker
- generates `TOKEN_KEY` and `SESSION_KEY` once, so nobody ever sees them
- writes the Worker address into `kush-config.js`
- prints the **redirect URI** to register with Lightspeed: `https://<worker>.workers.dev/oauth/callback`

To go live: register the app with that redirect URI, add the two `LIGHTSPEED_*` secrets, set the repo **variable** `LIGHTSPEED_MODE` to `live`, and run the workflow again. The manager then taps **Connect** and approves.

## Notes

- Lightspeed documents no token-revocation endpoint. **Disconnect** deletes the tokens Kush holds. To remove access completely, the manager can also remove the app inside Lightspeed.
- New Lightspeed apps are "Not Approved" by default and can still connect to up to 30 stores, which is enough for a private app.
- Syncing products, sales and deliveries into Kush is the next stage. `last_sync_at` is shown as "Not synced yet" until then.
- Never regenerate `TOKEN_KEY`. If it changes, stored tokens can't be read, and the manager has to reconnect. The Worker handles this safely.
