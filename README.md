# Kush Collective Staff Portal

A simple stock and shift system for Kush Collective (Sea Point, Cape Town), built by [TAMANY.TECH](https://tamany.tech).
One HTML file. No build step, no server, no dependencies to install.

## Features

- **PIN login** with admin and staff roles
- **Stock received**: log deliveries or an opening balance, with supplier and invoice reference
- **Count sheet**: opening and closing counts with live variance, save as draft, complete when done
- **Short list**: everything below par with the quantity to order, plus what was short in the last stock take
- **Stock**: product list with par levels and low-stock flags (admin can add, edit and delete)
- **Shifts**: weekly schedule grid
- **History**: every receipt and count, who did it, when, before and after. Filterable
- **Excel export**: Stock, Short list, History and Shifts sheets in one `.xlsx`
- **Backup and restore**: download all data as JSON and restore it on any device
- **Autosave**: drafts and entries save as you type. The top bar shows "Saved" or "Not saving"

## How it works

1. **Receive stock.** Use *Opening balance* for what is already on the shelf, then *Delivery* for every new delivery.
2. **Count at shift.** Do an opening or closing count. Stock updates to the counted figure and any difference is logged.
3. **Check the short list.** See what to reorder and what went missing.

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

- Shared stock across devices (Firebase or similar)
- Per-staff logins
- Sales and usage tracking
- Low-stock alerts

## Credits

Built by TAMANY.TECH for Kush Collective.

## Licence

Copyright (c) TAMANY.TECH. All rights reserved. Not for reuse or redistribution without permission.
