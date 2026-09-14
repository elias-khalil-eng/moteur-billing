-- Service requests a subscriber writes, and messages the owner writes back.
--
-- A request is the subscriber's only way to ask for something in writing. The owner
-- answers by moving its status and leaving a note, and every move sends the subscriber
-- a notification, so a request never goes quiet on the person who filed it.

create table service_requests (
  id            bigserial primary key,
  subscriber_id bigint not null references subscribers(id),
  kind          text not null
                check (kind in ('meter_issue','new_connection','disconnect',
                                'billing_question','other')),
  body          text not null,
  status        text not null default 'open'
                check (status in ('open','in_progress','resolved','rejected')),
  owner_note    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz,
  closed_by     bigint references staff(id)
);

-- The owner's queue reads by status and age; a subscriber reads their own, newest first.
create index service_requests_queue_idx on service_requests (status, created_at desc);
create index service_requests_subscriber_idx on service_requests (subscriber_id, created_at desc);

-- created_by separates a message the owner typed from one the system generated:
-- null means the system wrote it. request_id links a status update back to its request.
alter table notifications
  add column created_by bigint references staff(id),
  add column request_id bigint references service_requests(id);
