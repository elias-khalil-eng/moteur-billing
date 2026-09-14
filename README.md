# Moteur billing

A billing system for a single neighbourhood generator in Lebanon. Metered billing,
priced in USD and paid in cash in either currency, run from a phone.

- **Staff** manage subscribers, enter meter readings on the route, issue bills, record
  cash, log expenses and read reports. The owner also answers service requests, writes
  to one subscriber or to all of them, and registers remote-read meters.
- **Subscribers** sign in with a subscriber number and a PIN to see what they owe, their
  usage over the last twelve cycles, their payments, and their alerts. They can file a
  service request, and where a remote-read meter is installed they see what they have
  used so far this cycle, priced at today's rate and labelled an estimate, not a bill.

Arabic is the default interface language, right to left, with an English toggle.

## Shape

One origin: a React client built to `client/dist`, and one Netlify function at `/api/*`.
The browser never computes money and never decides permissions. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layer contract,
[docs/DECISIONS.md](docs/DECISIONS.md) for the choices behind it, and
[docs/RUNBOOK.md](docs/RUNBOOK.md) for how to operate it.

## Getting started

```bash
docker run -d --name moteur-db -e POSTGRES_PASSWORD=moteur -e POSTGRES_USER=moteur \
  -e POSTGRES_DB=moteur_test -p 55432:5432 postgres:16-alpine
cp .env.example .env.test        # DATABASE_URL points at the container above
npm ci && npm --prefix client ci
npm run migrate
npm run seed -- --demo
npm test
```

`npm run serve` builds nothing on its own; build the client first, then it serves the
app and the API together on `http://localhost:8888`, the way Netlify does.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Unit and integration suites against a real Postgres |
| `npm run test:e2e` | Playwright smoke flows against the built app |
| `npm run lint` | oxlint plus TypeScript strict on both sides |
| `npm run migrate` | Applies pending migrations, forward only |
| `npm run seed -- --demo` | First owner, plus development data |
| `npm run backup` | Every table to timestamped JSON and CSV |
| `npm run restore <dir>` | Restores a backup into an empty database |

## License

MIT. See [LICENSE](LICENSE).
