/**
 * Seeds the first owner account from the environment. With --demo it also creates
 * a development data set: subscribers, past cycles, readings, bills and payments.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query, closePool } from '../lib/db.js';
import { hashSecret, generatePin } from '../lib/auth.js';

export async function seedOwner(): Promise<{ id: number; username: string } | null> {
  const username = process.env.SEED_OWNER_USERNAME;
  const password = process.env.SEED_OWNER_PASSWORD;
  if (!username || !password) {
    console.log('SEED_OWNER_USERNAME or SEED_OWNER_PASSWORD is not set; skipping owner seed');
    return null;
  }
  const existing = await query<{ id: number }>('select id from staff where username = $1', [
    username,
  ]);
  if (existing[0]) {
    console.log(`owner ${username} already exists`);
    return { id: existing[0].id, username };
  }
  const rows = await query<{ id: number }>(
    `insert into staff (username, password_hash, name, role)
     values ($1, $2, $3, 'owner') returning id`,
    [username, await hashSecret(password), username],
  );
  console.log(`created owner ${username}`);
  return { id: rows[0]!.id, username };
}

const ZONES = ['A', 'B', 'C', 'D'];
const NAMES = [
  'Sami Haddad', 'Rania Khoury', 'Georges Aoun', 'Nour Saad', 'Karim Fares',
  'Layla Nassar', 'Elias Rizk', 'Maya Chidiac', 'Ziad Mansour', 'Hala Abou Zeid',
];

export async function seedDemoSubscribers(count = 40): Promise<number[]> {
  const ids: number[] = [];
  const pinHash = await hashSecret('123456');
  // Sequential on purpose: this is a one-off development script, not a hot path.
  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < count; i++) {
    const code = String(1000 + i);
    const name = `${NAMES[i % NAMES.length]!} ${Math.floor(i / NAMES.length) + 1}`;
    const zone = ZONES[i % ZONES.length]!;
    const rows = await query<{ id: number }>(
      `insert into subscribers (code, pin_hash, name, zone, meter_serial, phone)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (code) do nothing
       returning id`,
      [code, pinHash, name, zone, `M-${code}`, `03${String(100000 + i)}`],
    );
    if (rows[0]) ids.push(rows[0].id);
  }
  /* eslint-enable no-await-in-loop */
  console.log(`created ${ids.length} demo subscribers, all with PIN 123456`);
  return ids;
}

async function main(): Promise<void> {
  await seedOwner();
  if (process.argv.includes('--demo')) {
    const subscriberIds = await seedDemoSubscribers();
    const { seedDemoHistory } = await import('./seed-demo.js');
    await seedDemoHistory(subscriberIds);
  }
  console.log(`a fresh PIN looks like ${generatePin()}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then(() => closePool())
    .catch(async (err: unknown) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
