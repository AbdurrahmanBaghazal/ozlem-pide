# Raykent Özlem Pide

Turkish restaurant website, digital menu, and owner dashboard built for Raykent Özlem Pide.

## Current features

- Restaurant homepage with menu, phone, address, opening hours, and Google Maps links.
- Bright red, white, and pale yellow branding based on the supplied storefront sign (`sign-color-reference.png`).
- Searchable 64-item digital menu from the supplied menu photo; eight categories.
- 37 generated illustrative food images mapped across the menu; see [image generation notes](IMAGE-GENERATION.md).
- Product details, sold-out state, optional descriptions, and optional image upload.
- First-run owner setup with no default password.
- Owner dashboard to edit products and restaurant details, preview drafts, and publish menu changes.
- Owner-created editor accounts. Editors can manage draft products; only the owner can publish, manage accounts, or change restaurant details.
- One-time owner password recovery using the private Vercel setup key; a successful reset signs out existing owner sessions.
- SQLite persistence, server-side sessions, login limiting, and an audit trail.
- A stable `/q` menu redirect and downloadable SVG QR artwork after a public base URL is configured.

## Run locally

Requires Node.js 24 or newer.

```powershell
cd 'C:\Users\ReYAT\Documents\restaurant services\raykent-ozlem-pide-app'
npm install
npm run dev
```

Open <http://127.0.0.1:3100/> for the website, <http://127.0.0.1:3100/menu> for the menu, and <http://127.0.0.1:3100/admin> to create the first owner account. The owner enters their own username and password in the setup screen. No credentials are stored in the repository.

The database and uploaded images are stored under `data/` and ignored by Git. The first start imports `menu-seed.csv`; later changes are kept in SQLite. Editing the CSV after first start does not overwrite existing data.

## Deploy on Vercel

The repository includes `server.ts`, the Vercel entrypoint, and `vercel-server.mjs`, which uses PostgreSQL for durable menu, account, session, and uploaded image data. The local `npm run dev` server continues to use SQLite. Import this repository as a Vercel project with the root directory at the repository root and Node.js 24. Vercel detects `server.ts` as a Node server.

Connect a Neon PostgreSQL database through Vercel Storage and make its `DATABASE_URL` available to Production. Add a random secret as `ADMIN_SETUP_KEY` in the Vercel project's Production environment. The database schema and initial 64-item menu are created on the first API request. The first owner setup at `/admin` requires that key; the owner chooses their own username and password. Once created, no further owner setup is allowed. Keep the setup key private and remove it from the environment after owner setup if desired.

The generated food images and restaurant photograph are committed as public assets. New images uploaded through the dashboard are stored in PostgreSQL, while `data/` stays local and untracked. Set the final HTTPS origin under **Restoran Bilgileri → Yayın adresi** before downloading the QR code.

If the owner forgets their password, use **Şifremi unuttum** on `/admin`. Enter the owner username, the Production `ADMIN_SETUP_KEY`, and a new password of at least 12 characters. The key works for one reset only; rotate `ADMIN_SETUP_KEY` in Vercel and redeploy before another reset. The old password cannot be retrieved. Recovery is rate limited and invalidates the owner's existing sessions.

## Menu review

The photo-based transcription is in `menu-seed.csv` and the workspace review copy is [RAYKENT-OZLEM-PIDE-MENU-REVIEW.csv](../RAYKENT-OZLEM-PIDE-MENU-REVIEW.csv). Ten entries have review notes. The Şişe Fanta price was unreadable and appears as “Fiyat sorunuz” until corrected. The photo itself is stored as `menu-photo-reference.png` for joint review.

The supplied [Google Maps listing](https://maps.app.goo.gl/PPYUTXS3xVezweHs9) provided the initial address, phone, and daily hours. The owner can edit these in the dashboard.

## QR code

The QR points to the stable `/q` route, which redirects to the published menu. Before downloading print artwork, enter the final HTTPS site origin in **Restoran Bilgileri → Yayın adresi**. A localhost QR should not be printed for customers.

## Checks

Run `npm test`. The integration test covers owner setup, draft/published separation, editor permissions, disabled accounts, QR generation, and the stable redirect.

## Before handing the menu to customers

- Review the ten flagged menu entries together and correct any transcription mistakes.
- Replace representative generated imagery with approved photographs of the restaurant's food where available.
- Choose a public domain and hosting, configure HTTPS, backups, and monitoring, then verify the QR on printed material.
- Have the owner create the real admin credentials and confirm contact details, prices, and menu text.
- Add a production account recovery and backup/restore procedure before relying on the system for daily operations.
