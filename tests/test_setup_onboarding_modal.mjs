import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Covers the in-app setup modal that replaced the plain "Not connected —
// see SETUP.md" text on the Apple Health and Ring cards. The modal reuses
// the site-wide .modal-bg/.modal shell (design-system.css, the same one
// Settings already uses) rather than inventing a second modal component,
// and its content is real actionable steps (env vars, exact URLs/commands)
// condensed from SETUP.md, not just a link out to the markdown file.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return readFileSync(path.join(root, rel), 'utf8'); }

let pass = 0, fail = 0;
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const health = read('health.html');

// ============================== Markup ==============================
assertTrue(health.includes('id="ahSetupBtn"') && health.includes('id="ringSetupBtn"'), 'both cards have a "View setup steps" button, not just plain disclosure text');
assertTrue(health.includes('id="setupModalBg"') && health.includes('class="modal-bg"'), 'the setup modal reuses the site-wide .modal-bg shell');
assertTrue(health.includes('id="setupModalTitle"') && health.includes('id="setupModalBody"'), 'the modal has a dynamic title and body, not hardcoded single-purpose content');
assertTrue(health.includes('id="setupModalClose"'), 'the modal has a close button');
assertTrue(!health.includes('See\n        <code>SETUP.md</code> for the walkthrough'), 'the old "see SETUP.md" plain-text pointer was actually replaced, not left alongside the new button');

// ============================== Content — Apple Health ==============================
assertTrue(health.includes("'apple-health': {"), 'the SETUP_CONTENT map has an apple-health entry');
assertTrue(health.includes('APPLE_HEALTH_SECRET') && health.includes('APPLE_HEALTH_TIMEZONE'), 'the Apple Health modal content lists the real required/optional env vars');
assertTrue(health.includes('api/apple-health-ingest'), 'the Apple Health modal content includes the real ingest endpoint URL');
assertTrue(health.includes('Get Health Sample') && health.includes('Calculate Statistics'), 'the Apple Health modal content names the real Shortcuts actions, not a vague summary');
assertTrue(health.includes('same-day resend merges in rather than overwriting'), 'the Apple Health modal explains the honest merge behavior, matching the actual ingest endpoint logic');

// ============================== Content — Ring ==============================
assertTrue(health.includes('ring: {'), 'the SETUP_CONTENT map has a ring entry');
assertTrue(health.includes('RING_INGEST_SECRET') && health.includes('RING_TIMEZONE'), 'the Ring modal content lists the real required/optional env vars');
assertTrue(health.includes('pipx install git+https://github.com/tahnok/colmi_r02_client'), 'the Ring modal content includes the real CLI install command');
assertTrue(health.includes('ring_sync.py --scan') && health.includes('--dry-run --verbose'), 'the Ring modal content includes the real scan and dry-run commands');
assertTrue(health.includes('check the printed values against the ring') && health.includes('before trusting it unattended'), 'the Ring modal preserves the honest "verify before trusting" caveat from SETUP.md, not just the happy path');
assertTrue(health.includes('com.fern.ringsync.plist') && health.includes('launchctl load'), 'the Ring modal content includes the real launchd install commands');
assertTrue(health.includes('not truly 24/7'), 'the Ring modal states the honest always-on limitation up front, matching the platform-restriction disclosure already established for this feature');

// ============================== Wiring ==============================
assertTrue(/openSetupModal\('apple-health'\)/.test(health), 'the Apple Health button opens the correct modal content');
assertTrue(/openSetupModal\('ring'\)/.test(health), 'the Ring button opens the correct modal content');
assertTrue(health.includes("e.key === 'Escape'") , 'the modal closes on Escape, matching standard modal accessibility expectations');
assertTrue(/e\.target === \$\('setupModalBg'\)/.test(health), 'the modal closes on a real backdrop click (checked against the backdrop element itself, not any click anywhere)');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
