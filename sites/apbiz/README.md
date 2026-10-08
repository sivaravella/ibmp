# Apbiz website

The public site of Apbiz Consulting India LLP (https://apbiz.in): 14 static pages, one stylesheet, no scripts. It is separate from the IBMP application.

| Path | What |
|---|---|
| `content.mjs` | Every word on the site: company details, the 13 service pages, hero tags, FAQs. **Edit text here.** |
| `build.mjs` | Page templates (header, footer, structured data, sitemap). Run `node sites/apbiz/build.mjs`. |
| `styles.css` | The whole design (navy, white and soft grey; green only for WhatsApp buttons). |
| `check.mjs` | Quality gate: broken links, one h1 per page, unique titles and descriptions, valid structured data. Run after building. |
| `nginx-site.conf` | Config of the nginx container that serves the files (clean redirects, 404 page, security headers). |
| `site/` | The generated site, committed so GitHub shows exactly what is live. |

Publish a change: edit, build, check, then copy `site/` to `/opt/apbiz-site/html` on the server (see `docs/DEPLOY.md`). Nothing has to restart; the previous version is kept next to it as `html.bak-*`.

Rules the content follows: no invented clients, numbers, awards or credentials; no section numbers or money thresholds that the new Income-tax Act (in force from April 2026) or GST notifications might change; every page tells the reader that rules and dates change and that we confirm them for their case. Please keep to those when adding text.
