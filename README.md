# Outreach Bot

Self-hosted cold-email bot: finds local businesses with weak/no websites (OpenStreetMap (default, free, no key) or Google Places (optional)), audits their sites, drafts personalized emails with a local Ollama model, and sends only after you approve each draft.

## Setup
1. `copy .env.example .env` and set `APP_SECRET`, `ADMIN_PASSWORD` (and optionally `GOOGLE_PLACES_API_KEY`). Set `PUBLIC_URL` to your publicly reachable HTTPS application URL before sending commercial messages.
2. `docker compose up -d` (Postgres, Ollama, app), then `docker compose exec ollama ollama pull llama3.1:8b`.
   Without Docker: run Postgres + Ollama yourself, `npm install`, `npm run migrate`, `npm start`.
3. Open the admin UI (basic auth), go to **Sender settings**, add your from address, SMTP/IMAP, business name and mailing address, click **Verify**, **Send test**, then **Make active**.
4. On the **Dashboard** search a category + city. The **Leads** page shows the most recently started successful search, in search-result order, including businesses already saved by an earlier search. Use **All saved leads** to see up to 200 of the most recently saved leads, including earlier searches and CSV imports. Existing leads and drafts are retained. Empty successful searches show no leads; a failed search does not replace the previous results.
5. On **Leads**, select individual leads with pending drafts using the checkboxes, or select all eligible visible leads, then click **Review selected drafts**. Leads with no pending draft cannot be selected. This only filters the approval queue; it does not send anything. Review and approve or reject each draft individually. **View all drafts** removes the filter. Approved drafts may be sent automatically in the sender's configured window; previously approved drafts remain approved after upgrading. Follow-ups are also individually approved.

For an existing installation, run `npm run migrate` before restarting the app. Docker runs migrations when the app container starts.

After changing application files, rebuild the Docker app image with `docker compose up -d --no-deps --build app`. A plain container restart does not include updated source files. Refresh the browser after the app starts.

## How personalization works
Each site is audited (no website, unreachable, no HTTPS, not mobile-friendly, slow, outdated, no CTA/SEO, placeholder). The top 3 verified findings go into the Ollama prompt; drafts claiming anything not in the findings are rejected and a findings-based template is used instead. Findings are shown beside each draft.

## Sending and compliance
- U.S. CAN-SPAM requirements apply to commercial B2B email as well as consumer email. Every commercial message includes an advertising disclosure, your business name, physical postal address, and an unsubscribe link. Verify your sender details, subject, and content are accurate and not misleading; the app cannot determine legal compliance or provide legal advice. Review the [FTC's CAN-SPAM guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) and consult counsel about North Carolina and other applicable laws.
- Set a valid sender name, address, business name, and physical mailing address, and configure `PUBLIC_URL` as a publicly reachable HTTPS hostname (not an IP address). The app checks the URL format, not actual external reachability. Verify the unsubscribe link from outside your network and keep it working for at least 30 days after every email. Preserve the database, link records, and `APP_SECRET` across deployments; legacy unsubscribe links also depend on the original secret and associated lead.
- An unsubscribe link opens a confirmation page, and submitting it suppresses that email address across duplicate leads and rejects pending/approved drafts. Links created for new messages retain the original recipient even if a lead's email changes; older links identify the lead and cannot recover a previously changed or deleted address. Addresses are retained in the do-not-email list.
- Check the sender's reply inbox and other channels regularly. Add requests received outside the link through **Do not email** immediately; the federal deadline is 10 business days. Configure and verify IMAP for automatic reply monitoring, but do not rely on automatic detection alone. Bounces and replies also stop further mail.
- Daily cap, send window and randomized spacing are configured per sender profile; start low (about 20/day) and warm up the domain. Use a dedicated sending domain with SPF/DKIM/DMARC. Review approved drafts after updates and before enabling the worker. Failed sends appear in the Approval queue; verify delivery with your provider before retrying because some SMTP failures leave delivery uncertain.

## Text messages (SMS via Twilio)
Texts are for leads who have **agreed to receive texts** — for example someone who replied to your email with "text me at…", or filled in a form with an SMS consent checkbox. Under the TCPA, automated marketing texts require the recipient's prior express written consent (statutory damages are $500–$1,500 per message), and carriers require proof of opt-in for 10DLC registration. A number pulled from a directory, Google, OpenStreetMap or a website is **not** consent, so the bot never texts a lead automatically.

Setup:
1. In Twilio, buy a local number and complete **A2P 10DLC** brand and campaign registration (use case: marketing/customer care; describe how people opt in). US texts from unregistered numbers are blocked.
2. Leave Twilio's **Advanced Opt-Out** on (default). It sends the STOP/START/HELP confirmations.
3. In the number's settings, set **A message comes in** to `POST {PUBLIC_URL}/sms/inbound`.
4. In **Sender settings**, fill in the Twilio Account SID, Auth Token, phone number (E.164, e.g. `+17045551234`) and daily text cap, save, then use **Send test text** on your own phone.

Workflow:
- On **Leads**, click **Record consent** next to a lead, enter their mobile number and how/when they agreed (stored as your consent record), and confirm.
- Write a text on the same page; it goes into the **Approval queue** under *Text messages*. Approved texts send one at a time, 1–3 minutes apart, only between 8am and 9pm (and inside the sender's window) in the profile's timezone, under the daily text cap.
- Every text is prefixed with your business name and ends with "Reply STOP to opt out."
- Replies of STOP/UNSUBSCRIBE/CANCEL/END/QUIT, or phrases like "stop texting me" or "wrong number", add the number to **Do not text** and cancel queued texts. START re-subscribes. Any other reply marks the lead *replied* and cancels queued texts so you can answer personally.
- Add numbers to **Do not text** whenever someone opts out another way.

## Dev
`npm test`, `npm run typecheck`, `npm run build:css`. `npm start` builds the local Tailwind stylesheet before launching the server; `npm run dev` requires `npm run build:css` first and after styling changes. The optional PostgreSQL/SMTP integration test creates and removes an isolated test schema in the configured database: build CSS, explicitly set `DATABASE_URL` and `TEST_INTEGRATION=1`, and run `npm test` with a database user allowed to create schemas.


## Call list
Businesses with no website rarely publish an email address, so they used to be disqualified. Now a weak-website lead with no usable email but a valid phone number gets the status `call_first` and appears on the **Call list** page (tap-to-call links). After you call or visit:
- **Got their email**: enter it, and the bot checks the domain can receive mail, marks the lead qualified and drafts a first email for your approval.
- **They agree to texts**: use **Record text consent**.
- **Not interested**: removes them from the list (status `declined`).

Leads whose email address is on the do-not-email list are not added to the call list.

## Lead sources
- **OpenStreetMap** (default): no key needed. OSM data is incomplete, so a missing website tag may just mean nobody added it; review the findings in the approval queue before sending.
- **CSV import** on the Dashboard: header row with name (required), website, email, phone, category, city.
- **Google Places**: optional, needs GOOGLE_PLACES_API_KEY.
