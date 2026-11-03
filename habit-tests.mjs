#!/usr/bin/env node
// habit-tests.mjs: measurement instrument for the community habit tracker builds.
//
// Usage:
//   node habit-tests.mjs --url <published address> --build <name> [--out results]
//        [--email-domain example.com] [--tz <IANA time zone>] [--headed]
//        [--skip-axe] [--skip-lighthouse]
//
// Runs the 18 test cases in order, then axe-core on five pages and Lighthouse
// five times on "My habits". Writes <out>/<build>/result.json, one screenshot per
// test case, the Lighthouse reports, and appends one line to <out>/summary.csv.
// Every build is handled by exactly the same code path; there are no per-build
// settings. The interpretation rules are listed in RULES below and are also
// written into result.json.
//
// Changelog
//   1.1.0 (2026-11-03) Lighthouse: a load counts only when it shows "My habits" with the
//                      habits of member A (final address and page content are checked);
//                      a load that fails the check gets no LCP value and a note. The LCP
//                      median is taken over the loads that have a value (mean of the two
//                      middle values for an even number) and has no value only when no
//                      load has one.
//   1.0.0 (2026-11-01) First version.

import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import lighthouse from 'lighthouse';
// The same puppeteer-core copy that Lighthouse imports itself (a dependency of Lighthouse).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const SCRIPT_VERSION = '1.1.0';

// ---------------------------------------------------------------------------
// Fixed settings (identical for every build)
// ---------------------------------------------------------------------------
const T = {
  appear: 15000,        // wait for a page, field or button to appear
  absence: 8000,        // wait before concluding that something did not appear
  networkIdleMax: 5000, // wait for the network to be idle, at most
  networkQuiet: 500,    // "idle" = no request in flight for this long
  settleExtra: 2500,    // extra wait after ticking, adding or posting
  click: 8000,          // one click attempt
  navigation: 30000,    // page.goto / page.reload
  poll: 250,            // polling interval
};
const VIEWPORT = { width: 1280, height: 800 };
const LOCALE = 'en-US';
const PASSWORD = 'HabitTest#2026pw';
const WRONG_PASSWORD = 'WrongPass#2026xy';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const LH_FLAGS = { output: 'json', logLevel: 'error', onlyCategories: ['performance'], disableStorageReset: true };
const LH_RUNS = 5;

const HABIT = {
  read: { name: 'Read 20 pages', when: 'After breakfast' },
  water: { name: 'Drink water', when: 'At work' },
  stretch: { name: 'Stretch', when: 'Before bed' },
};
const HABIT_NAMES = [HABIT.read.name, HABIT.water.name, HABIT.stretch.name];
const COMMENT = 'Keep going';

const TEST_CASES = [
  { id: 1, fn: 'F1', cls: 'valid' },
  { id: 2, fn: 'F1', cls: 'invalid, wrong password' },
  { id: 3, fn: 'F1', cls: 'invalid, unknown email' },
  { id: 4, fn: 'F2', cls: 'valid' },
  { id: 5, fn: 'F3', cls: 'valid' },
  { id: 6, fn: 'F3', cls: 'invalid, another member' },
  { id: 7, fn: 'F4', cls: 'valid; edges' },
  { id: 8, fn: 'F4', cls: 'beyond the upper edge' },
  { id: 9, fn: 'F4', cls: 'beyond the lower edge' },
  { id: 10, fn: 'F5', cls: 'output, lower end' },
  { id: 11, fn: 'F5', cls: 'valid' },
  { id: 12, fn: 'F5', cls: 'output, streak not ending today' },
  { id: 13, fn: 'F5', cls: 'output, upper end' },
  { id: 14, fn: 'F6', cls: 'valid' },
  { id: 15, fn: 'F6', cls: 'invalid, private habits' },
  { id: 16, fn: 'F4', cls: 'invalid, not the owner' },
  { id: 17, fn: 'F7', cls: 'valid' },
  { id: 18, fn: 'F1', cls: 'invalid, signed out' },
];
const VIABLE_IDS = [1, 4, 5, 7, 11, 14, 17];

// Absence rule: test case -> presence that must have been observed in the same run.
const ABSENCE_CREDIT = {
  2: ['myHabitsA', '"My habits" opened for A with the correct password'],
  3: ['myHabitsA', '"My habits" opened for A with the correct password'],
  6: ['myHabitsB', '"My habits" opened for B'],
  8: ['dateBoxes', '"Last 7 days" showed boxes labelled with dates'],
  9: ['dateBoxes', '"Last 7 days" showed boxes labelled with dates'],
  15: ['communityRead', '"Read 20 pages" was listed on "Community"'],
  16: ['bOpenedRead', 'B opened "Read 20 pages" from "Community"'],
  18: ['habitsAListed', 'the habits of A were listed while A was signed in'],
};

const RULES = [
  'Labels (the quoted UI texts of the specification) are matched exactly: case-sensitive, whitespace collapsed, text as written in the DOM (CSS text-transform is ignored).',
  'Fields are found by <label>, aria-labelledby or aria-label, then by placeholder (anchored regular expression); only visible text-entry elements count.',
  'Buttons: role button, falling back to role link. Navigation links: role link, falling back to role button. Only visible elements count. A submit button is the visible candidate nearest (deepest common ancestor) to the field just filled.',
  'A page opens when a visible element shows its name as a title: a heading or other element whose text is exactly the page name, where the innermost element carrying that text is visible and is not (inside) a link, button, navigation, label or form control. The exclusion is applied to headings as well, so a habit name in a list shown as <h3><a>name</a></h3> or <a><h3>name</h3></a> does not count as its page.',
  'Habit names, display names, "When I do it" texts and the comment are test data: they are found as contained text (case-sensitive, whitespace collapsed) in the visible page text.',
  'Row of a habit: the largest ancestor of the deepest element containing the habit name whose text contains exactly one occurrence of any of the three habit names (so another "Read 20 pages" from an earlier run also ends a row). On "Community" the row of "Read 20 pages" that contains the display name of A is used.',
  '"Shared" and "Private" are matched as whole words, case-sensitive, in the row text.',
  'Day boxes: input[type=checkbox] or [role=checkbox] that is not aria-hidden or inert and is visible (or has a visible <label> or visible label text). Label sources: aria-labelledby, aria-label, <label> elements, and the nearest ancestor (the box included) whose text contains a date and that contains no other box. A box is ticked when checked or aria-checked="true".',
  'Ticking as the owner: normal click; if it throws, forced click; if that throws, a click on the box label. One successful click per tick, then network idle (no request in flight for 500 ms, at most 5 s) plus 2.5 s.',
  'Trying to tick as a non-owner: normal click; if it throws, forced click; nothing happening is accepted. A box that is already ticked is not clicked.',
  '"Days done:" and "Current streak:" are read with the first match of the label followed by a number in the visible page text (in the row text on "Community") after reload, network idle and 2.5 s.',
  'Presence is polled for up to 15 s; absence is concluded after polling for 8 s.',
  'A comment is shown with its author when the nearest ancestor of the comment text that contains the author display name contains none of the day boxes.',
  'Moving between "My habits" and "Community" uses the navigation link; if the link is missing, the saved address of that page is opened and a note is added.',
  'Dates are calculated in the browser time zone (the context timezoneId, which is --tz or the computer time zone) at the start of the run.',
  'Email confirmation: the test case passes when "My habits" opens after signing in in a new browser; a page text asking to confirm the email is recorded as a note only.',
  'Browser dialogs (alert/confirm/prompt) are accepted and recorded as notes.',
  'Lighthouse load check: each run loads the "My habits" address in a new tab of the signed-in persistent browser. The tab is opened the way Lighthouse opens it itself (puppeteer-core connect to the debugging port with defaultViewport null, then a new page) and is passed to Lighthouse, so the load is the same but the tab stays open afterwards. A load counts only when it shows "My habits" with the habits of member A: Lighthouse reports no runtime error and an LCP value; its finalDisplayedUrl is the "My habits" address (same origin, same path ignoring a trailing slash, same hash; the query is ignored); and the tab, as Lighthouse left it, shows "My habits" as a title (same rule as for pages) and lists "Read 20 pages". A load that fails the check gets no LCP value and a note with the reason.',
  'LCP median: the median of the loads that have a value; with an even number of values, the mean of the two middle values (rounded to 0.01 ms). It has no value only when no load has a value.',
];

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
function usage() {
  return 'Usage: node habit-tests.mjs --url <published address> --build <name> [--out results] ' +
    '[--email-domain example.com] [--tz <IANA time zone>] [--headed] [--skip-axe] [--skip-lighthouse]';
}
function die(msg) {
  console.error(`Error: ${msg}\n${usage()}`);
  process.exit(2);
}
function parseArgs(argv) {
  const a = { out: 'results', emailDomain: 'example.com', tz: null, headed: false, skipAxe: false, skipLighthouse: false };
  const valued = { '--url': 'url', '--build': 'build', '--out': 'out', '--email-domain': 'emailDomain', '--tz': 'tz' };
  const flags = { '--headed': 'headed', '--skip-axe': 'skipAxe', '--skip-lighthouse': 'skipLighthouse' };
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    let val;
    const eq = key.indexOf('=');
    if (key.startsWith('--') && eq > 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (key === '--help' || key === '-h') { console.log(usage()); process.exit(0); }
    if (valued[key]) {
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined || val.startsWith('--')) die(`missing value for ${key}`);
      }
      a[valued[key]] = val;
    } else if (flags[key]) {
      a[flags[key]] = true;
    } else {
      die(`unknown argument "${argv[i]}"`);
    }
  }
  if (!a.url) die('--url is required');
  if (!a.build) die('--build is required');
  try {
    const u = new URL(a.url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
  } catch { die(`--url "${a.url}" is not an http(s) address`); }
  if (!/^[A-Za-z0-9._-]+$/.test(a.build)) die('--build may contain only letters, digits, ".", "_" and "-"');
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(a.emailDomain)) die(`--email-domain "${a.emailDomain}" is not a domain`);
  if (a.tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: a.tz }).format(new Date()); }
    catch { die(`--tz "${a.tz}" is not a valid IANA time zone`); }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.url;
const TZ = args.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const TZ_SOURCE = args.tz ? '--tz' : 'computer time zone';
const OUT_ROOT = path.resolve(args.out);
const OUT_DIR = path.join(OUT_ROOT, args.build);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactRe = (label, ci = false) =>
  new RegExp('^\\s*' + norm(label).split(' ').map(escapeRe).join('\\s+') + '\\s*$', ci ? 'i' : '');
const wordRe = (word, ci = false) =>
  new RegExp('(^|[^\\p{L}\\p{N}])' + escapeRe(word) + '(?=[^\\p{L}\\p{N}]|$)', ci ? 'iu' : 'u');
const statRe = (label, ci = false) => new RegExp(escapeRe(label) + '\\s*(\\d+)', ci ? 'gi' : 'g');
const shortMsg = (e) => norm(String(e?.message ?? e).split('\n')[0]).slice(0, 200);

function dateIn(tz, d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function shiftDate(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

let tokenCounter = 0;
const nextToken = () => `ht${++tokenCounter}`;

async function poll(timeout, fn) {
  const end = Date.now() + timeout;
  let r;
  for (;;) {
    r = await fn();
    if (r && r.done) return r;
    if (Date.now() >= end) return r || { done: false };
    await sleep(T.poll);
  }
}

class StepFail extends Error {}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------
const runId = crypto.randomBytes(4).toString('hex').slice(0, 6);
const A = { displayName: `Anna ${runId}`, email: `anna.${runId}@${args.emailDomain}` };
const B = { displayName: `Ben ${runId}`, email: `ben.${runId}@${args.emailDomain}` };
const UNKNOWN_EMAIL = `nobody.${runId}@${args.emailDomain}`;

const dateAtStart = dateIn(TZ);
const D = Array.from({ length: 8 }, (_, n) => shiftDate(dateAtStart, -n)); // D[0]..D[7]
const TOMORROW = shiftDate(dateAtStart, 1);

const obs = { myHabitsA: false, myHabitsB: false, dateBoxes: false, communityRead: false, bOpenedRead: false, habitsAListed: false };
const urls = { myHabits: null, community: null };
const debugLog = [];
let browser = null;
let current = null; // record of the running test case
const openContexts = new Set();

function failNote(msg) { if (current && !current.fails.includes(msg)) current.fails.push(msg); }
function info(msg) { if (current && !current.info.includes(msg)) current.info.push(msg); }
function check(cond, msg) { if (!cond) failNote(msg); return !!cond; }
function need(cond, msg) { if (!cond) throw new StepFail(msg); }
function debug(where, e) { if (debugLog.length < 100) debugLog.push({ test: current?.id ?? null, where, error: shortMsg(e) }); }

// ---------------------------------------------------------------------------
// In-page library. Serialised by Playwright and run inside the page; it must
// not use anything from the outer scope.
// ---------------------------------------------------------------------------
function inPage({ op, args }) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const DATE_ONE = /\d{4}-\d{2}-\d{2}/;
  const styles = new Map();
  const cs = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const childNodesOf = (el) => {
    if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
    if (el.tagName === 'SLOT' && typeof el.assignedNodes === 'function') {
      const a = el.assignedNodes({ flatten: true });
      if (a.length) return a;
    }
    return Array.from(el.childNodes);
  };
  const childElementsOf = (el) => childNodesOf(el).filter((n) => n.nodeType === 1);
  const containsAcross = (anc, node) => { for (let n = node; n; n = parentOf(n)) if (n === anc) return true; return false; };
  const closestAcross = (el, sel) => { for (let e = el; e; e = parentOf(e)) if (e.matches && e.matches(sel)) return e; return null; };
  const allElements = () => {
    const out = [];
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
    walk(document);
    return out;
  };
  const elVisible = (el) => {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    const st = cs(el);
    if (st.display === 'contents') return childElementsOf(el).some(elVisible);
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
    if (st.visibility !== 'visible') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'DESC', 'META', 'LINK',
    'INPUT', 'TEXTAREA', 'OPTION', 'OPTGROUP', 'DATALIST', 'IFRAME', 'OBJECT', 'CANVAS']);
  const memo = new Map();
  // Visible DOM text (CSS text-transform not applied); block boundaries become line breaks.
  const textOf = (el) => {
    if (memo.has(el)) return memo.get(el);
    let out = '';
    const tag = String(el.tagName).toUpperCase();
    const st = cs(el);
    if (st.display === 'none' || SKIP.has(tag)) { memo.set(el, ''); return ''; }
    if (tag === 'BR') { memo.set(el, '\n'); return '\n'; }
    if (tag === 'SELECT') {
      const o = el.selectedOptions && el.selectedOptions[0];
      out = o && st.visibility === 'visible' ? ' ' + norm(o.textContent) + ' ' : '';
      memo.set(el, out);
      return out;
    }
    const selfHidden = st.visibility !== 'visible';
    for (const n of childNodesOf(el)) {
      if (n.nodeType === 3) { if (!selfHidden) out += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      const t = textOf(n);
      if (!t) continue;
      const d = cs(n).display;
      const ctag = String(n.tagName).toUpperCase();
      const sep = (ctag === 'TD' || ctag === 'TH') ? ' ' : ((d.startsWith('inline') || d === 'contents') ? '' : '\n');
      out += sep + t + sep;
    }
    memo.set(el, out);
    return out;
  };
  const ntext = (el) => norm(textOf(el));
  const countOcc = (hay, needle) => { if (!needle) return 0; let c = 0, i = 0; while ((i = hay.indexOf(needle, i)) !== -1) { c++; i += needle.length; } return c; };
  const deepestContaining = (text) => {
    const t = norm(text);
    const res = [];
    for (const el of allElements()) {
      if (!ntext(el).includes(t)) continue;
      if (childElementsOf(el).some((c) => ntext(c).includes(t))) continue;
      if (!elVisible(el)) continue;
      res.push(el);
    }
    return res;
  };
  const rowOf = (el, names) => {
    const ns = names.map(norm);
    let row = el;
    for (let cur = parentOf(el); cur && cur !== document.documentElement; cur = parentOf(cur)) {
      const t = ntext(cur);
      if (ns.reduce((s, n) => s + countOcc(t, n), 0) > 1) break;
      row = cur;
    }
    return row;
  };
  const EXCL = 'a, button, nav, label, input, select, textarea, option, [contenteditable=""], [contenteditable="true"], ' +
    '[role="link"], [role="button"], [role="navigation"], [role="checkbox"], [role="textbox"], [role="searchbox"], ' +
    '[role="combobox"], [role="listbox"], [role="option"], [role="radio"], [role="switch"], [role="spinbutton"], [role="slider"]';
  const BOX_SEL = 'input[type="checkbox" i], [role="checkbox"]';
  const boxEls = () => allElements().filter((el) => el.matches(BOX_SEL) && !closestAcross(el, '[aria-hidden="true"], [inert]'));
  const isChecked = (b) => b.checked === true || b.getAttribute('aria-checked') === 'true';
  const idText = (b, attr) => {
    const v = b.getAttribute(attr);
    if (!v) return '';
    const root = b.getRootNode();
    return norm(v.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id)))
      .filter(Boolean).map((e) => e.textContent).join(' '));
  };
  const explicitLabels = (b) => {
    const src = [];
    const lb = idText(b, 'aria-labelledby'); if (lb) src.push(['aria-labelledby', lb]);
    const al = norm(b.getAttribute('aria-label')); if (al) src.push(['aria-label', al]);
    const labels = b.labels ? Array.from(b.labels) : [];
    for (const l of labels) { const t = norm(l.textContent); if (t) src.push(['label', t]); }
    return { src, labels };
  };
  const computeBoxes = () => {
    const all = boxEls();
    const inside = (c) => all.reduce((n, b) => n + (containsAcross(c, b) ? 1 : 0), 0);
    const out = [];
    for (const b of all) {
      const { src, labels } = explicitLabels(b);
      let nearEl = null, nearText = null, firstEl = null, firstText = null;
      for (let cur = b; cur && cur !== document.documentElement; cur = parentOf(cur)) {
        if (cur !== b && inside(cur) > 1) break;
        const t = ntext(cur);
        if (!t) continue;
        if (!firstEl) { firstEl = cur; firstText = t; }
        if (DATE_ONE.test(t)) { nearEl = cur; nearText = t; break; }
      }
      const near = nearEl || firstEl;
      const nearT = nearText || firstText;
      if (nearT) src.push(['nearest text', nearT]);
      const visible = elVisible(b) || labels.some(elVisible) || (near && near !== b && elVisible(near));
      if (!visible) continue;
      const dates = new Set();
      for (const [, t] of src) for (const m of t.matchAll(/\d{4}-\d{2}-\d{2}/g)) dates.add(m[0]);
      out.push({
        el: b, labels, near, dates: Array.from(dates), checked: isChecked(b),
        disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
        tag: b.tagName.toLowerCase() + (b.getAttribute('role') ? `[role=${b.getAttribute('role')}]` : ''),
        sources: src.map(([k, t]) => [k, t.slice(0, 120)]),
      });
    }
    return out;
  };

  switch (op) {
    case 'title': {
      const target = norm(args.name);
      const low = target.toLowerCase();
      let ciText = null;
      // The innermost element carrying the text decides: a heading that only wraps a link
      // (<h3><a>name</a></h3>) or sits inside one (<a><h3>name</h3></a>) is not a title.
      for (const el of allElements()) {
        const nt = ntext(el);
        if (!nt || nt.toLowerCase() !== low) continue;
        if (childElementsOf(el).some((c) => ntext(c) === nt)) continue;
        if (closestAcross(el, EXCL)) continue;
        if (!elVisible(el)) continue;
        const heading = closestAcross(el, 'h1, h2, h3, h4, h5, h6, [role="heading"]');
        if (nt === target) return { open: true, how: heading ? 'heading' : 'text', tag: el.tagName.toLowerCase() };
        if (!ciText) ciText = nt;
      }
      return { open: false, ciText };
    }
    case 'labelPresent': {
      const target = norm(args.text);
      const low = target.toLowerCase();
      let ciText = null;
      for (const el of allElements()) {
        const al = norm(el.getAttribute('aria-label'));
        const nt = ntext(el);
        const textHit = nt.toLowerCase() === low && !childElementsOf(el).some((c) => ntext(c) === nt);
        const alHit = al.toLowerCase() === low;
        if (!textHit && !alHit) continue;
        if (!elVisible(el)) continue;
        if ((textHit && nt === target) || (alHit && al === target)) return { found: true };
        if (!ciText) ciText = textHit ? nt : al;
      }
      return { found: false, ciText };
    }
    case 'pageText':
      return textOf(document.body || document.documentElement);
    case 'listed':
      return args.names.filter((n) => deepestContaining(n).length > 0);
    case 'rows': {
      const seen = new Set();
      const rows = [];
      for (const el of deepestContaining(args.name)) {
        const row = rowOf(el, args.names);
        if (seen.has(row)) continue;
        seen.add(row);
        rows.push(textOf(row));
      }
      return rows;
    }
    case 'markHabitName': {
      for (const el of deepestContaining(args.name)) {
        const row = rowOf(el, args.names);
        if (args.requireText && !ntext(row).includes(norm(args.requireText))) continue;
        const link = closestAcross(el, 'a, [role="link"]');
        const button = link ? null : closestAcross(el, 'button, [role="button"]');
        const target = link || button || el;
        target.setAttribute('data-ht-target', args.token);
        return { ok: true, kind: link ? 'link' : button ? 'button' : 'text' };
      }
      return { ok: false };
    }
    case 'boxes':
      return computeBoxes().map(({ dates, checked, disabled, tag, sources }) => ({ dates, checked, disabled, tag, sources }));
    case 'markBox': {
      const b = computeBoxes().find((x) => x.dates.includes(args.date));
      if (!b) return { ok: false, exists: false };
      let target = b.el;
      if (args.which === 'label') {
        target = b.labels.find(elVisible) || (b.near && b.near !== b.el && elVisible(b.near) ? b.near : null);
      }
      if (!target) return { ok: false, exists: true, checked: b.checked };
      target.setAttribute('data-ht-target', args.token);
      return { ok: true, exists: true, checked: b.checked };
    }
    case 'checkbox': {
      const target = norm(args.label);
      let ciText = null;
      for (const b of boxEls()) {
        const { src, labels } = explicitLabels(b);
        if (!(elVisible(b) || labels.some(elVisible))) continue;
        if (src.some(([, t]) => t === target)) {
          let marked = false;
          if (args.token) {
            const el = args.which === 'label' ? labels.find(elVisible) : b;
            if (el) { el.setAttribute('data-ht-target', args.token); marked = true; }
          }
          return { found: true, checked: isChecked(b), marked };
        }
        const ci = src.find(([, t]) => t.toLowerCase() === target.toLowerCase());
        if (ci && !ciText) ciText = ci[1];
      }
      return { found: false, ciText };
    }
    case 'comment': {
      const author = norm(args.author);
      const cands = deepestContaining(args.comment);
      const boxes = boxEls();
      for (const el of cands) {
        for (let cur = el; cur && cur !== document.documentElement; cur = parentOf(cur)) {
          if (!ntext(cur).includes(author)) continue;
          if (!boxes.some((b) => containsAcross(cur, b))) return { together: true, commentShown: true, authorShown: true };
          break;
        }
      }
      return { together: false, commentShown: cands.length > 0, authorShown: ntext(document.body).includes(author) };
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

async function evalPage(page, op, a = {}) {
  try {
    return await page.evaluate(inPage, { op, args: a });
  } catch (e) {
    const m = String(e?.message || e);
    if (!/Execution context was destroyed|navigat|Target page, context or browser has been closed|frame was detached|Cannot find context/i.test(m)) {
      debug(`evaluate ${op}`, e);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Browser contexts and waiting
// ---------------------------------------------------------------------------
const netState = new WeakMap();
function setupPage(page, label) {
  const st = { inflight: new Set(), last: Date.now() };
  netState.set(page, st);
  page.on('request', (r) => { st.inflight.add(r); st.last = Date.now(); });
  const done = (r) => { st.inflight.delete(r); st.last = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('dialog', async (d) => {
    info(`dialog (${label}): ${norm(d.message()).slice(0, 80)}`);
    try { await d.accept(); } catch { /* already handled */ }
  });
  page.setDefaultTimeout(T.appear);
  page.setDefaultNavigationTimeout(T.navigation);
}

async function waitNetworkIdle(page, max = T.networkIdleMax) {
  const st = netState.get(page);
  if (!st) return false;
  const end = Date.now() + max;
  for (;;) {
    if (st.inflight.size === 0 && Date.now() - st.last >= T.networkQuiet) return true;
    if (Date.now() >= end) return false;
    await sleep(50);
  }
}
async function settle(page) {
  await waitNetworkIdle(page);
  await sleep(T.settleExtra);
}

async function newBrowser(label) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, locale: LOCALE, timezoneId: TZ });
  openContexts.add(ctx);
  const page = await ctx.newPage();
  setupPage(page, label);
  return { ctx, page };
}
async function closeContext(ctx) {
  if (!ctx) return;
  openContexts.delete(ctx);
  try { await ctx.close(); } catch { /* ignore */ }
}

async function gotoUrl(page, url) {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: T.navigation });
  } catch (e) {
    if (!/timeout/i.test(String(e?.message))) throw e;
    info(`page load event not reached within ${T.navigation / 1000} s`);
  }
  await waitNetworkIdle(page);
}

// ---------------------------------------------------------------------------
// Finding fields, buttons, links, titles
// ---------------------------------------------------------------------------
const FILLABLE = 'input:not([type="checkbox" i]):not([type="radio" i]):not([type="submit" i]):not([type="button" i])' +
  ':not([type="reset" i]):not([type="hidden" i]):not([type="file" i]):not([type="image" i]), textarea, ' +
  '[contenteditable=""], [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]';

async function visibleFillable(loc) {
  let n = 0;
  try { n = await loc.count(); } catch { return null; }
  for (let i = 0; i < n; i++) {
    const l = loc.nth(i);
    try {
      if (!(await l.isVisible())) continue;
      if (await l.evaluate((el, sel) => el.matches(sel), FILLABLE)) return l;
    } catch { /* detached */ }
  }
  return null;
}
async function fieldNow(page, label) {
  const re = exactRe(label);
  return (await visibleFillable(page.getByLabel(re))) || (await visibleFillable(page.getByPlaceholder(re)));
}
async function hintField(page, label) {
  const re = exactRe(label, true);
  for (const loc of [page.getByLabel(re), page.getByPlaceholder(re)]) {
    const l = await visibleFillable(loc);
    if (!l) continue;
    const txt = await l.evaluate((el) => {
      const lab = el.labels && el.labels[0] ? el.labels[0].textContent : '';
      return lab || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    }).catch(() => '');
    const t = norm(txt);
    if (t && t !== norm(label)) info(`found "${t}" instead of "${label}"`);
    return;
  }
}
async function findField(page, label, timeout = T.appear) {
  const r = await poll(timeout, async () => {
    const loc = await fieldNow(page, label);
    return loc ? { done: true, loc } : { done: false };
  });
  if (r.loc) return r.loc;
  await hintField(page, label);
  return null;
}

async function visibleRole(page, role, re) {
  const loc = page.getByRole(role, { name: re });
  const out = [];
  let n = 0;
  try { n = await loc.count(); } catch { return out; }
  for (let i = 0; i < n; i++) {
    try { if (await loc.nth(i).isVisible()) out.push(loc.nth(i)); } catch { /* detached */ }
  }
  return out;
}
// All visible candidates of the first role (in order) that has any.
async function controlsNow(page, name, roles) {
  const re = exactRe(name);
  for (const role of roles) {
    const found = await visibleRole(page, role, re);
    if (found.length) return found;
  }
  return [];
}
async function hintControl(page, name, roles) {
  const re = exactRe(name, true);
  for (const role of roles) {
    const found = await visibleRole(page, role, re);
    if (!found.length) continue;
    const t = norm(await found[0].evaluate((el) => el.getAttribute('aria-label') || el.textContent || el.value || '').catch(() => ''));
    if (t && t !== norm(name)) info(`found "${t}" instead of "${name}"`);
    return;
  }
}
async function findControl(page, name, roles, timeout = T.appear) {
  const r = await poll(timeout, async () => {
    const c = await controlsNow(page, name, roles);
    return c.length ? { done: true, c } : { done: false };
  });
  if (r.c) return r.c;
  await hintControl(page, name, roles);
  return [];
}
const BUTTON_ROLES = ['button', 'link'];
const NAV_ROLES = ['link', 'button'];

async function findButton(page, name, timeout = T.appear) {
  const c = await findControl(page, name, BUTTON_ROLES, timeout);
  return c[0] || null;
}
async function findNavLink(page, name, timeout = T.appear) {
  const c = await findControl(page, name, NAV_ROLES, timeout);
  return c[0] || null;
}
// Button nearest to a field (deepest common ancestor); ties go to the first in page order.
async function findSubmit(page, name, nearLoc) {
  const cands = await findControl(page, name, BUTTON_ROLES, T.appear);
  if (cands.length <= 1 || !nearLoc) return cands[0] || null;
  try {
    const field = await nearLoc.elementHandle({ timeout: 2000 });
    const handles = [];
    for (const c of cands) handles.push(await c.elementHandle({ timeout: 2000 }));
    const idx = await page.evaluate(({ f, hs }) => {
      const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
      const depth = new Map();
      const chain = [];
      for (let n = f; n; n = parentOf(n)) chain.push(n);
      chain.reverse().forEach((n, i) => depth.set(n, i));
      let best = 0, bestDepth = -1;
      hs.forEach((h, i) => {
        for (let n = h; n; n = parentOf(n)) {
          if (depth.has(n)) { if (depth.get(n) > bestDepth) { bestDepth = depth.get(n); best = i; } break; }
        }
      });
      return best;
    }, { f: field, hs: handles });
    return cands[idx] || cands[0];
  } catch (e) {
    debug('findSubmit', e);
    return cands[0];
  }
}

async function clickRobust(loc) {
  try { await loc.click({ timeout: T.click }); return true; } catch { /* try forced */ }
  try { await loc.click({ timeout: T.click, force: true }); return true; } catch { return false; }
}
async function fill(loc, value, label) {
  try { await loc.fill(value, { timeout: T.click }); }
  catch (e) { throw new StepFail(`could not type into "${label}": ${shortMsg(e)}`); }
}

async function titleNow(page, name) {
  const r = await evalPage(page, 'title', { name });
  return r || { open: false };
}
async function waitTitle(page, name, timeout = T.appear, { hint = true } = {}) {
  let last = null;
  const r = await poll(timeout, async () => {
    last = await titleNow(page, name);
    return last.open ? { done: true, ...last } : { done: false };
  });
  if (!r.done && hint && last && last.ciText) info(`found "${last.ciText}" instead of "${name}"`);
  return !!r.done;
}
async function pageText(page) {
  return (await evalPage(page, 'pageText')) || '';
}

// ---------------------------------------------------------------------------
// Application steps
// ---------------------------------------------------------------------------
async function reachSignUpForm(page) {
  await gotoUrl(page, BASE_URL);
  const r = await poll(T.appear, async () => {
    if (await fieldNow(page, 'Display name')) return { done: true, here: true };
    const nav = await controlsNow(page, 'Sign up', NAV_ROLES);
    return nav.length ? { done: true, nav: nav[0] } : { done: false };
  });
  if (r.here) return { ok: true };
  if (r.nav) {
    await clickRobust(r.nav);
    await waitNetworkIdle(page);
    if (await findField(page, 'Display name')) return { ok: true };
    return { ok: false, why: 'field "Display name" not found on the "Sign up" page' };
  }
  await hintField(page, 'Display name');
  await hintControl(page, 'Sign up', NAV_ROLES);
  return { ok: false, why: 'neither the "Sign up" form nor a "Sign up" link was found' };
}

async function reachSignInForm(page) {
  await gotoUrl(page, BASE_URL);
  const formHere = async () => !!(await fieldNow(page, 'Email')) && !!(await fieldNow(page, 'Password')) &&
    !(await fieldNow(page, 'Display name'));
  const r = await poll(T.appear, async () => {
    if (await formHere()) return { done: true, here: true };
    const nav = await controlsNow(page, 'Sign in', NAV_ROLES);
    return nav.length ? { done: true, nav: nav[0] } : { done: false };
  });
  if (r.here) return { ok: true };
  if (r.nav) {
    await clickRobust(r.nav);
    await waitNetworkIdle(page);
    const ok = await poll(T.appear, async () => ({ done: await formHere() }));
    if (ok.done) return { ok: true };
    await hintField(page, 'Email');
    await hintField(page, 'Password');
    return { ok: false, why: 'fields "Email" and "Password" not found on the "Sign in" page' };
  }
  await hintField(page, 'Email');
  await hintControl(page, 'Sign in', NAV_ROLES);
  return { ok: false, why: 'neither the "Sign in" form nor a "Sign in" link was found' };
}

const CONFIRM_RE = /(check your (e-?mail|inbox)|confirm (your )?(e-?mail|account)|verify (your )?(e-?mail|account)|verification (e-?mail|link|code)|confirmation (e-?mail|link))/i;

async function signUp(page, member) {
  const reach = await reachSignUpForm(page);
  if (!reach.ok) return { ok: false, why: reach.why };
  const dn = await findField(page, 'Display name');
  const em = await findField(page, 'Email');
  const pw = await findField(page, 'Password');
  if (!dn) return { ok: false, why: 'field "Display name" not found' };
  if (!em) return { ok: false, why: 'field "Email" not found on the "Sign up" page' };
  if (!pw) return { ok: false, why: 'field "Password" not found on the "Sign up" page' };
  await fill(dn, member.displayName, 'Display name');
  await fill(em, member.email, 'Email');
  await fill(pw, PASSWORD, 'Password');
  const btn = await findSubmit(page, 'Sign up', pw);
  if (!btn) return { ok: false, why: 'button "Sign up" not found' };
  if (!(await clickRobust(btn))) return { ok: false, why: 'button "Sign up" could not be clicked' };
  await waitNetworkIdle(page);
  return { ok: true };
}

// Returns { submitted, open, why }. waitMs: 15 s when "My habits" should open, 8 s when it should not.
async function signIn(page, email, password, waitMs, { isA = false } = {}) {
  const reach = await reachSignInForm(page);
  if (!reach.ok) return { submitted: false, open: false, why: reach.why };
  const em = await findField(page, 'Email');
  const pw = await findField(page, 'Password');
  if (!em) return { submitted: false, open: false, why: 'field "Email" not found on the "Sign in" page' };
  if (!pw) return { submitted: false, open: false, why: 'field "Password" not found on the "Sign in" page' };
  await fill(em, email, 'Email');
  await fill(pw, password, 'Password');
  const btn = await findSubmit(page, 'Sign in', pw);
  if (!btn) return { submitted: false, open: false, why: 'button "Sign in" not found' };
  if (!(await clickRobust(btn))) return { submitted: false, open: false, why: 'button "Sign in" could not be clicked' };
  await waitNetworkIdle(page);
  const open = await waitTitle(page, 'My habits', waitMs);
  if (open && isA) {
    obs.myHabitsA = obs.myHabitsA || password === PASSWORD;
    if (!urls.myHabits) urls.myHabits = page.url();
  }
  if (current?.id === 1 && CONFIRM_RE.test(await pageText(page))) info('after signing in the page asks to confirm the email');
  return { submitted: true, open };
}

// Signs A in in a new browser; that browser becomes the current browser of A even when
// "My habits" does not open, so later test cases can still try their own steps.
async function signInA(label) {
  const s = await newBrowser(label);
  current.page = s.page;
  current.contexts.push(s.ctx);
  const si = await signIn(s.page, A.email, PASSWORD, T.appear, { isA: true });
  if (!si.submitted) throw new StepFail(`could not sign in as A in a new browser: ${si.why}`);
  setA(s);
  if (!si.open) throw new StepFail('"My habits" did not open after signing in as A in a new browser');
  return s;
}

async function openNavPage(page, name) {
  if ((await titleNow(page, name)).open) return true;
  const saved = name === 'My habits' ? urls.myHabits : urls.community;
  const link = await findNavLink(page, name);
  if (link) {
    await clickRobust(link);
    await waitNetworkIdle(page);
  } else if (saved) {
    info(`navigation link "${name}" not found; its saved address was opened`);
    await gotoUrl(page, saved);
  } else {
    failNote(`navigation link "${name}" not found`);
    return false;
  }
  const open = await waitTitle(page, name);
  if (open) {
    if (name === 'My habits' && !urls.myHabits) urls.myHabits = page.url();
    if (name === 'Community' && !urls.community) urls.community = page.url();
  } else {
    failNote(`"${name}" did not open`);
  }
  return open;
}

async function clickMarked(page, markOp, markArgs, { force = false } = {}) {
  const token = nextToken();
  const m = await evalPage(page, markOp, { ...markArgs, token });
  if (!m || !(m.ok || m.marked)) return { clicked: false, mark: m };
  try {
    await page.locator(`[data-ht-target="${token}"]`).first().click({ timeout: T.click, force });
    return { clicked: true, mark: m };
  } catch (e) {
    return { clicked: false, mark: m, error: shortMsg(e) };
  }
}

// Clicks the habit name (its link, else its button, else the text) and checks that its page opens.
async function openHabit(page, name, { requireText = null } = {}) {
  const found = await poll(T.appear, async () => {
    const rows = (await evalPage(page, 'rows', { name, names: HABIT_NAMES })) || [];
    const ok = rows.some((t) => !requireText || norm(t).includes(norm(requireText)));
    return { done: ok };
  });
  if (!found.done) {
    failNote(requireText ? `"${name}" with "${requireText}" not found on the page` : `"${name}" not found on the page`);
    return false;
  }
  const before = (await titleNow(page, name)).open;
  let res = await clickMarked(page, 'markHabitName', { name, names: HABIT_NAMES, requireText });
  if (!res.clicked) res = await clickMarked(page, 'markHabitName', { name, names: HABIT_NAMES, requireText }, { force: true });
  if (!res.clicked) {
    failNote(`could not click "${name}"`);
    return false;
  }
  await waitNetworkIdle(page);
  const open = await waitTitle(page, name);
  if (before) info(`"${name}" was already shown as a title before clicking`);
  if (!open) failNote(`the page of "${name}" did not open`);
  return open;
}

async function openHabitFromMyHabits(page, name) {
  if (!(await openNavPage(page, 'My habits'))) return false;
  return openHabit(page, name);
}

async function ensureHabitOpen(page, name) {
  if ((await titleNow(page, name)).open) return true;
  return openHabitFromMyHabits(page, name);
}

async function openAddForm(page) {
  const r = await poll(T.appear, async () => {
    if (await fieldNow(page, 'Habit name')) return { done: true, here: true };
    const b = await controlsNow(page, 'Add habit', BUTTON_ROLES);
    return b.length ? { done: true, opener: b[0] } : { done: false };
  });
  if (r.here) return true;
  if (r.opener) {
    await clickRobust(r.opener);
    if (await findField(page, 'Habit name')) return true;
    return false;
  }
  await hintField(page, 'Habit name');
  await hintControl(page, 'Add habit', BUTTON_ROLES);
  return false;
}

async function readCheckbox(page, label, timeout = T.appear) {
  let last = null;
  const r = await poll(timeout, async () => {
    last = await evalPage(page, 'checkbox', { label });
    return last && last.found ? { done: true, ...last } : { done: false };
  });
  if (!r.done && last && last.ciText) info(`found "${last.ciText}" instead of "${label}"`);
  return r.done ? { found: true, checked: r.checked } : { found: false };
}

async function setCheckbox(page, label, desired) {
  const s = await readCheckbox(page, label);
  if (!s.found) return { ok: false, found: false };
  if (s.checked === desired) return { ok: true, found: true };
  for (const [which, force] of [['box', false], ['box', true], ['label', false]]) {
    const r = await clickMarked(page, 'checkbox', { label, which }, { force });
    if (!r.clicked) continue;
    await sleep(500);
    const s2 = await evalPage(page, 'checkbox', { label });
    if (s2 && s2.found && s2.checked === desired) return { ok: true, found: true };
  }
  return { ok: false, found: true };
}

async function addHabit(page, habit, share) {
  need(await openAddForm(page), `the form with "Habit name" could not be opened (adding "${habit.name}")`);
  const nameF = await findField(page, 'Habit name');
  need(nameF, 'field "Habit name" not found');
  const whenF = await findField(page, 'When I do it');
  need(whenF, 'field "When I do it" not found');
  await fill(nameF, habit.name, 'Habit name');
  await fill(whenF, habit.when, 'When I do it');
  const cb = await setCheckbox(page, 'Share with the community', share);
  if (!cb.found) {
    if (share) throw new StepFail('tick box "Share with the community" not found');
    info('tick box "Share with the community" not found');
  } else if (!cb.ok) {
    throw new StepFail(`could not ${share ? 'tick' : 'untick'} "Share with the community"`);
  }
  const btn = await findSubmit(page, 'Add habit', whenF);
  need(btn, 'button "Add habit" not found');
  need(await clickRobust(btn), 'button "Add habit" could not be clicked');
  await settle(page);
}

async function readBoxes(page) {
  return (await evalPage(page, 'boxes')) || [];
}
const boxesFor = (boxes, date) => boxes.filter((b) => b.dates.includes(date));

async function waitDateBoxes(page, timeout = T.appear) {
  const r = await poll(timeout, async () => {
    const boxes = await readBoxes(page);
    return { done: boxes.some((b) => D.slice(0, 7).some((d) => b.dates.includes(d))), boxes };
  });
  return r.boxes || [];
}

// Owner: set the box of `date` to `desired` (one successful click), then settle.
async function setDay(page, date, desired) {
  const boxes = await readBoxes(page);
  const box = boxesFor(boxes, date)[0];
  if (!box) return { ok: false, why: `no box labelled ${date}` };
  if (box.checked === desired) return { ok: true };
  let r = await clickMarked(page, 'markBox', { date, which: 'box' });
  if (!r.clicked) r = await clickMarked(page, 'markBox', { date, which: 'box' }, { force: true });
  if (!r.clicked) r = await clickMarked(page, 'markBox', { date, which: 'label' });
  if (!r.clicked) return { ok: false, why: `the box labelled ${date} could not be clicked` };
  await settle(page);
  return { ok: true };
}

async function tickDays(page, steps) {
  for (const [date, desired] of steps) {
    const r = await setDay(page, date, desired);
    if (!r.ok) failNote(r.why);
  }
}

function readStatsFromText(text) {
  const out = { daysDone: null, streak: null };
  for (const [key, label] of [['daysDone', 'Days done:'], ['streak', 'Current streak:']]) {
    const all = [...text.matchAll(statRe(label))].map((m) => Number(m[1]));
    if (all.length) {
      out[key] = all[0];
      if (new Set(all).size > 1) info(`several "${label}" values on the page (${all.join(', ')}); the first was used`);
    } else {
      const ci = statRe(label, true).exec(text);
      if (ci) info(`found "${norm(ci[0].replace(/\d+$/, ''))}" instead of "${label}"`);
    }
  }
  return out;
}

// Reload, settle, check the habit page is shown, then read the values and the boxes.
async function reloadAndRead(page, name, { wantStreak = true } = {}) {
  await page.reload({ waitUntil: 'load', timeout: T.navigation }).catch((e) => info(`reload: ${shortMsg(e)}`));
  await settle(page);
  const open = await waitTitle(page, name);
  if (!open) failNote(`the page of "${name}" was not shown after reloading`);
  const r = await poll(T.appear, async () => {
    const text = await pageText(page);
    const hasDays = statRe('Days done:').test(text);
    const hasStreak = statRe('Current streak:').test(text);
    return { done: hasDays && (!wantStreak || hasStreak), text };
  });
  const stats = readStatsFromText(r.text || '');
  const boxes = await waitDateBoxes(page, open ? T.appear : 0);
  return { open, ...stats, boxes };
}

function checkStats(r, days, streak) {
  current.observed = { ...(current.observed || {}), daysDone: r.daysDone, currentStreak: r.streak };
  if (r.daysDone === null) failNote('"Days done:" with a number not found');
  else check(r.daysDone === days, `Days done: ${r.daysDone} (expected ${days})`);
  if (streak !== undefined) {
    if (r.streak === null) failNote('"Current streak:" with a number not found');
    else check(r.streak === streak, `Current streak: ${r.streak} (expected ${streak})`);
  }
}

async function absentNames(page, names, timeout = T.absence) {
  const r = await poll(timeout, async () => {
    const found = (await evalPage(page, 'listed', { names })) || [];
    return { done: found.length > 0, found };
  });
  return r.found || [];
}

// ---------------------------------------------------------------------------
// Test case runner
// ---------------------------------------------------------------------------
const results = [];
const S = { pageA: null, ctxA: null, pageB: null, ctxB: null, page7: null };

function setA(s) {
  if (S.ctxA && S.ctxA !== s.ctx) closeContext(S.ctxA);
  S.ctxA = s.ctx;
  S.pageA = s.page;
  current.contexts = current.contexts.filter((c) => c !== s.ctx);
}

function line(rec) {
  const tc = `${String(rec.id).padStart(2)} ${rec.function} ${rec.class}`.padEnd(42);
  return `${tc} ${rec.passed ? 'PASS' : 'FAIL'}${rec.note ? '  ' + rec.note : ''}`;
}

function credited(rec) {
  const c = ABSENCE_CREDIT[rec.id];
  if (!c) return true;
  return obs[c[0]];
}

function finalize(rec) {
  const c = ABSENCE_CREDIT[rec.id];
  const raw = rec.completed && rec.fails.length === 0;
  rec.passed = raw && credited(rec);
  const fails = [...rec.fails];
  if (c && !obs[c[0]]) fails.unshift(`absence not credited (presence not observed: ${c[1]})`);
  rec.note = [...fails, ...rec.info.map((i) => `info: ${i}`)].join('; ');
  return rec;
}

async function runTest(id, body) {
  const tc = TEST_CASES.find((t) => t.id === id);
  const rec = { id, function: tc.fn, class: tc.cls, passed: false, note: '', fails: [], info: [], completed: false, page: null, contexts: [], observed: null };
  current = rec;
  try {
    await body(rec);
    rec.completed = true;
  } catch (e) {
    if (e instanceof StepFail) failNote(e.message);
    else { failNote(`error: ${shortMsg(e)}`); debug(`test ${id}`, e); }
  }
  if (rec.page && !rec.page.isClosed()) {
    try {
      await rec.page.screenshot({ path: path.join(OUT_DIR, `tc${String(id).padStart(2, '0')}.png`), fullPage: true, timeout: 30000 });
    } catch (e) { debug(`screenshot ${id}`, e); }
  }
  for (const ctx of rec.contexts) if (ctx !== S.ctxA && ctx !== S.ctxB) await closeContext(ctx);
  finalize(rec);
  results.push(rec);
  console.log(line(rec));
  current = null;
}

// ---------------------------------------------------------------------------
// The 18 test cases
// ---------------------------------------------------------------------------
async function testCases() {
  // 1 F1 valid: sign up A, sign out, sign in as A in a new browser.
  await runTest(1, async (rec) => {
    const s0 = await newBrowser('sign-up A');
    rec.page = s0.page;
    rec.contexts.push(s0.ctx);
    const up = await signUp(s0.page, A);
    need(up.ok, up.why);
    if (await waitTitle(s0.page, 'My habits', T.appear, { hint: false })) {
      if (!urls.myHabits) urls.myHabits = s0.page.url();
    } else {
      info('"My habits" did not open after sign-up');
    }
    if (CONFIRM_RE.test(await pageText(s0.page))) info('after sign-up the page asks to confirm the email');
    const so = await findButton(s0.page, 'Sign out');
    if (so) { await clickRobust(so); await waitNetworkIdle(s0.page); } else info('button "Sign out" not found after sign-up');
    await closeContext(s0.ctx);
    await signInA('A');
  });

  // 2 F1 invalid, wrong password.
  await runTest(2, async (rec) => {
    const s = await newBrowser('wrong password');
    rec.page = s.page;
    rec.contexts.push(s.ctx);
    const si = await signIn(s.page, A.email, WRONG_PASSWORD, T.absence);
    need(si.submitted, `could not attempt to sign in: ${si.why}`);
    check(!si.open, '"My habits" opened with a wrong password');
  });

  // 3 F1 invalid, unknown email.
  await runTest(3, async (rec) => {
    const s = await newBrowser('unknown email');
    rec.page = s.page;
    rec.contexts.push(s.ctx);
    const si = await signIn(s.page, UNKNOWN_EMAIL, PASSWORD, T.absence);
    need(si.submitted, `could not attempt to sign in: ${si.why}`);
    check(!si.open, '"My habits" opened with an email that was never signed up');
  });

  // 4 F2 valid: add a shared and a private habit, open "Read 20 pages".
  await runTest(4, async (rec) => {
    need(S.pageA, 'member A is not signed in');
    const p = S.pageA;
    rec.page = p;
    need(await openNavPage(p, 'My habits'), '"My habits" did not open');
    need(await openAddForm(p), 'the form with "Habit name" could not be opened');
    const share = await readCheckbox(p, 'Share with the community');
    need(share.found, 'tick box "Share with the community" not found');
    check(!share.checked, '"Share with the community" was ticked when the form opened');
    rec.observed = { shareTickedAtFirst: share.checked };
    await addHabit(p, HABIT.read, true);
    await addHabit(p, HABIT.water, false);
    need(await openNavPage(p, 'My habits'), '"My habits" did not open');
    const r = await poll(T.appear, async () => {
      const readRows = (await evalPage(p, 'rows', { name: HABIT.read.name, names: HABIT_NAMES })) || [];
      const waterRows = (await evalPage(p, 'rows', { name: HABIT.water.name, names: HABIT_NAMES })) || [];
      const readShared = readRows.some((t) => wordRe('Shared').test(norm(t)));
      const waterPrivate = waterRows.some((t) => wordRe('Private').test(norm(t)));
      return { done: readShared && waterPrivate, readRows, waterRows, readShared, waterPrivate };
    });
    if (r.readRows.length && r.waterRows.length) obs.habitsAListed = true;
    // When a label is missing, note a case-insensitive match (the note never changes the result).
    const caseHint = (rows, word) => {
      for (const t of rows) {
        const m = wordRe(word, true).exec(norm(t));
        if (m) { info(`found "${m[0].slice(m[1].length)}" instead of "${word}"`); return; }
      }
    };
    if (!r.readRows.length) failNote(`"${HABIT.read.name}" is not listed`);
    else if (!r.readShared) {
      failNote(`"${HABIT.read.name}" is not listed as "Shared"`);
      caseHint(r.readRows, 'Shared');
    }
    if (!r.waterRows.length) failNote(`"${HABIT.water.name}" is not listed`);
    else if (!r.waterPrivate) {
      failNote(`"${HABIT.water.name}" is not listed as "Private"`);
      caseHint(r.waterRows, 'Private');
    }
    if (!(await openHabit(p, HABIT.read.name))) return;
    const shown = await poll(T.appear, async () => ({ done: norm(await pageText(p)).includes(HABIT.read.when) }));
    check(shown.done, `the page of "${HABIT.read.name}" does not show "${HABIT.read.when}"`);
  });

  // 5 F3 valid: A in a new browser sees both habits.
  await runTest(5, async (rec) => {
    const s = await signInA('A');
    need(await openNavPage(s.page, 'My habits'), '"My habits" did not open');
    const r = await poll(T.appear, async () => {
      const found = (await evalPage(s.page, 'listed', { names: [HABIT.read.name, HABIT.water.name] })) || [];
      return { done: found.length === 2, found };
    });
    if (r.done) obs.habitsAListed = true;
    for (const n of [HABIT.read.name, HABIT.water.name]) check((r.found || []).includes(n), `"${n}" is not listed`);
  });

  // 6 F3 invalid, another member: B does not see the habits of A.
  await runTest(6, async (rec) => {
    const s = await newBrowser('B');
    rec.page = s.page;
    S.ctxB = s.ctx;
    S.pageB = s.page;
    const up = await signUp(s.page, B);
    need(up.ok, `could not sign up B: ${up.why}`);
    let open = await waitTitle(s.page, 'My habits');
    if (!open) open = await openNavPage(s.page, 'My habits');
    need(open, '"My habits" did not open for B');
    obs.myHabitsB = true;
    const found = await absentNames(s.page, [HABIT.read.name, HABIT.water.name]);
    for (const n of found) failNote(`"${n}" of A is listed for B`);
  });

  // 7 F4 valid; edges: tick D0, D1, D6, untick D1; check in a new browser.
  await runTest(7, async (rec) => {
    need(S.pageA, 'member A is not signed in');
    rec.page = S.pageA;
    if (await openHabitFromMyHabits(S.pageA, HABIT.read.name)) {
      await waitDateBoxes(S.pageA);
      await tickDays(S.pageA, [[D[0], true], [D[1], true], [D[6], true], [D[1], false]]);
    }
    const s = await signInA('A');
    S.page7 = s.page;
    need(await openHabitFromMyHabits(s.page, HABIT.read.name), `the page of "${HABIT.read.name}" did not open`);
    await settle(s.page);
    const boxes = await waitDateBoxes(s.page);
    const last7 = await poll(T.appear, async () => {
      const v = await evalPage(s.page, 'labelPresent', { text: 'Last 7 days' });
      return { done: !!v?.found, ...(v || {}) };
    });
    if (!last7?.found) {
      failNote('list "Last 7 days" not found');
      if (last7?.ciText) info(`found "${last7.ciText}" instead of "Last 7 days"`);
    }
    obs.dateBoxes = !!last7?.found && boxes.some((b) => b.dates.length > 0);
    const states = {};
    for (let k = 0; k <= 6; k++) {
      const bs = boxesFor(boxes, D[k]);
      states[`D${k}`] = bs.length === 1 ? bs[0].checked : (bs.length ? `${bs.length} boxes` : 'missing');
      if (bs.length === 0) { failNote(`no box labelled D${k} (${D[k]})`); continue; }
      if (bs.length > 1) { failNote(`${bs.length} boxes labelled D${k} (${D[k]})`); continue; }
      const want = k === 0 || k === 6;
      check(bs[0].checked === want, `D${k} (${D[k]}) is ${bs[0].checked ? 'ticked' : 'not ticked'}`);
    }
    rec.observed = { boxes: states, dateLabelledBoxes: boxes.filter((b) => b.dates.length).length };
  });

  // 8 F4 beyond the upper edge: no box for tomorrow.
  await runTest(8, async (rec) => {
    need(S.page7, 'the page of test case 7 is not available');
    rec.page = S.page7;
    const r = await poll(T.absence, async () => ({ done: boxesFor(await readBoxes(S.page7), TOMORROW).length > 0 }));
    check(!r.done, `a box is labelled with tomorrow (${TOMORROW})`);
  });

  // 9 F4 beyond the lower edge: no box for D7.
  await runTest(9, async (rec) => {
    need(S.page7, 'the page of test case 7 is not available');
    rec.page = S.page7;
    const r = await poll(T.absence, async () => ({ done: boxesFor(await readBoxes(S.page7), D[7]).length > 0 }));
    check(!r.done, `a box is labelled D7 (${D[7]})`);
  });

  // 10 F5 output, lower end: "Drink water" before ticking -> Days done: 0.
  await runTest(10, async (rec) => {
    need(S.pageA, 'member A is not signed in');
    rec.page = S.pageA;
    need(await openHabitFromMyHabits(S.pageA, HABIT.water.name), `the page of "${HABIT.water.name}" did not open`);
    const r = await reloadAndRead(S.pageA, HABIT.water.name, { wantStreak: false });
    checkStats(r, 0);
  });

  // 11 F5 valid: tick D0, D1, D2, D4 -> Days done: 4, Current streak: 3.
  await runTest(11, async (rec) => {
    need(S.pageA, 'member A is not signed in');
    rec.page = S.pageA;
    need(await ensureHabitOpen(S.pageA, HABIT.water.name), `the page of "${HABIT.water.name}" did not open`);
    await waitDateBoxes(S.pageA);
    await tickDays(S.pageA, [[D[0], true], [D[1], true], [D[2], true], [D[4], true]]);
    checkStats(await reloadAndRead(S.pageA, HABIT.water.name), 4, 3);
  });

  // 12 F5 output, streak not ending today: "Stretch", tick D1, D2 -> 2 and 2.
  await runTest(12, async (rec) => {
    need(S.pageA, 'member A is not signed in');
    rec.page = S.pageA;
    need(await openNavPage(S.pageA, 'My habits'), '"My habits" did not open');
    await addHabit(S.pageA, HABIT.stretch, false);
    need(await openHabitFromMyHabits(S.pageA, HABIT.stretch.name), `the page of "${HABIT.stretch.name}" did not open`);
    await waitDateBoxes(S.pageA);
    await tickDays(S.pageA, [[D[1], true], [D[2], true]]);
    checkStats(await reloadAndRead(S.pageA, HABIT.stretch.name), 2, 2);
  });

  // 13 F5 output, upper end: tick the other five days -> 7 and 7.
  await runTest(13, async (rec) => {
    need(S.pageA, 'member A is not signed in');
    rec.page = S.pageA;
    need(await ensureHabitOpen(S.pageA, HABIT.stretch.name), `the page of "${HABIT.stretch.name}" did not open`);
    await waitDateBoxes(S.pageA);
    await tickDays(S.pageA, [[D[0], true], [D[3], true], [D[4], true], [D[5], true], [D[6], true]]);
    checkStats(await reloadAndRead(S.pageA, HABIT.stretch.name), 7, 7);
  });

  // 14 F6 valid: B sees "Read 20 pages" of A on "Community".
  await runTest(14, async (rec) => {
    need(S.pageB, 'member B is not signed in');
    const p = S.pageB;
    rec.page = p;
    need(await openNavPage(p, 'Community'), '"Community" did not open');
    await p.reload({ waitUntil: 'load', timeout: T.navigation }).catch((e) => info(`reload: ${shortMsg(e)}`));
    await settle(p);
    need(await waitTitle(p, 'Community'), '"Community" was not shown after reloading');
    const r = await poll(T.appear, async () => {
      const rows = (await evalPage(p, 'rows', { name: HABIT.read.name, names: HABIT_NAMES })) || [];
      const mine = rows.filter((t) => norm(t).includes(A.displayName));
      return { done: mine.length > 0, mine };
    });
    need(r.done, `"${HABIT.read.name}" with "${A.displayName}" is not listed`);
    obs.communityRead = true;
    const row = r.mine[0];
    check(norm(row).includes(HABIT.read.when), `the row does not show "${HABIT.read.when}"`);
    const m = [...row.matchAll(statRe('Days done:'))];
    if (!m.length) {
      failNote('the row does not show "Days done:" with a number');
      const ci = statRe('Days done:', true).exec(row);
      if (ci) info(`found "${norm(ci[0].replace(/\d+$/, ''))}" instead of "Days done:"`);
    } else {
      check(Number(m[0][1]) === 2, `Days done: ${m[0][1]} (expected 2)`);
    }
    rec.observed = { row: norm(row).slice(0, 300) };
  });

  // 15 F6 invalid, private habits: "Drink water" and "Stretch" are not listed.
  await runTest(15, async (rec) => {
    need(S.pageB, 'member B is not signed in');
    rec.page = S.pageB;
    need((await titleNow(S.pageB, 'Community')).open || (await openNavPage(S.pageB, 'Community')), '"Community" did not open');
    const found = await absentNames(S.pageB, [HABIT.water.name, HABIT.stretch.name]);
    for (const n of found) failNote(`"${n}" is listed on "Community"`);
  });

  // 16 F4 invalid, not the owner: B tries to tick D2; A still sees D2 unticked and Days done: 2.
  await runTest(16, async (rec) => {
    need(S.pageB, 'member B is not signed in');
    const p = S.pageB;
    rec.page = p;
    if ((await titleNow(p, 'Community')).open || (await openNavPage(p, 'Community'))) {
      if (await openHabit(p, HABIT.read.name, { requireText: A.displayName })) {
        obs.bOpenedRead = true;
        await settle(p);
        const box = boxesFor(await readBoxes(p), D[2])[0];
        if (!box) info(`B sees no box labelled D2 (${D[2]})`);
        else if (box.checked) info('D2 is already ticked in the view of B');
        else {
          const r = await clickMarked(p, 'markBox', { date: D[2], which: 'box' });
          if (!r.clicked) await clickMarked(p, 'markBox', { date: D[2], which: 'box' }, { force: true });
          await settle(p);
        }
      }
    }
    const s = await signInA('A');
    need(await openHabitFromMyHabits(s.page, HABIT.read.name), `the page of "${HABIT.read.name}" did not open`);
    const r = await reloadAndRead(s.page, HABIT.read.name, { wantStreak: false });
    const d2 = boxesFor(r.boxes, D[2]);
    if (!d2.length) failNote(`no box labelled D2 (${D[2]}) in the view of A`);
    else check(!d2[0].checked, `D2 (${D[2]}) is ticked`);
    checkStats(r, 2);
    rec.observed = { ...(rec.observed || {}), d2Ticked: d2.length ? d2[0].checked : null };
  });

  // 17 F7 valid: B posts "Keep going"; A sees it with the display name of B.
  await runTest(17, async (rec) => {
    need(S.pageB, 'member B is not signed in');
    const p = S.pageB;
    rec.page = p;
    let open = (await titleNow(p, HABIT.read.name)).open;
    if (!open && (await openNavPage(p, 'Community'))) open = await openHabit(p, HABIT.read.name, { requireText: A.displayName });
    need(open, `B is not on the page of "${HABIT.read.name}"`);
    const field = await findField(p, 'Comment');
    need(field, 'field "Comment" not found');
    await fill(field, COMMENT, 'Comment');
    const btn = await findSubmit(p, 'Post comment', field);
    need(btn, 'button "Post comment" not found');
    need(await clickRobust(btn), 'button "Post comment" could not be clicked');
    await settle(p);
    const s = await signInA('A');
    need(await openHabitFromMyHabits(s.page, HABIT.read.name), `the page of "${HABIT.read.name}" did not open`);
    const r = await poll(T.appear, async () => {
      const v = await evalPage(s.page, 'comment', { comment: COMMENT, author: B.displayName });
      return { done: !!v?.together, ...(v || {}) };
    });
    if (!r.done) {
      if (!r.commentShown) failNote(`"${COMMENT}" is not shown to A`);
      else if (!r.authorShown) failNote(`"${COMMENT}" is shown without "${B.displayName}"`);
      else failNote(`"${COMMENT}" and "${B.displayName}" are not shown together`);
    }
  });

  // 18 F1 invalid, signed out: after "Sign out" the address of "My habits" shows no habit of A.
  await runTest(18, async (rec) => {
    need(S.pageA, 'member A is not signed in');
    const p = S.pageA;
    rec.page = p;
    const so = await findButton(p, 'Sign out');
    need(so, 'button "Sign out" not found');
    need(await clickRobust(so), 'button "Sign out" could not be clicked');
    await waitNetworkIdle(p);
    if (!urls.myHabits) info('the address of "My habits" was never seen; the published address was opened');
    await gotoUrl(p, urls.myHabits || BASE_URL);
    const found = await absentNames(p, HABIT_NAMES);
    for (const n of found) failNote(`"${n}" is shown after signing out`);
  });
}

// ---------------------------------------------------------------------------
// Accessibility (axe-core)
// ---------------------------------------------------------------------------
async function runAxe() {
  const out = { skipped: false, tags: AXE_TAGS, pages: [], total: null, axeVersion: null };
  current = { id: 'axe', fails: [], info: [], contexts: [] };
  const s = await newBrowser('axe');
  const p = s.page;
  const scan = async (name, reach) => {
    const entry = { page: name, reached: false, scanned: false, url: null, count: null, violatedRules: [], error: null };
    out.pages.push(entry);
    try {
      const ok = await reach();
      if (!ok) { entry.error = `"${name}" could not be reached`; return; }
      entry.reached = true;
      await settle(p);
      entry.url = p.url();
      const res = await new AxeBuilder({ page: p }).withTags(AXE_TAGS).analyze();
      out.axeVersion = out.axeVersion || res.testEngine?.version || null;
      entry.violatedRules = res.violations.map((v) => ({
        id: v.id, impact: v.impact, tags: v.tags, help: v.help, nodes: v.nodes.length,
        targets: v.nodes.map((n) => n.target.flat().join(' ')).slice(0, 50),
      }));
      entry.count = res.violations.reduce((sum, v) => sum + v.nodes.length, 0);
      entry.scanned = true;
    } catch (e) {
      entry.error = shortMsg(e);
    }
  };
  try {
    await scan('Sign up', async () => (await reachSignUpForm(p)).ok);
    await scan('Sign in', async () => (await reachSignInForm(p)).ok);
    let signedIn = false;
    await scan('My habits', async () => {
      const si = await signIn(p, A.email, PASSWORD, T.appear);
      signedIn = si.open;
      return si.open;
    });
    await scan(HABIT.read.name, async () => signedIn && (await openHabitFromMyHabits(p, HABIT.read.name)));
    await scan('Community', async () => signedIn && (await openNavPage(p, 'Community')));
  } finally {
    await closeContext(s.ctx);
  }
  out.notes = [...current.fails, ...current.info];
  current = null;
  out.total = out.pages.length === 5 && out.pages.every((e) => e.scanned)
    ? out.pages.reduce((sum, e) => sum + e.count, 0) : null;
  return out;
}

// ---------------------------------------------------------------------------
// Performance (Lighthouse)
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Same address: same origin, same path (a trailing slash ignored) and same hash; the query is ignored.
function sameAddress(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const p = (u) => u.pathname.replace(/\/+$/, '') || '/';
    return x.origin === y.origin && p(x) === p(y) && x.hash === y.hash;
  } catch { return false; }
}

// Runs the in-page library in the Lighthouse tab (a puppeteer-core page) as Lighthouse left it.
// Only a failed evaluation is retried; the page is not given extra time to change.
async function evalLhTab(lhPage, op, a) {
  for (let attempt = 1; ; attempt++) {
    try { return await lhPage.evaluate(inPage, { op, args: a }); }
    catch (e) { if (attempt >= 3) throw e; await sleep(T.poll); }
  }
}

// A load counts only when it shows "My habits" with the habits of member A.
async function checkLoad(lhPage, lhr, myHabitsUrl) {
  const reasons = [];
  const check = { finalDisplayedUrl: lhr.finalDisplayedUrl || null, addressMatches: false, myHabitsShown: false, habitOfAShown: false };
  check.addressMatches = sameAddress(check.finalDisplayedUrl, myHabitsUrl);
  if (!check.addressMatches) reasons.push(`the load ended on ${check.finalDisplayedUrl || 'an unknown address'} instead of the "My habits" address ${myHabitsUrl}`);
  try {
    const title = await evalLhTab(lhPage, 'title', { name: 'My habits' });
    const listed = await evalLhTab(lhPage, 'listed', { names: [HABIT.read.name] });
    check.myHabitsShown = !!title?.open;
    check.habitOfAShown = Array.isArray(listed) && listed.includes(HABIT.read.name);
    if (!check.myHabitsShown) reasons.push(`the load did not show "My habits"${title?.ciText ? ` (found "${title.ciText}" instead of "My habits")` : ''}`);
    if (!check.habitOfAShown) reasons.push(`the load did not show "${HABIT.read.name}" of member A`);
  } catch (e) {
    reasons.push(`the Lighthouse tab could not be checked: ${shortMsg(e)}`);
  }
  return { check, reasons };
}

// Median of the values; with an even number of values, the mean of the two middle ones.
function medianOf(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const v = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round(v * 100) / 100;
}

async function runLighthouse() {
  const out = { skipped: false, flags: { ...LH_FLAGS, configuration: 'Lighthouse default configuration' }, url: null, runs: [], lcpMs: [], median: null, loadsWithValue: 0, error: null };
  current = { id: 'lighthouse', fails: [], info: [], contexts: [] };
  let ctx = null;
  let userDataDir = null;
  try {
    const port = await freePort();
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'habit-lh-'));
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: !args.headed, args: [`--remote-debugging-port=${port}`],
      viewport: VIEWPORT, locale: LOCALE, timezoneId: TZ,
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    setupPage(page, 'lighthouse');
    const si = await signIn(page, A.email, PASSWORD, T.appear);
    if (!si.open) throw new Error(`could not sign in as A in the Lighthouse browser${si.why ? ': ' + si.why : ''}`);
    if (!(await openNavPage(page, 'My habits'))) throw new Error('"My habits" could not be opened in the Lighthouse browser');
    out.url = page.url();
    for (let i = 1; i <= LH_RUNS; i++) {
      const run = { run: i, lcpMs: null, counted: false, note: null, finalDisplayedUrl: null, runtimeError: null, check: null, report: `lighthouse-${i}.json`, error: null };
      let lhBrowser = null;
      let lhPage = null;
      try {
        // Open the tab exactly as Lighthouse does when it is given only a port
        // (core/gather/navigation-runner.js). Lighthouse then runs the same load but
        // leaves the tab open, so it can be checked before it is closed here.
        lhBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
        lhPage = await lhBrowser.newPage();
        const res = await lighthouse(out.url, { ...LH_FLAGS, port }, undefined, lhPage);
        const lhr = res?.lhr;
        if (!lhr) throw new Error('Lighthouse returned no result');
        await fs.writeFile(path.join(OUT_DIR, run.report), typeof res.report === 'string' ? res.report : JSON.stringify(lhr, null, 2));
        out.lighthouseVersion = out.lighthouseVersion || lhr.lighthouseVersion;
        run.finalDisplayedUrl = lhr.finalDisplayedUrl || null;
        run.runtimeError = lhr.runtimeError?.code || null;
        const reasons = [];
        const v = lhr.audits?.['largest-contentful-paint']?.numericValue;
        if (lhr.runtimeError) reasons.push(`Lighthouse runtime error ${lhr.runtimeError.code}: ${norm(lhr.runtimeError.message).slice(0, 160)}`);
        else if (!Number.isFinite(v)) reasons.push('Lighthouse gave no largest-contentful-paint value');
        const chk = await checkLoad(lhPage, lhr, out.url);
        run.check = chk.check;
        reasons.push(...chk.reasons);
        if (reasons.length) {
          run.note = reasons.join('; ');
        } else {
          run.lcpMs = Math.round(v * 10) / 10;
          run.counted = true;
        }
      } catch (e) {
        run.error = shortMsg(e);
        run.note = `the Lighthouse run failed: ${run.error}`;
      } finally {
        if (lhPage) await lhPage.close().catch(() => {});
        if (lhBrowser) await lhBrowser.disconnect().catch(() => {});
      }
      out.runs.push(run);
      console.log(`   Lighthouse ${i}/${LH_RUNS}: LCP ${run.lcpMs === null ? '-' : run.lcpMs + ' ms'}${run.note ? '  not counted: ' + run.note : ''}`);
    }
  } catch (e) {
    out.error = shortMsg(e);
  } finally {
    if (ctx) { try { await ctx.close(); } catch { /* ignore */ } }
    if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  out.notes = [...current.fails, ...current.info];
  current = null;
  out.lcpMs = out.runs.map((r) => r.lcpMs);
  while (out.lcpMs.length < LH_RUNS) out.lcpMs.push(null);
  const values = out.lcpMs.filter((v) => v !== null);
  out.loadsWithValue = values.length;
  out.median = medianOf(values);
  return out;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
function pkgVersion(name) {
  try { return require(`${name}/package.json`).version; } catch { /* exports may hide package.json */ }
  try {
    let dir = path.dirname(require.resolve(name));
    for (let i = 0; i < 8; i++) {
      const f = path.join(dir, 'package.json');
      if (fsSync.existsSync(f)) {
        const j = JSON.parse(fsSync.readFileSync(f, 'utf8'));
        if (j.name === name) return j.version;
      }
      dir = path.dirname(dir);
    }
  } catch { /* not found */ }
  return null;
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function appendSummary(r) {
  const file = path.join(OUT_ROOT, 'summary.csv');
  const header = ['build', 'run_id', 'start', 'S', 'passed', 'viable', 'all_passed', 'accessibility_total',
    'lcp_median_ms', 'lcp_loads_with_value', 'date_changed', 'failed_test_cases'];
  const row = [r.build, r.runId, r.startTime, r.S, r.passed, r.viable, r.allPassed,
    r.accessibility.skipped ? '' : r.accessibility.total,
    r.performance.skipped ? '' : r.performance.median,
    r.performance.skipped ? '' : r.performance.loadsWithValue,
    r.dateChanged, r.failedTestCases.join(' ')];
  const exists = fsSync.existsSync(file);
  await fs.appendFile(file, (exists ? '' : header.join(',') + '\n') + row.map(csvCell).join(',') + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const startTime = new Date().toISOString();
  console.log(`habit-tests ${SCRIPT_VERSION}  build=${args.build}  run=${runId}`);
  console.log(`url=${BASE_URL}`);
  console.log(`members: A="${A.displayName}" <${A.email}>  B="${B.displayName}" <${B.email}>`);
  console.log(`time zone ${TZ} (${TZ_SOURCE}); D0=${D[0]} D6=${D[6]} D7=${D[7]} tomorrow=${TOMORROW}`);

  browser = await chromium.launch({ headless: !args.headed });
  const chromiumVersion = browser.version();
  let accessibility = { skipped: true, total: null, pages: [] };
  let performance = { skipped: true, median: null, lcpMs: [], loadsWithValue: null, runs: [] };
  let fatal = null;
  try {
    await testCases();
  } catch (e) {
    fatal = shortMsg(e);
    console.error(`Fatal error during the test cases: ${fatal}`);
  }
  // Absence credits are evaluated with everything observed during the 18 test cases.
  const reevaluated = [];
  for (const rec of results) {
    const before = rec.passed;
    finalize(rec);
    if (before !== rec.passed) reevaluated.push(rec);
  }
  for (const ctx of [...openContexts]) await closeContext(ctx);

  if (!args.skipAxe) {
    console.log('Accessibility (axe-core) ...');
    try { accessibility = await runAxe(); } catch (e) { accessibility = { skipped: false, total: null, pages: [], error: shortMsg(e) }; }
    for (const pg of accessibility.pages) console.log(`   ${pg.page}: ${pg.scanned ? pg.count : 'not scanned (' + pg.error + ')'}`);
  }
  await browser.close().catch(() => {});

  if (!args.skipLighthouse) {
    console.log('Performance (Lighthouse) ...');
    performance = await runLighthouse();
    if (performance.error) console.log(`   ${performance.error}`);
  }

  const endTime = new Date().toISOString();
  const dateAtEnd = dateIn(TZ);
  const dateChanged = dateAtEnd !== dateAtStart;

  const testCasesOut = TEST_CASES.map((tc) => {
    const r = results.find((x) => x.id === tc.id);
    if (r) return { id: r.id, function: r.function, class: r.class, passed: r.passed, note: r.note, observed: r.observed || undefined };
    return { id: tc.id, function: tc.fn, class: tc.cls, passed: false, note: 'not run' };
  });
  const passed = testCasesOut.filter((t) => t.passed).length;
  const S100 = Math.round((passed * 1000) / 18) / 10;
  const viable = VIABLE_IDS.every((id) => testCasesOut.find((t) => t.id === id)?.passed);
  const allPassed = passed === 18;
  const failed = testCasesOut.filter((t) => !t.passed).map((t) => t.id);

  const result = {
    build: args.build,
    url: BASE_URL,
    runId,
    members: {
      A: { ...A }, B: { ...B }, unknownEmail: UNKNOWN_EMAIL, password: PASSWORD, wrongPassword: WRONG_PASSWORD,
    },
    startTime,
    endTime,
    dateChanged,
    dateChangedNote: dateChanged ? 'date changed during the run' : null,
    dates: {
      timeZone: TZ, timeZoneSource: TZ_SOURCE, dateAtStart, dateAtEnd,
      D0: D[0], D1: D[1], D2: D[2], D3: D[3], D4: D[4], D5: D[5], D6: D[6], D7: D[7], tomorrow: TOMORROW,
    },
    settings: {
      out: OUT_ROOT, emailDomain: args.emailDomain, tz: args.tz, headed: args.headed,
      skipAxe: args.skipAxe, skipLighthouse: args.skipLighthouse,
      browser: 'chromium', viewport: VIEWPORT, locale: LOCALE, timeZone: TZ,
      waitsMs: {
        appear: T.appear, absence: T.absence, networkIdleMax: T.networkIdleMax, networkQuiet: T.networkQuiet,
        settleAfterAction: T.settleExtra, clickAttempt: T.click, navigation: T.navigation, poll: T.poll,
      },
      screenshots: 'full page after each test case',
      axe: { tags: AXE_TAGS, pages: ['Sign up', 'Sign in', 'My habits', HABIT.read.name, 'Community'], count: 'sum of nodes over violated rules' },
      lighthouse: { ...LH_FLAGS, runs: LH_RUNS, configuration: 'Lighthouse default configuration', browser: 'Playwright Chromium persistent context with --remote-debugging-port' },
      testData: { habits: HABIT, comment: COMMENT },
      rules: RULES,
    },
    versions: {
      node: process.version,
      playwright: pkgVersion('playwright'),
      chromium: chromiumVersion,
      axeCore: accessibility.axeVersion || pkgVersion('axe-core'),
      axeCorePlaywright: pkgVersion('@axe-core/playwright'),
      lighthouse: performance.lighthouseVersion || pkgVersion('lighthouse'),
      script: SCRIPT_VERSION,
    },
    testCases: testCasesOut,
    passed,
    S: S100,
    viable,
    allPassed,
    failedTestCases: failed,
    accessibility,
    performance,
    observations: { ...obs, addressMyHabits: urls.myHabits, addressCommunity: urls.community },
    fatalError: fatal,
    debug: debugLog,
  };
  await fs.writeFile(path.join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2));
  await appendSummary(result);

  console.log('');
  for (const rec of reevaluated) console.log(`Re-evaluated after the run: test case ${rec.id} ${rec.passed ? 'PASS' : 'FAIL'}`);
  console.log(`Summary for ${args.build} (run ${runId})`);
  console.log(`  passed ${passed}/18   S = ${S100}   viable: ${viable}   all passed: ${allPassed}`);
  if (failed.length) console.log(`  failed test cases: ${failed.join(' ')}`);
  console.log(`  accessibility total: ${accessibility.skipped ? 'skipped' : (accessibility.total ?? 'no value')}`);
  const lcpText = performance.skipped ? 'skipped'
    : `${performance.median === null ? 'no value' : performance.median + ' ms'} (loads with a value: ${performance.loadsWithValue}/${LH_RUNS})`;
  console.log(`  LCP median: ${lcpText}`);
  console.log(`  results: ${path.join(OUT_DIR, 'result.json')}`);
  if (dateChanged) {
    console.warn(`\nWARNING: date changed during the run (${dateAtStart} -> ${dateAtEnd}). The run must be repeated.`);
  }
}

main().catch(async (e) => {
  console.error(`Fatal: ${e?.stack || e}`);
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  process.exit(1);
});
