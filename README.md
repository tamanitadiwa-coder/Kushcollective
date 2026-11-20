# Kush Collective Staff Portal

A simple stock and shift system for Kush Collective (Sea Point, Cape Town), built by [TAMANY.TECH](https://tamany.tech).
One HTML file. No build step, no server, no dependencies to install.

## Features

- **Overview**: products, items requiring attention, stocktake status, last Lightspeed import, recent movements
- **Stocktake**: iPad-first counting with large steppers, search by name or barcode scan, filters for short, over and matching, autosaved drafts you can continue later, and a review step that requires an explanation for every difference
- **Stock movements**: one ledger for sales, refunds, deliveries, removals, adjustments and corrections. Each entry is marked Lightspeed or Manual. Entries are never edited; mistakes are reversed with a correction
- **Lightspeed import**: import Lightspeed Retail (X-Series) report exports (CSV or Excel) for products, sales and deliveries. Rows already imported are detected and skipped. Voided and cancelled rows are skipped; negative sale quantities are refunds
- **Variances**: every difference with expected, actual, difference, date, who counted, explanation and review status. Never deleted
- **History**: every completed stocktake and import, viewable and downloadable
- **Shifts**: weekly rota per store
- **PIN login** with admin and per-staff codes
- **Excel export** and **JSON backup and restore**

Expected stock = opening + received − sold − removed ± adjustments. Variance = counted − expected.

Live Lightspeed sync is not built yet. It needs a small secure backend to hold the access token, because tokens must never be in browser code.

## Default PINs

| Role  | PIN  |
|-------|------|
| Admin | 1234 |
| Staff | 0000 |

Change both under **Admin** before real use.

## Run locally

Open `index.html` in Chrome or Safari. Do not open it inside a chat or preview app, because those can block saving.

## Deploy with GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings > Pages**.
3. Under **Build and deployment**, set Source to **Deploy from a branch**, branch `main`, folder `/ (root)`.
4. Your portal will be live at `https://<your-username>.github.io/<repo-name>/`.

Open that link on each device and add it to the home screen. A fixed address keeps saved data stable on each device.

## Customise

All in `index.html`:

- **Logo**: change the `LOGO` constant at the top of the script. If it fails to load, a green "K" shows instead.
- **Colours**: edit the CSS variables in `:root` (`--g` green, `--gd` dark green, `--gl` light green).
- **Starting products**: edit the `seed()` function. Products can also be added in the app under **Stock**.
- **Par levels**: set per product under **Stock > Edit**. The short list uses these.

## Data and security

- Data is stored in the browser (`localStorage`) on each device. Devices do not share data.
- Download a backup regularly from **Admin**.
- PINs are checked in the browser. They stop casual access but are **not secure**. Do not treat this as protection for sensitive data.
- Keep the repo **private** if it ever contains real stock figures or staff names. Do not commit backup files.

## Roadmap

- Secure backend with live Lightspeed sync (read-only token)
- Shared stock across devices
- Per-staff logins
- Sales and usage tracking
- Low-stock alerts

## Credits

Built by TAMANY.TECH for Kush Collective.

## Licence

Copyright (c) TAMANY.TECH. All rights reserved. Not for reuse or redistribution without permission.
