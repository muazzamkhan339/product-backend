# School Management SaaS Upgrade

## Start on Windows
1. Extract the ZIP.
2. Install Node.js LTS from https://nodejs.org/ if it is not already installed.
3. Open the extracted `school-saas-fix` folder in File Explorer.
4. Click the address bar, type `cmd`, and press Enter.
5. Run `npm install` (this project currently uses Node.js built-ins, so npm may not create a `node_modules` folder).
6. Run `npm start` and keep the Command Prompt open.
7. Open the school app at http://127.0.0.1:8787/ or the Super Admin at http://127.0.0.1:8787/super-admin.

## Default Super Admin login
- Username: `admin`
- Password: `CHANGE-ME-NOW`

Change these before real use by setting `SUPER_ADMIN_USER` and `SUPER_ADMIN_PASSWORD` environment variables before starting the server. Do not expose this server to the public internet with the default credentials.

## Included in this update
- Super Admin-only school creation (no public self-registration button; the bridge hides the Register Now control in the existing bundled UI).
- Add New School form with school information, administrator contact, login username, password confirmation, Active/Locked account status, and subscription plan/date/payment settings.
- Automatically generated school ID when the field is left blank; duplicate School IDs and usernames are rejected.
- School account passwords are stored as salted scrypt hashes and never returned in the school list/API responses.
- Server endpoint `POST /api/school/login` checks credentials, account lock/block status, and subscription/payment status.
- Super Admin can edit school details, lock/unlock accounts, renew subscriptions, and reset school passwords.
- Monthly, Yearly, and Free plans; default renewal lengths are 30 days, 365 days, and 100 years for Free respectively.

## Important integration limitations
This remains a transition build, not a production-ready multi-tenant SaaS product. The school login form is now connected to `POST /api/school/login`, so credentials created by Super Admin are checked against the central server. Successful login opens a school-specific local storage namespace keyed by its School ID. However, the original school application data operations remain browser-local and have not yet been fully converted to server-issued tenant sessions. Therefore, do not use this build to store multiple real schools' sensitive records on one shared installation until tenant isolation is completed and tested. Hiding the Register Now button is a UI restriction, not a substitute for server-side access control.

The current central data store is `server/data.json`; it is a starter JSON store, not a production database. For production, use PostgreSQL/MySQL, HTTPS, rate limiting, CSRF/CORS controls appropriate to the deployment, secure secret storage, backups, MFA for Super Admin, and a signed desktop updater. Keep `server/private.pem` secret and never publish it.

Offline note: a computer with no internet cannot learn immediately that a subscription has been revoked. The offline app can use cached signed licenses until their expiry; immediate blocking requires connectivity.


## School login fix in this build
- Create the school in Super Admin and set its login username and password (password must be at least 8 characters).
- Start the Node server and open the school application through `http://127.0.0.1:8787/` (do not open `app/index.html` directly).
- Sign in using the exact school username and password created in Super Admin. The app now calls `/api/school/login` rather than checking only the browser's old local `hps:accounts` list.
- If the server is hosted at a different address, set localStorage key `saas_api_url` to the full API base URL, for example `https://your-domain.example/api`, before logging in. The server must be reachable by the school computer.
- This fixes credential verification and school-specific local storage namespacing, but it does **not** yet provide complete cloud multi-tenant data isolation; finish and test that before using real school records in a shared production deployment.

## Update system (Super Admin → Updates)
1. Build the package from the files you changed (they must be inside `app/`):
   `node server/tools/make-update.js my-update.json app/feature.html app/feature.js`
2. In Super Admin → Updates → Create Update, enter the title and description, choose the update type, optionally a version, select the file (or drag it in), and choose the target: All Schools, one school, or several.
3. **Save Draft** stores the update without releasing it. Drafts can be edited or deleted. **Publish Update** releases it to the selected schools only.
4. A school sees "A New Update Is Available" when it signs in with internet access. **Update Now** downloads the package, verifies its signature and SHA-256 checksum, backs up the files it will replace, and writes them. If any step fails, the files are restored. **Later** hides the notice until the next launch. Installed updates are not offered again.

Limits of this build: packages may only add or replace files under `app/` (no `server/` files and no database migrations, which are refused). Installation runs on the school computer through the local server, so the central server must not be the only place the app runs. Update packages are JSON, not zip files. Updates are not mandatory, and the "Superseded" status is not implemented.

## Menu configuration updates (hps-config-1)
Use this to hide, show, or rename existing sidebar items for one school without changing its data.

```json
{
  "format": "hps-config-1",
  "operations": [
    { "op": "hide", "feature": "library" },
    { "op": "show", "feature": "library" },
    { "op": "relabel", "feature": "reports", "label": "Fee Reports" }
  ]
}
```

Features: dashboard, staff, students, attendance, idcards, fees, exams, results, certificates, library, expenses, reports, settings. Dashboard and Settings cannot be hidden. Labels are 1 to 40 characters with no < or >. Up to 50 operations.

Publish it in Super Admin → Updates → Create Update, target one or more schools, and publish. The school sees the notice at login and applies it with Update Now. Changes apply only to the target school and are stored on the server, so they survive restarts and the school keeps the last known setup offline. Rollback restores the previous setup (Updates → View → Roll back). Hiding a menu item hides the screen only; no records are deleted.

## HTML feature updates (Super Admin → Updates → Create Update, .html file)
Upload a self-contained `.html` file. It is installed only for the target school(s) and appears as a new sidebar item after **Update Now** and a reload.

Rules the server enforces: no `<iframe>`, `<object>`, `<embed>`, `<base>` or `<frame>`; no external `src` or `href` links; no `<meta http-equiv="refresh">` or Content-Security-Policy tags; at most 20 MB.

How the feature runs: inside a sandboxed frame with no access to the school's records, login, subscription checks, or the network. Its data is saved on the server per school and per feature through `hps.storage.get(key)`, `hps.storage.set(key, value)`, and `hps.storage.remove(key)` (keys up to 64 letters, numbers, dots, dashes or underscores; values up to 64 KB; 100 keys per feature).

Removing a feature from a school (Updates → View → Remove feature) hides it and blocks its storage; the saved data is kept. Reinstalling the same update is not offered; publish a new update instead. A new version gets its own storage, so existing data is not carried over automatically.

## Full application updates (one school at a time)
Use this when a school asks you to add or remove sections. Make the change in your project's `app/index.html`, then upload that file in Super Admin → Updates → Create Update, choose only that school, and publish.

- The file must be built from the current project, with the central school login. Old files that use the local-account login are rejected with a message.
- If the bridge line (subscription and update checks) is missing, the server adds it.
- The school sees "A New Update Is Available" at login and clicks **Update Now**. The new application is installed on that school's computer only, and the change appears after reloading.
- Limit: 18 MB per application file.
- Rollback for full application updates is not yet a button in Super Admin. The school computer keeps a backup of the replaced file in `server/backups`.

## Offline rules
- The school's license is saved after each successful online check and is signed by the server.
- Offline, the app keeps working while the saved license is Active, its expiry date has not passed, and the school last connected within 7 days (`OFFLINE_GRACE_DAYS` in `server/bridge.js`).
- If the subscription has ended, offline use stops and the school is asked to connect and renew.
- If the computer's date has been set back by more than 5 minutes since the app last connected, offline use stops until the school connects.
- Limit: these rules rely on the computer's clock and on files stored on the school's computer. Only an online check can enforce a Super Admin block immediately.
