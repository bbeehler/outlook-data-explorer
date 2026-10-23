# Outlook Data Explorer

A web version of the AIA Canada Outlook Study 2025 data visualization tool, replacing the Excel workbook. It has all 61 figures in one place, plus year and province filters, table view, CSV download and optional "Ask the data" AI answers.

**Live site:** https://bbeehler.github.io/outlook-data-explorer/

## How it works

| Piece | Where | Notes |
|---|---|---|
| The page (`index.html`, `config.js`) | This repo, served by GitHub Pages | Contains **no data**. Safe to be public. |
| The Outlook figures | Supabase project "AIA Canada Data Portal", table `outlook_figures` | Readable only by signed-in people on the access list (row-level security). Contains licensed S&P Global Mobility and IMR data. |
| Who can sign in | Table `outlook_access` | Filled automatically from Insightly every night (contacts at current member organisations), plus anyone an admin adds under **Manage access**. |
| Insightly sync | Edge function `outlook-member-sync`, run nightly by pg_cron | Same membership rule as the MCE Dashboard: an organisation's **Last Membership Year** is this year or later (2050 = lifetime). Last year's members keep access until March 31. |
| Sign-in | Supabase Auth email link (no passwords) | Uses the Data Portal's existing auth. |
| Ask the data | Edge function `outlook-ask` | Calls the Anthropic API with the key stored as a Supabase secret. 30 questions per person per hour, logged in `outlook_ai_log`. |

## One-time setup

1. **GitHub Pages:** go to Settings, then Pages, then Deploy from a branch: `main` / root.
2. **Sign-in redirect:** in Supabase, open the AIA Canada Data Portal project, then Authentication, then URL Configuration. Add `https://bbeehler.github.io/outlook-data-explorer/` under **Redirect URLs**. Without this, sign-in links send people to the portal instead of the Explorer.
3. **Insightly key:** in Supabase, open the Data Portal project, then Edge Functions, then Secrets, and add `INSIGHTLY_API_KEY`. Use the same key the MCE Dashboard project uses. Then click **Sync from Insightly now** on the Manage access page.
4. **AI (optional):** in Supabase, open Edge Functions, then Secrets, and add `ANTHROPIC_API_KEY`. The Ask button appears on its own once the key is there. Optional secrets:
   - `OUTLOOK_AI_MODEL`: default `claude-sonnet-5-5`
   - `OUTLOOK_AI_HOURLY_LIMIT`: default `30`
   - `OUTLOOK_ALLOWED_ORIGINS`: add a custom domain here if you move the site

## Giving people access
Member contacts are handled by the Insightly sync. A person gets access when their contact record in Insightly has an email address and is linked to a member organisation.

For anyone else (staff, partners, a member contact missing from Insightly), sign in as a Data Portal admin, open **Manage access**, and paste their emails. People added this way are never removed by the sync.

The sync has two safety limits. If Insightly returns fewer than 100 member organisations, it changes nothing. If one run would remove more than 25% of the synced list, it skips the removals and notes it on the Manage access page.

## Updating the data (next Outlook edition)
1. Run `tools/charts.py` and `tools/extract.py` on the new workbook to produce `data.json`. That file is ignored by git; never commit it.
2. Load each figure into `outlook_figures` with a new `edition` value, and update the `.eq('edition', '2025')` filter in `tools/boot_supabase.js`.
3. Run `python3 tools/build_site.py` to rebuild `index.html`.

Claude can do all three steps from the new workbook.

## Data notes from the source workbook
- Market size for 2021 (Demand analysis, Tables 1–2) is far below 2020 and 2022. It is flagged in the tool until EY confirms it.
- Chapter 1, Figure 1 is labelled "$ billions" in the workbook, but the source values are in millions. The tool shows them in billions.
- New vehicle registration segment Tables 7–8 are titled 2017–2021 but contain 2019–2023 data.
