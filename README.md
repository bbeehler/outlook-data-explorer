# Outlook Data Explorer

A web version of the AIA Canada Outlook Study 2025 data visualization tool, replacing the Excel workbook. It has all 61 figures in one place, plus year and province filters, table view, CSV download and optional "Ask the data" AI answers.

**Live site:** https://outlook.aiacanada.com (the old bbeehler.github.io address forwards here)

## How it works

| Piece | Where | Notes |
|---|---|---|
| The page (`index.html`, `config.js`) | This repo, served by GitHub Pages | Contains **no data**. Safe to be public. |
| The Outlook figures | Supabase project "AIA Canada Data Portal", table `outlook_figures` | Readable only by signed-in people on the access list (row-level security). Contains licensed S&P Global Mobility and IMR data. |
| Registration | Edge function `outlook-register` | A visitor enters their work email. It is checked live in Insightly: approved if the email belongs to a contact at an organisation whose **Last Membership Year** is this year or later (2050 = lifetime; last year's members count until March 31). This is the same rule the MCE Dashboard uses. Approved people are added to `outlook_access` and sent a sign-in link. Everyone else is turned away with a contact, and no account is created. Every request is logged in `outlook_registrations`. |
| Nightly re-check | Edge function `outlook-member-sync`, run nightly by pg_cron | Re-checks registered members and removes anyone whose organisation's membership has lapsed. It never adds people. |
| Who can sign in | Table `outlook_access` | Registered members, plus anyone an admin adds under **Manage access**. |
| Sign-in | Supabase Auth email link (no passwords) | Uses the Data Portal's existing auth. |
| Ask the data | Edge function `outlook-ask` | Calls the Anthropic API with the key stored as a Supabase secret. 30 questions per person per hour, logged in `outlook_ai_log`. |

## One-time setup

0. **Custom domain:** a DNS CNAME record `outlook` → `bbeehler.github.io`, with the domain set under Settings → Pages (the `CNAME` file in this repo). Tick **Enforce HTTPS** once GitHub has checked the DNS.

1. **GitHub Pages:** go to Settings, then Pages, then Deploy from a branch: `main` / root.
2. **Sign-in redirect:** in Supabase, open the AIA Canada Data Portal project, then Authentication, then URL Configuration. Add `https://outlook.aiacanada.com/` under **Redirect URLs**, and set **Site URL** to it if this project has no other site. Without this, sign-in links send people to the portal instead of the Explorer.
3. **Insightly key:** in Supabase, open the Data Portal project, then Edge Functions, then Secrets, and add `INSIGHTLY_API_KEY`. Use the same key the MCE Dashboard project uses. Registration doesn't work until this key is in place.
4. **AI (optional):** in Supabase, open Edge Functions, then Secrets, and add `ANTHROPIC_API_KEY`. The Ask button appears on its own once the key is there. Optional secrets:
   - `ANTHROPIC_WORKSPACE_ID`: needed only if the API key is not scoped to one workspace (Claude Console → Settings → Workspaces shows the ID)
   - `OUTLOOK_AI_MODEL`: default `claude-sonnet-5-5`
   - `OUTLOOK_AI_HOURLY_LIMIT`: default `30`
   - `OUTLOOK_ALLOWED_ORIGINS`: only needed if the site moves to a new address. outlook.aiacanada.com and bbeehler.github.io are allowed by default.

## Giving people access
Members register themselves. They get access when their contact record in Insightly has the same email address and is linked to a current member organisation. The contact shown to people who are turned away is `contactEmail` in `config.js`.

**Manage access** shows recent requests. Tick "Show only denied requests" to see people to follow up with: member employees missing from Insightly, or non-members who are interested.

For anyone else (staff, partners, a member contact missing from Insightly), sign in as a Data Portal admin, open **Manage access**, and paste their emails. People added this way are never removed by the sync.

### Troubleshooting who gets in
**Manage access** has two tools for when a member says they can't get in:
- **Check an email:** type any address to get the live answer from Insightly: would they be approved or denied, why, and which contact and organisation records Insightly holds for that email (with each organisation's Last Membership Year). It doesn't add the person, email them or log a request.
- **Member directory:** every current member organisation, plus those lapsed within the last year, with its Last Membership Year and how many of its contacts have an email that can register. Expand an organisation to see its contacts, or search for a person or email. This is a snapshot taken on each re-check (tables `outlook_member_orgs` and `outlook_member_contacts`, admins only), so recent changes in Insightly show up after **Re-check members now**.

The usual causes of a denial: the email on the Insightly contact is different (an old or personal address), the contact isn't linked to the organisation, or the organisation's Last Membership Year hasn't been updated for this year.

The nightly re-check has two safety limits. If Insightly returns fewer than 100 member organisations, it changes nothing. Once 20 or more people have registered, if one run would remove more than 25% of them, it skips the removals and notes it on the Manage access page.

## Ontario Vehicles page (`ontario/`)
A separate, public page at https://outlook.aiacanada.com/ontario/ built from Ontario's open [Vehicle population data](https://data.ontario.ca/dataset/vehicle-population-data) (Ministry of Transportation, Open Government Licence – Ontario). It shows vehicles on the road from 2014 to the latest year, plus fuel mix, vehicle age, makes, models and counties. It holds counts only, never VINs or owner details, and needs no sign-in because the data is open. The Explorer's topic list links to it.

- **Updates itself:** the "Ontario vehicle data" GitHub Action runs monthly. It downloads every file in the dataset, keeps the raw files on the `ontario-raw` branch, rebuilds `ontario/data.json` with `tools/ontario_build.py`, and commits only when the numbers change. Run it by hand from the Actions tab.
- **Make and model names:** the Ministry publishes codes (TOYT, RV4). The names are mapped in `tools/ontario_build.py` (`MAKES`, `MODELS`). Add a model name there when a code becomes clear; codes without a name are shown as is.
- **What "on the road" means:** passenger and commercial vehicles with fit-active status at December 31. The 2015 file is a stub and is skipped. The 2020–2023 dip reflects COVID-era sticker extensions and the 2022 end of sticker fees, as noted on the page.

## Updating the data (next Outlook edition)
1. Run `tools/charts.py` and `tools/extract.py` on the new workbook to produce `data.json`. That file is ignored by git; never commit it.
2. Load each figure into `outlook_figures` with a new `edition` value, and update the `.eq('edition', '2025')` filter in `tools/boot_supabase.js`.
3. Run `python3 tools/build_site.py` to rebuild `index.html`.

Claude can do all three steps from the new workbook.

## Data notes from the source workbook
- Market size for 2021 (Demand analysis, Tables 1–2) is far below 2020 and 2022. It is flagged in the tool until EY confirms it.
- Chapter 1, Figure 1 is labelled "$ billions" in the workbook, but the source values are in millions. The tool shows them in billions.
- New vehicle registration segment Tables 7–8 are titled 2017–2021 but contain 2019–2023 data.
