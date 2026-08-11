#!/usr/bin/env python3
"""
Reads the Colmi R02 (or similar) smart ring over Bluetooth via the
tahnok/colmi_r02_client CLI and POSTs whatever it finds to this dashboard's
/api/ring-ingest endpoint. Meant to be run periodically by launchd (see
com.fern.ringsync.plist) on a Mac that's near the ring often enough to be
worth polling (e.g. overnight by the bed, or at a desk during the day) —
see SETUP.md's "Ring" section for the honest limits of that.

Why this script introspects the SQLite schema instead of hardcoding table
and column names: the CLI's `sync` command writes ring data to a local
SQLite database, but this machine could not reach the client's full docs
site (tahnok.github.io) to confirm the exact schema — network policy in
that environment blocked it. Guessing column names and shipping that as if
verified would risk silently reading the wrong numbers into your health
data. Instead this does real, keyword-based discovery every run and prints
exactly what it found — ALWAYS do a `--dry-run --verbose` run first and
check the printed values against Colmi's own app before trusting this
unattended.

Usage:
  python3 ring_sync.py --scan                     # one-time: find your ring's BLE address
  python3 ring_sync.py --dry-run --verbose         # see what it would read/send, without sending
  python3 ring_sync.py                             # real run (reads config.json)
"""

import argparse
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
import urllib.error

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, 'config.json')
LOG_PATH = os.path.join(SCRIPT_DIR, 'ring_sync.log')

# Every field this script might extract, and the keywords it looks for
# in table/column names to identify which column holds it. Ordered by
# how specific the keyword is, to avoid e.g. "steps" table matching a
# "footsteps_enabled" boolean column.
FIELD_KEYWORDS = {
    'heartRate': ['heart_rate', 'heartrate', 'heart', 'hr', 'bpm'],
    'steps': ['step'],
    'spo2': ['spo2', 'spo_2', 'oxygen', 'blood_oxygen'],
    'sleepHours': ['sleep'],
    'stress': ['stress'],
    'battery': ['battery', 'batt'],
}
TIMESTAMP_COLUMN_HINTS = ['timestamp', 'time', 'date', 'ts', 'created_at', 'recorded_at']


def is_id_column(name):
    """True for a primary/foreign-key column (e.g. 'heart_rate_id', 'id',
    'ring_id') — these should never be picked as a sensor value even when
    their name happens to contain a field's keyword (a 'heart_rates' table's
    own 'heart_rate_id' primary key is exactly this trap: it contains
    'heart_rate' as a substring but holds a row number, not a BPM reading)."""
    n = name.lower()
    return n == 'id' or n.endswith('_id')

# Common locations the CLI's `sync` command might write its SQLite database
# to — this list is a best-effort search, not a verified default, since the
# docs site with the confirmed default path was unreachable. --db-path
# overrides this entirely once you've located the real file once.
CANDIDATE_DB_DIRS = [
    SCRIPT_DIR,
    os.getcwd(),
    os.path.expanduser('~'),
    os.path.expanduser('~/.local/share/colmi_r02_client'),
    os.path.expanduser('~/.colmi_r02_client'),
    os.path.expanduser('~/Library/Application Support/colmi_r02_client'),
]


def log(msg, verbose):
    line = time.strftime('%Y-%m-%d %H:%M:%S') + ' ' + msg
    if verbose:
        print(line)
    try:
        with open(LOG_PATH, 'a') as f:
            f.write(line + '\n')
    except OSError:
        pass


def load_config():
    if not os.path.exists(CONFIG_PATH):
        print(
            'No config.json found next to this script. Copy config.example.json to '
            'config.json and fill in your ring address, API URL, and secret first.',
            file=sys.stderr,
        )
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def run_scan():
    print('Scanning for BLE rings (this uses the colmi_r02_util CLI — install it first '
          'with: pipx install git+https://github.com/tahnok/colmi_r02_client)\n')
    subprocess.run(['colmi_r02_util', 'scan'])


def run_sync_cli(address, verbose):
    """Runs the CLI's documented `sync` command, which pulls the ring's
    logged data down into a local SQLite database. Returns the CLI's raw
    stdout/stderr for logging; does NOT know or assume where the database
    ends up — find_recent_db() searches for it afterward."""
    cmd = ['colmi_r02_client', '--address=' + address, 'sync']
    log('running: ' + ' '.join(cmd), verbose)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except FileNotFoundError:
        print('colmi_r02_client CLI not found. Install it with:\n'
              '  pipx install git+https://github.com/tahnok/colmi_r02_client', file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        log('sync timed out after 90s — ring likely out of range', verbose)
        return None
    log('sync exit code: ' + str(result.returncode), verbose)
    if verbose:
        if result.stdout:
            print('--- sync stdout ---\n' + result.stdout)
        if result.stderr:
            print('--- sync stderr ---\n' + result.stderr)
    if result.returncode != 0:
        return None
    return result


def try_live_heart_rate(address, verbose):
    """The CLI also exposes a real-time heart-rate read, separate from the
    logged/synced history — this tends to be fresher than whatever's in the
    synced database, so it's tried as an optional enhancement, not a
    requirement. Parses the first number found in stdout since the exact
    output format wasn't independently verifiable here either."""
    cmd = ['colmi_r02_client', '--address=' + address, 'get-real-time', 'heart-rate']
    log('running: ' + ' '.join(cmd), verbose)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if verbose and result.stdout:
        print('--- live heart-rate stdout ---\n' + result.stdout)
    if result.returncode != 0:
        return None
    match = re.search(r'\d+(\.\d+)?', result.stdout)
    return float(match.group()) if match else None


def find_recent_db(explicit_path, verbose):
    if explicit_path:
        return explicit_path if os.path.exists(explicit_path) else None
    candidates = []
    for d in CANDIDATE_DB_DIRS:
        if not os.path.isdir(d):
            continue
        candidates.extend(glob.glob(os.path.join(d, '*.db')))
        candidates.extend(glob.glob(os.path.join(d, '*.sqlite')))
        candidates.extend(glob.glob(os.path.join(d, '*.sqlite3')))
    if not candidates:
        return None
    # Most recently modified wins — the file `sync` just wrote should be the
    # newest thing matching these patterns in any candidate directory.
    candidates.sort(key=os.path.getmtime, reverse=True)
    log('db candidates found: ' + json.dumps(candidates), verbose)
    return candidates[0]


def discover_fields_from_db(db_path, verbose):
    """Opens the synced SQLite database and heuristically matches its real
    schema (whatever it turns out to be) against the six fields the
    dashboard understands, instead of assuming a schema this script's
    author couldn't confirm. Returns (payload_dict, discovery_log_dict) —
    the discovery log is always printed in verbose/dry-run mode so you can
    sanity-check what it matched."""
    payload = {}
    discovery = {}
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [row[0] for row in cur.fetchall()]
        log('tables found in ' + db_path + ': ' + json.dumps(tables), verbose)

        for field, keywords in FIELD_KEYWORDS.items():
            best = None  # (table, value_col, ts_col_or_None)
            for table in tables:
                table_l = table.lower()
                cur.execute('PRAGMA table_info(' + table + ')')
                columns = [row[1] for row in cur.fetchall()]
                columns_l = [c.lower() for c in columns]

                value_col = None
                for kw in keywords:
                    for c, cl in zip(columns, columns_l):
                        if is_id_column(c):
                            continue  # never the actual sensor value, even on a keyword match
                        if kw in cl:
                            value_col = c
                            break
                    if value_col:
                        break
                # A table whose own NAME matches but has no obviously-named
                # value column is still worth trying if it has exactly one
                # numeric-looking non-id, non-timestamp column.
                if not value_col and any(kw in table_l for kw in keywords):
                    plain_cols = [c for c in columns if not is_id_column(c) and
                                  not any(h in c.lower() for h in TIMESTAMP_COLUMN_HINTS)]
                    if len(plain_cols) == 1:
                        value_col = plain_cols[0]

                if not value_col:
                    continue

                ts_col = next((c for c in columns if any(h in c.lower() for h in TIMESTAMP_COLUMN_HINTS)), None)
                best = (table, value_col, ts_col)
                break  # first matching table wins; good enough for a single-ring, single-user setup

            if not best:
                discovery[field] = {'matched': False}
                continue

            table, value_col, ts_col = best
            order_clause = (' ORDER BY "' + ts_col + '" DESC') if ts_col else ' ORDER BY rowid DESC'
            try:
                cur.execute('SELECT "' + value_col + '" FROM "' + table + '"' + order_clause + ' LIMIT 1')
                row = cur.fetchone()
            except sqlite3.OperationalError as e:
                discovery[field] = {'matched': True, 'table': table, 'column': value_col, 'error': str(e)}
                continue

            discovery[field] = {'matched': True, 'table': table, 'column': value_col, 'timestamp_column': ts_col}
            if row and row[0] is not None:
                try:
                    payload[field] = float(row[0])
                except (TypeError, ValueError):
                    discovery[field]['error'] = 'value was not numeric: ' + repr(row[0])
    finally:
        conn.close()
    return payload, discovery


def post_payload(api_url, secret, payload, verbose):
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        api_url, data=body, method='POST',
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp_body = resp.read().decode('utf-8')
            log('POST ' + api_url + ' -> ' + str(resp.status) + ' ' + resp_body, verbose)
            return resp.status, resp_body
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8')
        log('POST ' + api_url + ' -> ' + str(e.code) + ' ' + err_body, verbose)
        return e.code, err_body
    except urllib.error.URLError as e:
        log('POST ' + api_url + ' failed: ' + str(e), verbose)
        return None, str(e)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--scan', action='store_true', help='List nearby BLE rings and exit (one-time setup helper)')
    parser.add_argument('--dry-run', action='store_true', help="Read the ring but don't POST anything")
    parser.add_argument('--verbose', action='store_true', help='Print every step, including raw CLI output and schema discovery')
    parser.add_argument('--db-path', default=None, help='Skip auto-discovery and use this exact SQLite file')
    args = parser.parse_args()

    if args.scan:
        run_scan()
        return

    config = load_config()
    address = config.get('address')
    api_url = config.get('api_url')
    secret = config.get('secret')
    if not address or address.startswith('PASTE-'):
        print('config.json is missing a real ring "address" — run with --scan first to find it.', file=sys.stderr)
        sys.exit(1)
    if not args.dry_run and (not api_url or not secret or api_url.startswith('PASTE-') or secret.startswith('PASTE-')):
        print('config.json is missing "api_url" or "secret" — see SETUP.md\'s Ring section.', file=sys.stderr)
        sys.exit(1)

    verbose = args.verbose or args.dry_run
    sync_result = run_sync_cli(address, verbose)
    if sync_result is None:
        log('sync failed or ring unreachable — nothing to send this run', verbose)
        sys.exit(0 if not args.dry_run else 1)  # a scheduled run should not error loudly just because the ring was out of range

    db_path = find_recent_db(args.db_path, verbose)
    payload = {}
    discovery = {}
    if db_path:
        log('using db: ' + db_path, verbose)
        payload, discovery = discover_fields_from_db(db_path, verbose)
    else:
        log('no synced database found in any candidate location — pass --db-path once you locate it', verbose)

    live_hr = try_live_heart_rate(address, verbose)
    if live_hr is not None:
        payload['heartRate'] = live_hr

    if verbose:
        print('\n--- field discovery ---')
        print(json.dumps(discovery, indent=2))
        print('\n--- payload that would be sent ---')
        print(json.dumps(payload, indent=2))

    if not payload:
        log('nothing readable this run — not sending an empty payload', verbose)
        return

    if args.dry_run:
        print('\n(dry run — not sending. Check the payload above against Colmi\'s own app before trusting this.)')
        return

    status, body = post_payload(api_url, secret, payload, verbose)
    if status != 200:
        log('ingest POST did not return 200: ' + str(status) + ' ' + body, True)


if __name__ == '__main__':
    main()
