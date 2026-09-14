/**
 * Loads .env.test before any test module reads process.env. Kept deliberately tiny:
 * a real dotenv dependency is not worth it for a four-line file.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const envFile = path.join(process.cwd(), '.env.test');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!;
    }
  }
}
process.env.NODE_ENV = 'test';
