// Exercises scripts/ring-sync/ring_sync.py's discover_fields_from_db()
// against real-world SQLite schemas by actually running the shipped Python
// script (not a JS reimplementation of its logic, which could drift from
// what's really deployed) via `python3 -c`, and parsing its JSON stdout.
//
// This guards a real bug found live: the colmi_r02_client CLI's synced
// database names its heart-rate table's primary key 'heart_rate_id', which
// contains the 'heart_rate' keyword as a substring — the original matcher
// picked that ID column as the "value", which would have sent a database
// row number to the dashboard as if it were a BPM reading. is_id_column()
// now excludes any column named 'id' or ending in '_id' from ever being
// treated as a sensor value, regardless of keyword substring matches.

import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const scriptDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ring-sync');

// Runs discover_fields_from_db() against a fresh SQLite db built from the
// given CREATE TABLE statements + INSERT rows, returns { payload, discovery }.
function runDiscovery(createStatements, insertStatements) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'ring-sync-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    const pyScript = `
import sqlite3, sys, json
sys.path.insert(0, ${JSON.stringify(scriptDir)})
import ring_sync

conn = sqlite3.connect(${JSON.stringify(dbPath)})
cur = conn.cursor()
${createStatements.map(s => `cur.execute(${JSON.stringify(s)})`).join('\n')}
${insertStatements.map(s => `cur.execute(${JSON.stringify(s)})`).join('\n')}
conn.commit()
conn.close()

payload, discovery = ring_sync.discover_fields_from_db(${JSON.stringify(dbPath)}, verbose=False)
print(json.dumps({'payload': payload, 'discovery': discovery}))
`;
    const result = spawnSync('python3', ['-c', pyScript], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('python3 failed: ' + result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').pop());
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ==================== the real bug: heart_rate_id primary key ====================
{
  const { payload, discovery } = runDiscovery(
    [
      `CREATE TABLE heart_rates (
        heart_rate_id INTEGER NOT NULL, reading INTEGER NOT NULL, timestamp DATETIME NOT NULL,
        ring_id INTEGER NOT NULL, sync_id INTEGER NOT NULL, PRIMARY KEY (heart_rate_id)
      )`,
      `CREATE TABLE sport_details (
        sport_detail_id INTEGER NOT NULL, calories INTEGER NOT NULL, steps INTEGER NOT NULL,
        distance INTEGER NOT NULL, timestamp DATETIME NOT NULL, ring_id INTEGER NOT NULL,
        sync_id INTEGER NOT NULL, PRIMARY KEY (sport_detail_id)
      )`,
    ],
    [
      "INSERT INTO heart_rates VALUES (1, 58, '2026-08-10 08:00:00', 1, 1)",
      "INSERT INTO heart_rates VALUES (2, 72, '2026-08-11 09:00:00', 1, 1)",
      "INSERT INTO sport_details VALUES (1, 120, 3400, 2500, '2026-08-10 08:00:00', 1, 1)",
      "INSERT INTO sport_details VALUES (2, 200, 8123, 6000, '2026-08-11 09:00:00', 1, 1)",
    ],
  );
  assertEq(discovery.heartRate.column, 'reading', 'heartRate matches the real value column ("reading"), not the "heart_rate_id" primary key it shares a keyword substring with');
  assertEq(discovery.steps.column, 'steps', 'steps still matches its own directly-named column, unaffected by the id-exclusion fix');
  assertEq(payload.heartRate, 72, 'the extracted heartRate is the actual latest BPM reading (72), not a row id (2)');
  assertEq(payload.steps, 8123, 'the extracted steps is the actual latest step count');
}

// ==================== a directly keyword-named value column still matches (no over-correction) ====================
{
  const { payload, discovery } = runDiscovery(
    [`CREATE TABLE hr_log (
        hr_log_id INTEGER NOT NULL, bpm INTEGER NOT NULL, recorded_at DATETIME NOT NULL,
        PRIMARY KEY (hr_log_id)
      )`],
    ["INSERT INTO hr_log VALUES (1, 65, '2026-08-11 09:00:00')"],
  );
  assertEq(discovery.heartRate.column, 'bpm', 'a column literally named "bpm" still matches correctly even when an unrelated _id column sits alongside it');
  assertEq(payload.heartRate, 65, 'the extracted value comes from the real bpm column');
}

// ==================== a table with only id/timestamp columns (no real value) correctly reports unmatched ====================
{
  const { discovery } = runDiscovery(
    [`CREATE TABLE heart_rates (heart_rate_id INTEGER NOT NULL, timestamp DATETIME NOT NULL, ring_id INTEGER NOT NULL, PRIMARY KEY (heart_rate_id))`],
    ["INSERT INTO heart_rates VALUES (1, '2026-08-11 09:00:00', 1)"],
  );
  assertTrue(discovery.heartRate.matched === false, 'a table with no non-id, non-timestamp column at all is honestly reported as unmatched rather than guessing an id column');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
