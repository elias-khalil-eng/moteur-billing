# Decisions

Choices the build prompt left open, and the reason for each. Newest last.

## D1 — kWh is a whole-number integer, not hundredths

`meter_readings.kwh` and `bills.kwh` are integer whole kWh. The meters on this route
are mechanical and are read as whole kWh; introducing `kwhCentis` would add a scaling
factor to every arithmetic path and every display for precision the meters do not have.
If a digital meter with decimals is ever installed, the reading is rounded to whole kWh
at entry and the note records the exact figure.

## D2 — Money rounds halves away from zero

`divRoundHalfAwayFromZero` in `lib/money.ts` is the single rounding primitive.
`Math.round` rounds -0.5 to -0 (towards positive infinity), which would make a credit
balance round differently from the debit of the same size. Away-from-zero keeps the two
symmetric, so converting a balance to LBP and back does not drift by direction.

## D3 — Only one open cycle, enforced by a partial unique index

`create unique index one_open_cycle on billing_cycles ((status)) where status = 'open'`.
A read-then-write check in application code loses to a double submit; the index cannot.
The domain layer still checks first so the user gets a clear message rather than a
constraint violation.

## D4 — `pg` parses int8 and numeric as JavaScript numbers

By default `pg` returns `bigint` and `numeric` as strings to avoid precision loss. Every
`bigint` in this schema is an id or an integer amount well inside `Number.MAX_SAFE_INTEGER`
(the largest realistic figure is an LBP total, around 10^11), and the one `numeric` column
is `liters`. Parsing both to number keeps the domain layer free of string-to-number casts,
which is exactly where a `parseFloat` on money would eventually creep in.

## D5 — Arrears ages count Beirut calendar days

`daysBetween` in `lib/dates.ts` counts whole Beirut calendar days rather than 24-hour
spans. "This bill is 31 days old" then matches what the owner counts on a wall calendar,
and a DST change cannot move a bill between buckets.

## D6 — Integration tests run against Postgres in Docker

`docker run --name moteur-test-db -p 55432:5432 postgres:16-alpine`, with the connection
string in `.env.test`. The alternative, an in-process Postgres substitute, would not
exercise the constraints and the transaction that the billing logic depends on.

## D7 — The API function is a plain Web `Request`/`Response` handler

`netlify/functions/api.ts` exports a default `(req: Request) => Promise<Response>`, which
is the Netlify Functions v2 signature. Integration tests call that function directly with
a real `Request`, so the tests exercise the same routing, auth and role gate that
production does, with no HTTP server in between.

## D8 — Domain modules split when they pass ~300 lines

`subscribers.ts` kept validation and writes; `subscriber-queries.ts` took the list and
detail read models. `readings.ts` kept the rules (kWh derivation, the outlier test);
`reading-entry.ts` took the writes and the route query. The build prompt names one file
per domain, and §17 asks for a split past roughly 300 lines; the split follows the
seam the prompt itself draws between rules and queries.

## D9 — Generated PINs are six digits

A four digit PIN is a 10,000 wide space. Six digits is 1,000,000 wide, costs the
subscriber two extra taps once, and is still a number they can write on a slip.
Sign in accepts 4 to 6 digits so an older PIN still works.

## D10 — Reading entries are queued in localStorage, not only in memory

A collector who loses signal, or whose phone reloads the tab, keeps every number they
typed. The queue retries on a timer and on the browser's `online` event. A 4xx other
than 408 or 429 is treated as permanent and surfaced on the row, because retrying it
would never succeed — the outlier warning is exactly that case, and it carries the
confirm action.

## D11 — An issue-preview endpoint, so the browser never computes money

Section 10 asks the Issue action to show a confirmation summary: how many bills, the
total in USD and LBP, and how many readings would be estimated. Those figures cannot
be computed in the browser without breaking the rule that the browser never computes
money, and they cannot come from the issue response because the confirmation happens
first. `GET /api/cycles/:id/issue-preview` (owner) computes them server-side and
writes nothing. It is the only route added beyond section 9, plus `GET /api/config`,
which serves the owner contact line the subscriber Home screen shows.

## D12 — Notification rows are written by the issue transaction

Section 7 puts "insert one notifications row per subscriber" inside the issue
transaction, so `lib/notify.ts` exists from phase 5 with the row writer and the
bilingual text builders. Phase 7 adds push dispatch on top, outside the transaction.

## D13 — Arrears ages debt by allocating payments oldest first

A payment is applied to the balance, not to a named bill, so aging that balance needs
a rule. `allocateArrears` clears the oldest bill first, which is what happens at the
door and what makes "this subscriber has three unpaid cycles" mean something. A
subscriber is a disconnect candidate when their balance reaches
`DISCONNECT_THRESHOLD_USD_CENTS` or three cycles are unpaid.

## D14 — The subscriber detail carries the balance in LBP

The Collect screen pre-fills the LBP amount, and the browser must not convert money.
`GET /api/subscribers/:id` therefore returns `balanceLbp`, converted with the rate of
the cycle in force and rounded to the nearest thousand, plus the `lbpRate` used, which
the client sends back as `lbpRateUsed` when the payment is taken in LBP.

## D15 — Typed dollar amounts become cents by string arithmetic

`parseUsdToCents` in `client/src/lib/format.ts` parses "8.35" into 835 by splitting on
the decimal point, never by multiplying a float: `8.35 * 100` is 834.9999999999999.
This is the only place the client turns typed text into a monetary integer, and it is
covered by its own tests.

## D16 — Derived rates are integers on a finer scale, not floats

Cost per kWh is reported as `costPerKwhCentis`, hundredths of a cent, and the
collection rate as `collectionRateBasisPoints`. A whole-cent cost would be too coarse
to compare against a price of 30 cents, and a float has no business anywhere near
money. The client divides by 100 only to render them.

## D17 — The owner dashboard composes existing endpoints

Section 10's dashboard needs the open cycle, its reading progress, this period's
billed, collected and expenses, and the outstanding balance. Every one of those is
already an endpoint, so the dashboard reads four of them rather than adding a
fifth that would duplicate their logic.

## D18 — Errors carry both languages, in the response

An error that a person is meant to read carries `messageAr` alongside `message`.
`toErrorBody` lifts it out of `details` so `details` stays machine-readable, and the
client's `ApiError.localized(language)` picks the right one. This covers the messages
that actually reach a reader mid-task: wrong sign in details, a reading below the last
one, a replaced meter with no note, the outlier warning, missing readings at issue,
and the cycle-state refusals.

## D19 — The dictionaries are tested, not just written

`tests/unit/i18n.test.ts` asserts that both dictionaries carry exactly the same keys,
that no value is empty, that no Arabic value was left as its English text, that every
Arabic value actually contains Arabic letters, and that placeholders match across the
pair. A half-translated screen fails the build rather than reaching a subscriber.

## D20 — A local one-origin server, instead of the Netlify CLI, for E2E

`scripts/serve.ts` serves `client/dist` and mounts the same `/api/*` handler on one
origin, with the SPA fallback last, which is exactly the shape `netlify.toml` describes.
Playwright drives that, so the smoke flows exercise real routing and a real database
without depending on the Netlify CLI being installed and logged in. The same script is
what `npm run dev:api` runs behind the Vite dev proxy.

## D21 — Restore refuses a database that is not empty

`scripts/restore.ts` checks every table for rows before it inserts anything, and resets
each sequence past the restored ids. A restore run against a live database by mistake
would otherwise duplicate a ledger that is supposed to be append-only.

## D22 — A request is answered by a person, and the answer is written down

A subscriber files a service request; the owner moves it through `open → in_progress →
resolved | rejected` and may attach a note. Every move writes a notification back, so a
request never goes quiet on the person who filed it: silence is what makes them phone
instead, and the written record stops being the truth. `resolved` and `rejected` are
terminal — a new problem is a new request, not a reopened one — and five requests still
waiting is the cap per subscriber, so one person cannot bury everyone else's.

## D23 — The owner's message is stored as written, in both language columns

D18 and D19 cover strings the software owns: those must exist in Arabic and in English.
A message the owner typed is not one of those. It goes into `title_ar`/`title_en` and
`body_ar`/`body_en` exactly as written, in whichever language they wrote it, because a
machine-made Arabic no one wrote reads worse than the real sentence and cannot be
corrected by the person who sent it.

## D24 — A device proposes, the collector's reading decides

A remote-read meter writes `device_readings` and never `meter_readings`. Bills are still
made from the reading a collector took and an owner issued. So the subscriber's home
screen can say "375 kWh so far, about $97.50" and label it an estimate, while a device
that is broken, swapped or lying costs an argument rather than money. Where the device
reads below the last official value — a replaced meter, or a counter that rolled over —
no figure is shown at all, since a negative or wrapped number is worse than none.
