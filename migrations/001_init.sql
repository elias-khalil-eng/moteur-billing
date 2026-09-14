-- Moteur billing system, initial schema.
-- Money is integer only: USD as cents, LBP as whole LBP. No numeric/float column
-- ever holds an amount. Every timestamp is timestamptz written in UTC.

create table staff (
  id            bigserial primary key,
  username      text not null unique,
  password_hash text not null,
  name          text not null,
  role          text not null check (role in ('owner','collector')),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table subscribers (
  id            bigserial primary key,
  code          text not null unique,              -- login identifier, numeric string
  pin_hash      text not null,
  token_version integer not null default 1,        -- bump to revoke issued tokens
  name          text not null,
  phone         text,
  zone          text,
  address       text,
  meter_serial  text,
  status        text not null default 'active'
                check (status in ('active','suspended','disconnected')),
  notes         text,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index on subscribers (status) where deleted_at is null;
create index on subscribers (zone);

create table billing_cycles (
  id                bigserial primary key,
  period            text not null unique,          -- 'YYYY-MM'
  usd_per_kwh_cents integer not null check (usd_per_kwh_cents > 0),
  lbp_rate          integer not null check (lbp_rate > 0),
  status            text not null default 'open'
                    check (status in ('open','issued','closed')),
  opened_at         timestamptz not null default now(),
  issued_at         timestamptz,
  closed_at         timestamptz,
  opened_by         bigint not null references staff(id)
);

-- At most one open cycle at a time, enforced by the database rather than by a read-then-write.
create unique index one_open_cycle on billing_cycles ((status)) where status = 'open';

create table meter_readings (
  id             bigserial primary key,
  subscriber_id  bigint not null references subscribers(id),
  cycle_id       bigint not null references billing_cycles(id),
  previous_value integer not null,
  current_value  integer not null,
  kwh            integer not null check (kwh >= 0),
  is_estimated   boolean not null default false,
  meter_reset    boolean not null default false,
  read_at        timestamptz not null default now(),
  entered_by     bigint not null references staff(id),
  note           text,
  unique (subscriber_id, cycle_id)
);
create index on meter_readings (cycle_id);

create table bills (
  id                bigserial primary key,
  subscriber_id     bigint not null references subscribers(id),
  cycle_id          bigint not null references billing_cycles(id),
  kwh               integer not null,
  usd_per_kwh_cents integer not null,
  amount_usd_cents  integer not null check (amount_usd_cents >= 0),
  lbp_rate          integer not null,
  amount_lbp        bigint not null,
  issued_at         timestamptz not null default now(),
  unique (subscriber_id, cycle_id)
);
create index on bills (subscriber_id, issued_at desc);
create index on bills (cycle_id);

create table payments (
  id               bigserial primary key,
  subscriber_id    bigint not null references subscribers(id),
  amount_usd_cents integer not null check (amount_usd_cents > 0),
  paid_currency    text not null check (paid_currency in ('USD','LBP')),
  amount_lbp       bigint,                          -- required when paid_currency = 'LBP'
  lbp_rate_used    integer,                         -- required when paid_currency = 'LBP'
  paid_at          timestamptz not null default now(),
  received_by      bigint not null references staff(id),
  note             text,
  voided_at        timestamptz,
  voided_by        bigint references staff(id),
  void_reason      text,
  created_at       timestamptz not null default now(),
  constraint lbp_payment_carries_its_rate check (
    paid_currency <> 'LBP' or (amount_lbp is not null and lbp_rate_used is not null)
  )
);
create index on payments (subscriber_id) where voided_at is null;
create index on payments (paid_at);
create index on payments (received_by, paid_at);

create table expenses (
  id               bigserial primary key,
  category         text not null check (category in ('diesel','maintenance','salary','other')),
  amount_usd_cents integer not null check (amount_usd_cents > 0),
  liters           numeric(10,2),                   -- diesel only
  vendor           text,
  spent_at         date not null,
  entered_by       bigint not null references staff(id),
  note             text,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index on expenses (spent_at);

create table notifications (
  id            bigserial primary key,
  subscriber_id bigint not null references subscribers(id),
  type          text not null,                     -- 'bill_issued' | 'payment_recorded'
  title_ar      text not null,
  title_en      text not null,
  body_ar       text not null,
  body_en       text not null,
  bill_id       bigint references bills(id),
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index on notifications (subscriber_id, created_at desc);

create table push_subscriptions (
  id            bigserial primary key,
  subscriber_id bigint not null references subscribers(id),
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  failed_count  integer not null default 0
);
create index on push_subscriptions (subscriber_id);

create table audit_log (
  id          bigserial primary key,
  actor_type  text not null check (actor_type in ('staff','subscriber','system')),
  actor_id    bigint,
  action      text not null,
  entity      text not null,
  entity_id   bigint,
  before_data jsonb,
  after_data  jsonb,
  created_at  timestamptz not null default now()
);
create index on audit_log (entity, entity_id, created_at desc);

create table login_attempts (
  id          bigserial primary key,
  identifier  text not null,                       -- subscriber code or staff username
  kind        text not null check (kind in ('staff','subscriber')),
  succeeded   boolean not null,
  ip          text,
  created_at  timestamptz not null default now()
);
create index on login_attempts (identifier, created_at desc);
create index on login_attempts (ip, created_at desc);

-- Balance is derived, never stored. The view exists so list screens join once
-- instead of issuing a query per subscriber.
create view subscriber_balances as
select s.id as subscriber_id,
       coalesce(b.billed_usd_cents, 0) as billed_usd_cents,
       coalesce(p.paid_usd_cents, 0)   as paid_usd_cents,
       coalesce(b.billed_usd_cents, 0) - coalesce(p.paid_usd_cents, 0) as balance_usd_cents
from subscribers s
left join (
  select subscriber_id, sum(amount_usd_cents)::bigint as billed_usd_cents
  from bills group by subscriber_id
) b on b.subscriber_id = s.id
left join (
  select subscriber_id, sum(amount_usd_cents)::bigint as paid_usd_cents
  from payments where voided_at is null group by subscriber_id
) p on p.subscriber_id = s.id;
