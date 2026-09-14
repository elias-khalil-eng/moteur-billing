# Runbook

Everything the owner or whoever helps them needs to do, in the order they will need it.

## The monthly rhythm

1. **Open the cycle.** Staff → Cycle → Open a cycle. Enter the month (`2026-09`), the
   price per kWh in US cents, and the LBP rate. Only one cycle can be open at a time,
   so last month's must be issued and closed first.
2. **Read the meters.** Collectors use Staff → Meter route. Each entry saves as it is
   typed. A reading below the last one is refused with both numbers named; if the meter
   was replaced, tick *Meter replaced* and record the old meter's final value in the
   note. A reading far above the subscriber's usual usage asks for a confirm tap.
3. **Issue the bills.** Staff → Cycle → Issue bills. The dialog shows how many bills,
   the total in USD and LBP, and how many readings would be estimated. Issuing is one
   transaction and is safe to press twice.
4. **Collect.** Staff → Collect. Search the subscriber, choose USD or LBP, and record
   the cash. The LBP amount is pre-filled from the cycle rate, rounded to the nearest
   1,000, and stays editable.
5. **Close the cycle.** Staff → Cycle → Close cycle. Closing freezes the cycle for
   reporting. Payments against old bills still work afterwards: debt does not expire.

## Correcting a wrong reading

**Before the bills are issued** — the cycle is still open, so re-enter the value on the
route screen. It overwrites the old one. To remove a reading entirely, the owner can
delete it (`DELETE /api/cycles/:id/readings/:subscriberId`).

**After the bills are issued** — an issued bill never changes. Two options:

- If the cycle is still *issued* and not closed and the error is large, void the
  affected payments, and record an adjusting payment for the difference with a note
  explaining it. The audit log keeps both.
- If the reading was wildly wrong, correct the meter reading in the following cycle:
  the next reading's `previous_value` comes from the last recorded reading, so a
  correction there flows into the next bill.

Never edit a bill row by hand. The balance is derived from bills minus non-voided
payments, and hand edits leave no audit trail.

## Voiding a payment

Staff → Subscribers → the subscriber → the payment. Only the owner can void, and a
reason is required. The row stays, marked voided, and the balance goes back up.

## Resetting a PIN

Staff → Subscribers → the subscriber → New PIN. The new PIN appears once, with a copy
button and a printable slip. Writing it down at that moment is the only chance: only the
hash is stored. The reset also signs the subscriber out of every device.

## Adding or removing staff

Staff → Staff. Create a collector or another owner, deactivate an account that has left,
or set a new password. The last active owner cannot be demoted or deactivated.

## Backups

```bash
npm run backup                 # writes backups/<timestamp>/ with JSON and CSV per table
npm run restore backups/<dir>  # restores into an EMPTY database
```

`scripts/backup.ts` dumps every table to both JSON and CSV plus a `manifest.json` with
row counts. Supabase's own backups are the primary; this is the copy the owner controls.

**Schedule it.** On a machine that is on daily, a cron entry is enough:

```
0 2 * * * cd /path/to/moteur && DATABASE_URL=... npm run backup >> backup.log 2>&1
```

**Verify a restore before launch, and after any schema change.** The rehearsal:

1. Create an empty database (`createdb moteur_restore_test`).
2. `DATABASE_URL=postgres://.../moteur_restore_test npm run migrate`
3. `DATABASE_URL=postgres://.../moteur_restore_test npm run restore backups/<latest>`
4. Check the row counts it prints against `manifest.json`, and spot-check one
   subscriber's balance against the live system.

`restore` refuses to run against a database whose tables already hold rows, so it cannot
quietly double a live ledger.

## Deploying

The app is one Netlify site: the static client from `client/dist` and one function at
`/api/*`, on the same origin.

```
Build command:    npm ci && npm --prefix client ci && npm --prefix client run build
Publish directory: client/dist
Functions directory: netlify/functions
```

Environment variables, set in the Netlify UI (Site settings → Environment variables):

| Variable | What it is |
|---|---|
| `DATABASE_URL` | The Supabase connection string, pooled |
| `DATABASE_SSL_CA` | Optional. A provider CA certificate, if Node does not already trust the chain |
| `DATABASE_SSL_NO_VERIFY` | Optional. `true` turns off TLS verification to the database. Only as a deliberate, temporary exception - it logs a warning every time the pool opens |
| `JWT_SECRET` | A long random string. Changing it signs everyone out |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | From `npx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | `mailto:` and the owner's address |
| `APP_TIMEZONE` | `Asia/Beirut` |
| `DISCONNECT_THRESHOLD_USD_CENTS` | Balance at which a subscriber becomes a disconnect candidate |
| `OWNER_CONTACT_NAME` / `OWNER_CONTACT_PHONE` | Shown on the subscriber's home screen |
| `SEED_OWNER_USERNAME` / `SEED_OWNER_PASSWORD` | Only needed once, to create the first owner |

After the first deploy:

```bash
DATABASE_URL=... npm run migrate
DATABASE_URL=... SEED_OWNER_USERNAME=... SEED_OWNER_PASSWORD=... npm run seed
```

Then sign in as the owner and change that password from Staff → Staff.

## Running it locally

```bash
docker run -d --name moteur-db -e POSTGRES_PASSWORD=moteur -e POSTGRES_USER=moteur \
  -e POSTGRES_DB=moteur_test -p 55432:5432 postgres:16-alpine
npm ci && npm --prefix client ci
npm run migrate && npm run seed -- --demo
npm --prefix client run build && npx tsx scripts/serve.ts    # one origin on :8888
```

`npm test` runs the unit and integration suites against that database;
`npm run test:e2e` runs the Playwright smoke suite against the built app.

## Keeping the log tables from growing forever

`login_attempts` and `audit_log` are append-only and nothing prunes them. The audit
log is the record of every change to money and should be kept. The login table is only
needed for the fifteen minute rate-limit window, so trim it monthly, keeping ninety
days: that is what tells you afterwards whether someone spent a week guessing a
subscriber's PIN.

```sql
delete from login_attempts where created_at < now() - interval '90 days';
```

## When something is wrong

- **A collector says readings vanished.** They did not: unsent entries are kept in the
  browser and retried, and the route screen shows "N readings not saved" while any are
  pending. Check the phone has signal and tap *Send again*.
- **A subscriber cannot sign in.** Five failed attempts on one code block that code for
  fifteen minutes, correct PIN included. Wait, or reset the PIN.
- **Push alerts do not arrive on an iPhone.** Safari only delivers push to a site added
  to the home screen. The app shows those instructions before offering the toggle. The
  in-app inbox always works.
- **A 500 in the logs.** Every server error is logged with the route, the actor and a
  request id, and never with a PIN, a password or a token. Search the function log for
  the request id the client showed.

## Installing a remote-read meter

*More → Devices*, pick the subscriber, type the serial printed on the unit, and register
it. The secret is shown **once**; copy it into the device then, because it is stored only
as a hash and cannot be read back. Lost it: press *New secret*, which invalidates the old
one immediately.

The device reports on its own schedule:

```
POST /api/ingest/<serial>/readings
authorization: Device <secret>
content-type: application/json

{"value": 10432, "takenAt": "2026-09-10T09:00:00Z"}
```

- `value` is the meter counter as a whole number, 0 to 9,999,999.
- `takenAt` is optional; leave it out and the server stamps arrival. If sent, it must be
  within the last 7 days and no more than an hour ahead, so a device with a wrong clock
  is refused rather than reordering the history.
- A repeat of the same instant is accepted and stored once, so a device may retry freely.
- `202` means stored. `401` means the serial, the secret or the device's status is wrong.

Devices are per subscriber, one each. *Disable* stops a unit being believed without
deleting what it already reported, which is what to do when one is removed from a wall.
