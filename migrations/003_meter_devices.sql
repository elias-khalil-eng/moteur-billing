-- Remote-read meters, one per subscriber.
--
-- A device reports what the meter shows, on its own schedule. It never writes a
-- meter_readings row: a bill is still made from the reading a collector took and
-- an owner issued. The device proposes what the subscriber is using right now;
-- it does not decide what anybody owes.

create table meter_devices (
  id            bigserial primary key,
  subscriber_id bigint not null unique references subscribers(id),
  serial        text not null unique,
  -- Hashed like a PIN: shown once at registration, never readable afterwards.
  secret_hash   text not null,
  status        text not null default 'active' check (status in ('active', 'disabled')),
  installed_at  timestamptz not null default now(),
  last_seen_at  timestamptz
);

create table device_readings (
  id          bigserial primary key,
  device_id   bigint not null references meter_devices(id),
  value       integer not null check (value >= 0),
  taken_at    timestamptz not null,
  received_at timestamptz not null default now(),
  -- A device retrying a delivery must not create a second row for the same instant.
  unique (device_id, taken_at)
);

create index device_readings_latest_idx on device_readings (device_id, taken_at desc);
