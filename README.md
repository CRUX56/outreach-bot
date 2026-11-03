# Outreach Bot

Self-hosted cold-email bot: finds local businesses with weak/no websites (OpenStreetMap (default, free, no key) or Google Places (optional)), audits their sites, drafts personalized emails with a local Ollama model, and sends only after you approve each draft.

## Setup
1. `copy .env.example .env` and set `APP_SECRET`, `ADMIN_PASSWORD` (and optionally `GOOGLE_PLACES_API_KEY`), `PUBLIC_URL`.
2. `docker compose up -d` (Postgres, Ollama, app), then `docker compose exec ollama ollama pull llama3.1:8b`.
   Without Docker: run Postgres + Ollama yourself, `npm install`, `npm run migrate`, `npm start`.
3. Open the admin UI (basic auth), go to **Sender settings**, add your from address, SMTP/IMAP, business name and mailing address, click **Verify**, **Send test**, then **Make active**.
4. On the **Dashboard** search a category + city. Leads are audited, weak ones get drafts in the **Approval queue**.

## How personalization works
Each site is audited (no website, unreachable, no HTTPS, not mobile-friendly, slow, outdated, no CTA/SEO, placeholder). The top 3 verified findings go into the Ollama prompt; drafts claiming anything not in the findings are rejected and a findings-based template is used instead. Findings are shown beside each draft.

## Sending and compliance
- Daily cap, send window and randomized spacing per sender profile; start low (about 20/day) and warm up the domain.
- Every email has your physical address and a one-click unsubscribe link; unsubscribes, bounces and replies stop further mail.
- Use a dedicated sending domain with SPF/DKIM/DMARC. You are responsible for CAN-SPAM compliance.

## Dev
`npm test`, `npm run typecheck`


## Lead sources
- **OpenStreetMap** (default): no key needed. OSM data is incomplete, so a missing website tag may just mean nobody added it; review the findings in the approval queue before sending.
- **CSV import** on the Dashboard: header row with name (required), website, email, phone, category, city.
- **Google Places**: optional, needs GOOGLE_PLACES_API_KEY.
