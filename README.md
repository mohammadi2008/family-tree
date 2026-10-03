# شجرة العائلة · Interactive Arabic Family Tree

**Pre-release review 1.0.2:** see `RELEASE-REVIEW-FA.md` for the fixes,
verified test results, limitations and deployment checklist. No database schema
change is needed beyond migrations 0001 and 0002.

A RTL Arabic family-tree website designed for **Cloudflare's free plan**:
**Cloudflare Pages** (hosting) + **Pages Functions** (API) + **Cloudflare D1** (SQLite database, photos included).
No R2 or Firebase. Free-plan quotas still apply; see deployment and test notes below.

* Public visitors browse the tree (no login). Only the admin can add / edit / delete.
* Dates in **Jalali (Shamsi) and Gregorian**, partial dates (year only), age & lifespan in Arabic.
* Spouses who are also blood relatives (e.g. cousin marriages) are ONE record drawn in two places;
  selecting one appearance makes the other **blink** and the view glides to it.
* Canvas renderer with viewport culling; iterative layout handles deep trees without recursive stack overflow. Performance varies by device and family graph.
* 6 glass themes, PDF export (300 DPI, Arabic text, photos), JSON backup / restore, WhatsApp contact.

---

## 1. Architecture (short)

**Fixed release:** apply migration `0002_safe_restore.sql` before publishing the
updated Functions. Read `UPGRADE-FA.md` for privacy changes, staged restore,
deployment prerequisites and the manual browser/Cloudflare checklist.
Run `node tests/check.mjs` and `node --test tests/*.test.mjs` (Node + Python 3).

```
Browser (vanilla ES modules, no build step)
  ├─ Canvas tree renderer  ── same renderer is reused for the PDF export
  ├─ Iterative layout engine (RTL, multiple spouses, collapse/expand, multi-appearance)
  └─ Glass UI (Arabic, RTL, 6 themes via CSS variables)
        │  fetch /api/*  (JSON, httpOnly session cookie, anti-CSRF header)
        ▼
Cloudflare Pages Functions  (functions/api/**)
  ├─ _middleware.js : CSRF check, security headers, error handling
  ├─ auth (PBKDF2 hash, HS256 JWT cookie, D1-based rate limiting)
  └─ persons / marriages / photo / tree / admin (export, import, settings)
        │  D1 binding "DB"
        ▼
Cloudflare D1 (SQLite): persons, marriages, photos (base64 WebP), settings, login_attempts
```

Only `/api/*` runs Functions (`public/_routes.json`), so static files are served free and unlimited.

---

## 2. Folder structure

```
family-tree/
├─ README.md                 ← this guide
├─ package.json              ← wrangler scripts (CLI option)
├─ wrangler.toml             ← Pages + D1 config (put your database_id here)
├─ .dev.vars.example         ← local secrets template
├─ .gitignore
├─ migrations/
│  └─ 0001_init.sql          ← database schema
├─ seed/
│  ├─ sample-data.sql        ← demo family (cousin marriage, 2 wives, divorce, Jalali dates)
│  └─ sample-family.json     ← same demo as a backup file (restore it from the admin menu)
├─ src/server/               ← shared backend code (bundled into the Functions)
│  ├─ http.js  db.js  auth.js  ratelimit.js  validate.js  photo.js  relations.js
├─ functions/api/            ← API routes (file name = URL)
│  ├─ _middleware.js   [[path]].js   tree.js
│  ├─ auth/  login.js  logout.js  me.js  password.js
│  ├─ persons/  index.js  [id].js
│  ├─ marriages/  index.js  [id].js
│  ├─ photo/  [id].js
│  └─ admin/  export.js  import.js  settings.js
└─ public/                   ← the website (Pages output directory)
   ├─ index.html  _headers  _routes.json  manifest.webmanifest
   ├─ css/styles.css
   ├─ fonts/cairo-arabic.woff  fonts/LICENSE.txt
   ├─ img/favicon.svg
   └─ js/  app.js  api.js  calendar.js  layout.js  renderer.js  viewport.js  minimap.js
           details.js  forms.js  datefield.js  photo.js  pdf.js  admin.js  search.js
           ui.js  icons.js  avatar.js  prefs.js  text.js
```

`public/js/calendar.js` is imported by both the browser and the Functions, so date validation is identical on both sides.

---

## 3. What "free forever" means here (Cloudflare free plan, no card)

| Service | Free allowance | This app's usage |
|---|---|---|
| Pages | unlimited static requests & bandwidth, 500 builds/month | the website |
| Functions | 100,000 requests/day (shared with Workers) | only `/api/*`; photos use no-store for privacy |
| D1 | 500 MB per database, 5 GB per account, 5 M rows read/day, 100 k rows written/day | staging temporarily needs extra storage during restore |

D1 databases on the free plan are not paused or deleted for inactivity.

---

## 4. Deployment, Option A: dashboard only (no terminal, for non-developers)

You need a free **GitHub** account and a free **Cloudflare** account.

### Step 1: Put the code on GitHub
1. Unzip the project on your computer.
2. Go to <https://github.com/new>, name the repository `family-tree`, choose **Private**, click **Create repository**.
3. On the new page click **uploading an existing file**.
4. Open the unzipped `family-tree` folder, select **everything inside it** (including `functions`, `public`, `src`, `migrations`, `seed`, `wrangler.toml`) and drag it into the browser. Click **Commit changes**.
   *(Hidden files such as `.gitignore` are optional.)*

### Step 2: Create the database
1. Log in to <https://dash.cloudflare.com>.
2. Left menu: **Storage & Databases → D1 SQL Database → Create**.
3. Name: `family-tree-db` → **Create**.
4. Open the database, go to the **Console** tab, execute `migrations/0001_init.sql` and then `migrations/0002_safe_restore.sql`. Existing installations only need the new `0002` migration. Never reseed a production database to upgrade.
5. (Optional, demo data) do the same with `seed/sample-data.sql`.
6. Copy the **Database ID** shown on the database page (looks like `a1b2c3d4-…`).

### Step 3: Put the database ID in `wrangler.toml`
1. In your GitHub repository click `wrangler.toml` → the ✏️ (Edit) button.
2. Replace `00000000-0000-0000-0000-000000000000` with your Database ID.
3. Click **Commit changes**.

### Step 4: Create the Pages site
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Authorize GitHub and pick the `family-tree` repository → **Begin setup**.
3. Build settings: **Framework preset:** None · **Build command:** *(leave empty)* · **Build output directory:** `public`.
4. Click **Save and Deploy**. Wait for "Success". Your site is now at `https://family-tree-xxx.pages.dev`.

### Step 5: Set the admin password (secrets)
1. Open the Pages project → **Settings → Variables and Secrets → Add**.
2. Type **Secret**, name `ADMIN_PASSWORD`, value = your admin password (12+ characters recommended). Save.
3. Add another **Secret** named `SESSION_SECRET` with a long random value (40+ random characters; you can mash the keyboard).
4. Go to **Deployments**, open the latest deployment's ⋯ menu → **Retry deployment** (secrets apply to new deployments).

### Step 6: First run
1. Open your site → menu ☰ → **دخول المدير** → enter `ADMIN_PASSWORD`.
2. If the tree is empty, click **إضافة الشخص الأول** to create the root ancestor.
3. Tap any person to add children, spouses, parents, edit or delete.
4. Recommended: menu → **تغيير كلمة المرور** (stores a salted PBKDF2 hash in D1; the env password then stops working).

> Drag-and-drop "Direct Upload" in the dashboard does **not** support Functions, which is why Option A uses GitHub.
> Every future change you commit on GitHub redeploys automatically.

---

## 5. Deployment, Option B: command line (developers)

Requires Node.js 18+.

```bash
cd family-tree
npm install
npx wrangler login
npm run db:create                 # copy the printed database_id into wrangler.toml
npm run db:migrate                # creates the tables in the remote D1 database
npm run db:seed                   # optional demo family (REPLACES existing people)
npx wrangler pages project create family-tree --production-branch main
npx wrangler pages secret put ADMIN_PASSWORD --project-name family-tree
npx wrangler pages secret put SESSION_SECRET --project-name family-tree
npm run deploy                    # = wrangler pages deploy (uploads public/ + functions/)
```

Local development:

```bash
cp .dev.vars.example .dev.vars    # edit the values
npm run db:migrate:local
npm run db:seed:local             # optional
npm run dev                       # http://localhost:8788
```

---

## 6. Environment variables

| Name | Type | Required | Purpose |
|---|---|---|---|
| `DB` | D1 binding | yes | the database (configured in `wrangler.toml`) |
| `ADMIN_PASSWORD` | secret | yes (until you change the password in the app) | bootstrap admin password |
| `SESSION_SECRET` | secret | recommended | HMAC key for session tokens (≥ 32 chars). If missing, a random one is generated and stored in D1. |
| `PBKDF2_ITERATIONS` | variable | no | 10,000–100,000 (default 60,000). Lower it if login hits the free-plan CPU limit. |

---

## 7. Using the app

* **Tap a person**: visitors see the details panel; the admin sees an action card (details, add child, add spouse, add parent, edit, delete).
* **Cousin marriage**: *Add spouse → "شخص موجود في الشجرة"* and pick the existing cousin. No duplicate record is created; tapping either appearance makes the other one blink and draws a glowing thread between them.
* **Collapse/expand**: the small ⊖/⊕ under a person with children; `+N` shows hidden descendants.
* **Navigation**: drag to pan, pinch or mouse wheel to zoom, zoom/fit/100% buttons, minimap, search (press `/` on desktop).
* **Dates**: each date field has its own Shamsi/Gregorian toggle; leave day/month empty for partial dates. The menu switches the display calendar and Arabic/Latin digits.
* **PDF**: menu → تصدير PDF → whole tree or the selected branch, A4/A3/A2/A1/custom, auto/portrait/landscape, 150/300/400 DPI.
* **Backup**: menu → تنزيل نسخة احتياطية (JSON with photos). **Restore**: menu → استعادة (replaces everything).

---

## 8. Security summary

* Passwords: env secret compared in constant time; after changing, PBKDF2-SHA256 + random salt in D1.
* Sessions: HS256-signed token in an `HttpOnly; Secure; SameSite=Strict` cookie, 7 days; contains the password version, so a password change logs out every other device.
* Rate limiting: 5 failed logins per IP per 15 minutes (stored in D1).
* Authorization is checked server-side on every write endpoint; phone numbers are only sent to the admin.
* CSRF: same-origin `Origin` check + mandatory `X-Requested-With` header + SameSite=Strict.
* XSS: user text is only ever inserted with `textContent` / canvas `fillText`; strict CSP (`script-src 'self'`, no inline scripts, self-hosted font).
* Input validation: lengths, dates (no future dates, death after birth, parents born before children, marriage after births), genders, no marriage between siblings or ancestors/descendants, image magic bytes and size.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| "قاعدة البيانات غير مربوطة" | `database_id` in `wrangler.toml` is wrong or the deployment predates it. Fix it and redeploy. |
| `no such table: persons` | Run `migrations/0001_init.sql` in the D1 Console (or `npm run db:migrate`). |
| "لم يتم ضبط كلمة مرور المدير" | Add the `ADMIN_PASSWORD` secret, then **Retry deployment**. |
| Forgot the password you set in the app | D1 Console: `DELETE FROM settings WHERE key = 'password_hash'; UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'password_ver';` then log in with `ADMIN_PASSWORD`. |
| "محاولات كثيرة" | Wait 15 minutes, or D1 Console: `DELETE FROM login_attempts;` |
| Error 1102 (CPU limit) on login | Add variable `PBKDF2_ITERATIONS = 30000`, redeploy, change password again. |
| Photos look like JPEG instead of WebP | Older Safari cannot encode WebP; the app falls back to JPEG automatically (still ~100 KB). |
| PDF too large / slow on an old phone | Choose 150 DPI or A4. |
| Restore stopped midway | Retry with the same file. Uploads go to staging; live data is replaced only after validation and atomic commit. If the final response was lost, reload first to see whether commit succeeded. |
| Changes on GitHub not visible | Check Workers & Pages → project → Deployments for a failed build. |

---

## 10. Data model

* `persons`: one row per human. `father_id` / `mother_id` link to parents. Dates are stored as ISO Gregorian
  `YYYY-MM-DD` (first day of the known period) + `*_prec` (`y`/`m`/`d`) + `*_cal` (`g`/`j`, the calendar it was typed in).
* `marriages`: `husband_id`, `wife_id`, date, `status` (`married`/`divorced`), order. Multiple spouses supported.
* `photos`: base64 WebP/JPEG per person (≤ 180 KB enforced, ~100 KB produced).
* `settings`: site title, password hash/version, session secret, data version (ETag).
