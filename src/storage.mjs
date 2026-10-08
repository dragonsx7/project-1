import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const databasePath = join(root, 'data', 'fixpass.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath, { timeout: 5000 });
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;

  CREATE TABLE IF NOT EXISTS passports (
    id TEXT PRIMARY KEY CHECK(length(id) = 12),
    model TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY CHECK(length(id) = 12),
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('shop', 'seller')),
    wallet TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY CHECK(length(id) = 10),
    passport_id TEXT NOT NULL REFERENCES passports(id),
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    event_type TEXT NOT NULL CHECK(event_type IN ('repair', 'inspection')),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    organization TEXT NOT NULL,
    organization_role TEXT NOT NULL CHECK(organization_role IN ('shop', 'seller')),
    organization_wallet TEXT NOT NULL,
    performed_at TEXT NOT NULL,
    category TEXT NOT NULL,
    summary TEXT NOT NULL,
    parts TEXT NOT NULL DEFAULT '',
    salt TEXT NOT NULL,
    previous_hash TEXT,
    hash TEXT NOT NULL CHECK(length(hash) = 64),
    created_at TEXT NOT NULL,
    UNIQUE(passport_id, sequence)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS attestations (
    event_id TEXT PRIMARY KEY REFERENCES events(id),
    signature TEXT NOT NULL UNIQUE,
    authority TEXT NOT NULL,
    cluster TEXT NOT NULL CHECK(cluster = 'devnet'),
    verified_at TEXT NOT NULL,
    block_time INTEGER
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS events_no_update
  BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS events_no_delete
  BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS passports_no_update
  BEFORE UPDATE ON passports BEGIN SELECT RAISE(ABORT, 'passports are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS passports_no_delete
  BEFORE DELETE ON passports BEGIN SELECT RAISE(ABORT, 'passports are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS organizations_no_update
  BEFORE UPDATE ON organizations BEGIN SELECT RAISE(ABORT, 'organization profiles are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS organizations_no_delete
  BEFORE DELETE ON organizations BEGIN SELECT RAISE(ABORT, 'organization profiles are immutable'); END;
`);

const addPassport = db.prepare('INSERT INTO passports (id, model, created_at) VALUES (?, ?, ?)');
const addEvent = db.prepare(`INSERT INTO events
  (id, passport_id, sequence, schema_version, event_type, organization_id, organization, organization_role, organization_wallet, performed_at, category, summary, parts, salt, previous_hash, hash, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const lastEvent = db.prepare('SELECT sequence, hash FROM events WHERE passport_id = ? ORDER BY sequence DESC LIMIT 1');
const passportById = db.prepare('SELECT id, model, created_at FROM passports WHERE id = ?');
const organizationByWalletQuery = db.prepare('SELECT id, name, role, wallet, created_at FROM organizations WHERE wallet = ?');
const eventsByPassport = db.prepare(`SELECT e.*, p.model AS device_model, a.signature, a.authority, a.cluster, a.verified_at, a.block_time
  FROM events e JOIN passports p ON p.id = e.passport_id LEFT JOIN attestations a ON a.event_id = e.id
  WHERE e.passport_id = ? ORDER BY e.sequence ASC`);
const eventById = db.prepare(`SELECT e.*, p.model AS device_model, a.signature, a.authority, a.cluster, a.verified_at, a.block_time
  FROM events e JOIN passports p ON p.id = e.passport_id LEFT JOIN attestations a ON a.event_id = e.id WHERE e.id = ?`);
const addAttestation = db.prepare(`INSERT INTO attestations
  (event_id, signature, authority, cluster, verified_at, block_time) VALUES (?, ?, ?, ?, ?, ?)`);

function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function shapeEvent(row) {
  return {
    schemaVersion: row.schema_version,
    passportId: row.passport_id,
    deviceModel: row.device_model,
    entryId: row.id,
    sequence: row.sequence,
    type: row.event_type,
    shop: row.organization,
    organizationId: row.organization_id,
    organizationRole: row.organization_role,
    organizationWallet: row.organization_wallet,
    performedAt: row.performed_at,
    category: row.category,
    workSummary: row.summary,
    parts: row.parts,
    salt: row.salt,
    previousHash: row.previous_hash,
    hash: row.hash,
    createdAt: row.created_at,
    attestation: row.signature ? {
      signature: row.signature,
      authority: row.authority,
      cluster: row.cluster,
      verifiedAt: row.verified_at,
      blockTime: row.block_time
    } : null
  };
}

function saveEvent(passportId, event) {
  addEvent.run(event.entryId, passportId, event.sequence, event.schemaVersion, event.type,
    event.organizationId, event.shop, event.organizationRole, event.organizationWallet,
    event.performedAt, event.category, event.workSummary, event.parts, event.salt,
    event.previousHash, event.hash, event.createdAt);
  return event;
}

export function createPassport(passport, event) {
  return transaction(() => {
    addPassport.run(passport.id, passport.model, passport.createdAt);
    saveEvent(passport.id, event);
    return event;
  });
}

export function createOrganization(organization) {
  db.prepare('INSERT INTO organizations (id, name, role, wallet, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(organization.id, organization.name, organization.role, organization.wallet, organization.createdAt);
  return organization;
}

export function organizationByWallet(wallet) {
  return organizationByWalletQuery.get(wallet) ?? null;
}

export function appendEvent(passportId, buildEvent) {
  return transaction(() => {
    const passport = passportById.get(passportId);
    if (!passport) return null;
    const previous = lastEvent.get(passportId);
    const event = buildEvent(previous ? { sequence: previous.sequence + 1, hash: previous.hash } : { sequence: 1, hash: null }, passport.model);
    return saveEvent(passportId, event);
  });
}

export function getPassport(id) {
  const passport = passportById.get(id);
  if (!passport) return null;
  return {
    version: 1,
    id: passport.id,
    model: passport.model,
    createdAt: passport.created_at,
    entries: eventsByPassport.all(id).map(shapeEvent)
  };
}

export function getEvent(id) {
  const row = eventById.get(id);
  return row ? shapeEvent(row) : null;
}

export function saveAttestation({ eventId, signature, authority, verifiedAt, blockTime }) {
  return addAttestation.run(eventId, signature, authority, 'devnet', verifiedAt, blockTime ?? null);
}

export function closeStorage() {
  if (db.isOpen) db.close();
}
