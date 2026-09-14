# Architecture

## Shape

One origin serves everything: the static client from `client/dist` and a single
Netlify function mounted at `/api/*`. There is no second service and no direct
database access from the browser.

```
phone browser
   |
   |  static assets            /api/*
   v                              v
Netlify CDN  ------------> netlify/functions/api.ts
                                  |
                                  v
                             lib/* domain
                                  |
                                  v
                              lib/db.ts
                                  |
                                  v
                        PostgreSQL (Supabase)
```

## Layer contract

| Layer | Owns | Must never |
|---|---|---|
| `netlify/functions/api.ts` | Path matching, method, status codes, auth, role gate | Contain SQL or business rules |
| `lib/<domain>.ts` | Validation and business rules | See a `Request`, `Response` or `URL` |
| `lib/db.ts` | Pool, query execution, transactions | Know what a bill or a cycle is |
| `client/src/lib/api.ts` | Every `fetch` the client makes | Be bypassed by a component calling `fetch` |

Two rules follow from this and are worth stating plainly:

- **The browser never computes money.** Every amount displayed comes from the server.
- **The browser never decides permissions.** Hiding a nav item is presentation; the
  server returns 403 whether or not the item was hidden.

## Money

USD is integer cents, LBP is integer LBP, `lbpRate` is integer LBP per USD. `lib/money.ts`
is the only module that divides, and it divides with an integer primitive. No monetary
value is ever a float, and `parseFloat` never touches one.

## Time

Every timestamp column is `timestamptz` written in UTC. Every business boundary — a
billing month, a collector's day, the age of a bill — is a Beirut wall-clock boundary
resolved in `lib/dates.ts`. A billing period is the string `YYYY-MM` and is the business
identity of a cycle; it is never re-derived from a timestamp at read time.

## Immutability

Money is append-only. Payments are voided, never deleted. Issued bills never change:
a wrong bill is corrected by an adjusting payment, or by voiding and reissuing while the
cycle is still open. Subscribers and expenses are soft-deleted. Balance is derived from
bills minus non-voided payments and is never stored.
