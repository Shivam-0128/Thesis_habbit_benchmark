#!/usr/bin/env node
// count-tools.mjs: counts the security and cognitive complexity measures of one build.
//
// Usage:
//   node count-tools.mjs --build <name> --zap zap.json --osv osv.json
//        --codeql-alerts codeql_alerts.json --sonar sonar.json [--out results]
//   (use --codeql file.sarif instead of --codeql-alerts for a SARIF file;
//    sonar.json is the response of SonarQube's
//    /api/measures/component?component=<key>&metricKeys=cognitive_complexity,functions)
//
// Writes <out>/<build>/tools_result.json with h_CodeQL, h_OSV, h_ZAP,
// H = h_CodeQL + h_OSV + h_ZAP, Q (cognitive_complexity), F (functions),
// K = Q / F (Formula 3.3), the counting rules and the details behind each count.
// A missing report gives an empty value (null); H then has no value. K has no value
// when Q or F is missing or F = 0.
//
// Changelog
//   1.1.0 (2026-11-03) SonarQube: the duplication measure was removed; Q (cognitive_complexity),
//                      F (functions) and K = Q / F are read and reported instead.
//   1.0.0 (2026-11-01) First version.

import fs from 'node:fs/promises';
import path from 'node:path';

const SCRIPT_VERSION = '1.1.0';
const HIGH = 7.0;

const RULES = {
  h_ZAP: 'ZAP baseline JSON report: number of alert types (alertRef, else pluginid) with riskcode 3 (High) over all sites. Their instances are listed and not counted.',
  h_OSV: `OSV-Scanner JSON report: number of vulnerability groups (results[].packages[].groups[]) whose max_severity (CVSS base score) is at least ${HIGH.toFixed(1)}, each group entry counted as reported. Groups without a score are listed separately and not counted.`,
  h_CodeQL_alerts: 'GitHub code scanning alerts API (JSON array): number of alerts with tool.name "CodeQL" whose state is not dismissed or fixed and whose rule.security_severity_level is high or critical.',
  h_CodeQL_sarif: `CodeQL SARIF file: number of results whose rule has properties["security-severity"] of at least ${HIGH.toFixed(1)}.`,
  H: 'H = h_CodeQL + h_OSV + h_ZAP; no value when any of the three is missing.',
  Q: 'Q = the cognitive_complexity measure (total for the analysed code) from the response of /api/measures/component?component=<key>&metricKeys=cognitive_complexity,functions.',
  F: 'F = the functions measure (number of functions) from the same response.',
  K: 'K = Q / F (Formula 3.3), not rounded; no value when Q or F is missing or F = 0. Lower is better; the script only reports K and does not rank builds.',
};

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
function usage() {
  return 'Usage: node count-tools.mjs --build <name> --zap zap.json --osv osv.json ' +
    '--codeql-alerts codeql_alerts.json --sonar sonar.json [--codeql file.sarif instead of --codeql-alerts] [--out results]\n' +
    '  sonar.json: response of /api/measures/component?component=<key>&metricKeys=cognitive_complexity,functions';
}
function die(msg) {
  console.error(`Error: ${msg}\n${usage()}`);
  process.exit(2);
}
function parseArgs(argv) {
  const a = { out: 'results' };
  const valued = { '--build': 'build', '--zap': 'zap', '--osv': 'osv', '--codeql-alerts': 'codeqlAlerts', '--codeql': 'codeqlSarif', '--sonar': 'sonar', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    let val;
    const eq = key.indexOf('=');
    if (key.startsWith('--') && eq > 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (key === '--help' || key === '-h') { console.log(usage()); process.exit(0); }
    if (!valued[key]) die(`unknown argument "${argv[i]}"`);
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined || val.startsWith('--')) die(`missing value for ${key}`);
    }
    a[valued[key]] = val;
  }
  if (!a.build) die('--build is required');
  if (!/^[A-Za-z0-9._-]+$/.test(a.build)) die('--build may contain only letters, digits, ".", "_" and "-"');
  if (a.codeqlAlerts && a.codeqlSarif) die('use either --codeql-alerts or --codeql, not both');
  return a;
}

// ---------------------------------------------------------------------------
// Reading JSON (also accepts several concatenated JSON values, as written by
// `gh api --paginate` without --slurp)
// ---------------------------------------------------------------------------
function parseJsonValues(text) {
  try { return [JSON.parse(text)]; } catch { /* try a sequence */ }
  const values = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { if (depth === 0) start = i; depth++; }
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && start >= 0) { values.push(JSON.parse(text.slice(start, i + 1))); start = -1; }
      if (depth < 0) throw new Error('unbalanced brackets');
    }
  }
  if (!values.length || depth !== 0) throw new Error('not valid JSON');
  return values;
}

async function readReport(file) {
  if (!file) return { given: false };
  const abs = path.resolve(file);
  let text;
  try { text = await fs.readFile(abs, 'utf8'); }
  catch (e) { return { given: true, path: abs, error: `cannot read file: ${e.code || e.message}` }; }
  try {
    const values = parseJsonValues(text.replace(/^﻿/, ''));
    return { given: true, path: abs, values };
  } catch (e) {
    return { given: true, path: abs, error: `invalid JSON: ${e.message}` };
  }
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : NaN;
};

// ---------------------------------------------------------------------------
// ZAP
// ---------------------------------------------------------------------------
function countZap(values) {
  const data = values[0];
  const sites = Array.isArray(data?.site) ? data.site : (data?.site ? [data.site] : null);
  if (!sites) throw new Error('no "site" array in the ZAP report');
  const byRisk = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const high = new Map();
  for (const site of sites) {
    for (const alert of site.alerts || []) {
      const risk = String(alert.riskcode ?? '').trim();
      if (risk in byRisk) byRisk[risk]++;
      if (risk !== '3') continue;
      const key = String(alert.alertRef || alert.pluginid || alert.name || alert.alert);
      let e = high.get(key);
      if (!e) {
        e = {
          alertRef: alert.alertRef ?? null, pluginid: alert.pluginid ?? null, name: alert.name || alert.alert || null,
          riskdesc: alert.riskdesc ?? null, cweid: alert.cweid ?? null, wascid: alert.wascid ?? null,
          sites: [], reportedCount: 0, instances: [],
        };
        high.set(key, e);
      }
      e.sites.push(site['@name'] ?? null);
      e.reportedCount += Number(alert.count ?? (alert.instances || []).length) || 0;
      for (const inst of alert.instances || []) {
        e.instances.push({
          site: site['@name'] ?? null, uri: inst.uri ?? null, method: inst.method ?? null,
          param: inst.param ?? null, attack: inst.attack ?? null, evidence: inst.evidence ?? null,
        });
      }
    }
  }
  return {
    value: high.size,
    details: {
      zapVersion: data['@version'] ?? null,
      generated: data['@generated'] ?? null,
      sites: sites.map((s) => s['@name'] ?? null),
      alertTypesByRiskcode: byRisk,
      countedHighAlerts: [...high.values()],
    },
    version: data['@version'] ?? null,
  };
}

// ---------------------------------------------------------------------------
// OSV-Scanner
// ---------------------------------------------------------------------------
function countOsv(values) {
  const data = values[0];
  if (!Array.isArray(data?.results)) throw new Error('no "results" array in the OSV-Scanner report');
  const counted = [];
  const unscored = [];
  const below = [];
  const warnings = [];
  const seen = new Map(); // same package version + same ids already listed from another source
  for (const res of data.results) {
    const source = res.source?.path ?? null;
    for (const pkg of res.packages || []) {
      const p = pkg.package || {};
      const vulns = new Map((pkg.vulnerabilities || []).map((v) => [v.id, v]));
      if (vulns.size && !(pkg.groups || []).length) {
        warnings.push(`${p.ecosystem}/${p.name}@${p.version} has vulnerabilities but no groups; they were not counted`);
      }
      for (const g of pkg.groups || []) {
        const ids = [...(g.ids || [])].sort();
        const key = [p.ecosystem, p.name, p.version, ids.join(',')].join('|');
        const score = num(g.max_severity);
        const first = vulns.get(g.ids?.[0]) || vulns.get(ids[0]);
        const e = {
          source, ecosystem: p.ecosystem ?? null, package: p.name ?? null, version: p.version ?? null,
          ids, aliases: g.aliases ?? [], maxSeverity: g.max_severity ?? null, summary: first?.summary ?? null,
          alsoInSource: seen.get(key) ?? null,
        };
        if (!seen.has(key)) seen.set(key, source);
        if (Number.isNaN(score)) unscored.push(e);
        else if (score >= HIGH) counted.push(e);
        else below.push({ source, ecosystem: e.ecosystem, package: e.package, version: e.version, ids, maxSeverity: e.maxSeverity });
      }
    }
  }
  const repeated = counted.filter((e) => e.alsoInSource !== null).length;
  if (repeated) warnings.push(`${repeated} counted group(s) repeat a group of the same package version from another lockfile (see alsoInSource)`);
  return {
    value: counted.length,
    details: {
      sources: data.results.map((r) => r.source?.path ?? null),
      countedGroups: counted,
      groupsBelowThreshold: below,
      groupsWithoutScore: unscored,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// CodeQL
// ---------------------------------------------------------------------------
function countCodeqlAlerts(values) {
  const flat = (v) => (Array.isArray(v) ? v.flatMap(flat) : [v]);
  if (!values.every(Array.isArray)) throw new Error('the code scanning alerts report must be a JSON array');
  const alerts = values.flatMap(flat).filter((a) => a && typeof a === 'object');
  const counted = [];
  const excluded = { otherTool: 0, dismissed: 0, fixed: 0, severityBelowHigh: {} };
  const versions = new Set();
  for (const a of alerts) {
    if (a.tool?.name !== 'CodeQL') { excluded.otherTool++; continue; }
    if (a.tool?.version) versions.add(a.tool.version);
    const state = String(a.state ?? '').toLowerCase();
    if (state === 'fixed') { excluded.fixed++; continue; }
    if (state.includes('dismissed')) { excluded.dismissed++; continue; }
    const level = String(a.rule?.security_severity_level ?? '').toLowerCase();
    if (level === 'high' || level === 'critical') {
      const loc = a.most_recent_instance?.location || {};
      counted.push({
        number: a.number ?? null, state: a.state ?? null, rule: a.rule?.id ?? a.rule?.name ?? null,
        securitySeverityLevel: level, path: loc.path ?? null, startLine: loc.start_line ?? null,
        htmlUrl: a.html_url ?? null,
      });
    } else {
      const k = level || 'none';
      excluded.severityBelowHigh[k] = (excluded.severityBelowHigh[k] || 0) + 1;
    }
  }
  const warnings = [];
  if (values.length === 1 && [30, 100].includes(alerts.length)) {
    warnings.push(`the array has exactly ${alerts.length} alerts, which is a page size of the API; check that all pages were exported (gh api --paginate --slurp)`);
  }
  return {
    value: counted.length,
    version: versions.size ? [...versions].sort() : null,
    details: { source: 'code scanning alerts API', alertsInFile: alerts.length, codeqlVersions: [...versions].sort(), countedAlerts: counted, excluded, warnings },
  };
}

function countSarif(values) {
  const data = values[0];
  if (!Array.isArray(data?.runs)) throw new Error('no "runs" array in the SARIF file');
  const counted = [];
  let resultsTotal = 0, noRule = 0, belowOrNoScore = 0;
  const versions = new Set();
  const tools = new Set();
  for (const run of data.runs) {
    const driver = run.tool?.driver || {};
    tools.add(driver.name ?? null);
    const v = driver.semanticVersion || driver.version;
    if (v) versions.add(v);
    const driverRules = driver.rules || [];
    const extRules = (run.tool?.extensions || []).map((e) => e.rules || []);
    const byId = new Map();
    for (const r of [...driverRules, ...extRules.flat()]) if (r?.id && !byId.has(r.id)) byId.set(r.id, r);
    for (const res of run.results || []) {
      resultsTotal++;
      let rule = null;
      const ref = res.rule || {};
      if (ref.toolComponent && Number.isInteger(ref.toolComponent.index) && Number.isInteger(ref.index)) {
        rule = extRules[ref.toolComponent.index]?.[ref.index] || null;
      } else if (Number.isInteger(ref.index)) {
        rule = driverRules[ref.index] || null;
      } else if (Number.isInteger(res.ruleIndex)) {
        rule = driverRules[res.ruleIndex] || null;
      }
      const ruleId = res.ruleId ?? ref.id ?? rule?.id ?? null;
      if (!rule && ruleId) rule = byId.get(ruleId) || null;
      if (!rule) { noRule++; continue; }
      const score = num(rule.properties?.['security-severity']);
      if (Number.isNaN(score) || score < HIGH) { belowOrNoScore++; continue; }
      const loc = res.locations?.[0]?.physicalLocation || {};
      counted.push({
        ruleId, securitySeverity: score, level: res.level ?? rule.defaultConfiguration?.level ?? null,
        path: loc.artifactLocation?.uri ?? null, startLine: loc.region?.startLine ?? null,
        message: String(res.message?.text ?? '').slice(0, 200),
      });
    }
  }
  const warnings = [];
  if (![...tools].includes('CodeQL')) warnings.push(`tool driver is ${[...tools].join(', ') || 'unknown'}, not CodeQL`);
  return {
    value: counted.length,
    version: versions.size ? [...versions].sort() : null,
    details: { source: 'SARIF', tools: [...tools], codeqlVersions: [...versions].sort(), resultsInFile: resultsTotal, countedResults: counted, notCounted: { ruleNotFound: noRule, scoreBelowThresholdOrMissing: belowOrNoScore }, warnings },
  };
}

// ---------------------------------------------------------------------------
// SonarQube
// ---------------------------------------------------------------------------
// Reads Q (cognitive_complexity) and F (functions) and computes K = Q / F (Formula 3.3).
// Only the measure's own value (the total for the analysed code) is used.
function readSonar(values) {
  const data = values[0];
  const comp = data?.component;
  const measures = comp?.measures || data?.measures;
  if (!Array.isArray(measures)) throw new Error('no "component.measures" array in the SonarQube response');
  const warnings = [];
  const read = (metric, symbol) => {
    const m = measures.find((x) => x.metric === metric);
    if (!m) {
      warnings.push(`the response has no ${metric} measure; ${symbol} has no value`);
      return { value: null, raw: null };
    }
    const value = num(m.value);
    if (Number.isNaN(value)) {
      warnings.push(`${metric} has no numeric value (${JSON.stringify(m.value ?? null)}); ${symbol} has no value`);
      return { value: null, raw: m.value ?? null };
    }
    return { value, raw: m.value };
  };
  const q = read('cognitive_complexity', 'Q');
  const f = read('functions', 'F');
  if (q.value === null && f.value === null) {
    throw new Error('the response has neither a numeric cognitive_complexity nor a numeric functions measure');
  }
  let K = null;
  let kNote = null;
  if (q.value === null || f.value === null) kNote = 'K has no value because Q or F is missing';
  else if (f.value === 0) kNote = 'K has no value because F = 0';
  else K = q.value / f.value;
  if (kNote) warnings.push(kNote);
  return {
    value: { Q: q.value, F: f.value, K },
    details: {
      component: comp?.key ?? null, name: comp?.name ?? null, qualifier: comp?.qualifier ?? null,
      rawValues: { cognitive_complexity: q.raw, functions: f.raw },
      formula: 'K = Q / F',
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function measure(name, file, fn) {
  const rep = await readReport(file);
  if (!rep.given) return { name, value: null, details: { status: 'report not given' } };
  if (rep.error) return { name, value: null, details: { status: 'report not usable', file: rep.path, error: rep.error } };
  try {
    const r = fn(rep.values);
    return { name, value: r.value, version: r.version ?? null, details: { status: 'counted', file: rep.path, ...r.details } };
  } catch (e) {
    return { name, value: null, details: { status: 'report not usable', file: rep.path, error: e.message } };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.join(path.resolve(args.out), args.build);
  await fs.mkdir(outDir, { recursive: true });

  const zap = await measure('ZAP', args.zap, countZap);
  const osv = await measure('OSV', args.osv, countOsv);
  const codeql = args.codeqlSarif
    ? await measure('CodeQL', args.codeqlSarif, countSarif)
    : await measure('CodeQL', args.codeqlAlerts, countCodeqlAlerts);
  const sonar = await measure('SonarQube', args.sonar, readSonar);

  const parts = [codeql.value, osv.value, zap.value];
  const H = parts.every((v) => Number.isInteger(v)) ? parts.reduce((s, v) => s + v, 0) : null;
  const { Q, F, K } = sonar.value || { Q: null, F: null, K: null };

  const result = {
    build: args.build,
    generatedAt: new Date().toISOString(),
    script: SCRIPT_VERSION,
    inputs: {
      zap: args.zap ? path.resolve(args.zap) : null,
      osv: args.osv ? path.resolve(args.osv) : null,
      codeqlAlerts: args.codeqlAlerts ? path.resolve(args.codeqlAlerts) : null,
      codeqlSarif: args.codeqlSarif ? path.resolve(args.codeqlSarif) : null,
      sonar: args.sonar ? path.resolve(args.sonar) : null,
    },
    h_CodeQL: codeql.value,
    h_OSV: osv.value,
    h_ZAP: zap.value,
    H,
    Q,
    F,
    K,
    rules: {
      h_ZAP: RULES.h_ZAP,
      h_OSV: RULES.h_OSV,
      h_CodeQL: args.codeqlSarif ? RULES.h_CodeQL_sarif : RULES.h_CodeQL_alerts,
      H: RULES.H,
      Q: RULES.Q,
      F: RULES.F,
      K: RULES.K,
    },
    versions: { zap: zap.version ?? null, codeql: codeql.version ?? null },
    details: { zap: zap.details, osv: osv.details, codeql: codeql.details, sonar: sonar.details },
  };
  const file = path.join(outDir, 'tools_result.json');
  await fs.writeFile(file, JSON.stringify(result, null, 2));

  const show = (v) => (v === null ? 'no value' : v);
  const statusOf = (m) => (m.details.status === 'counted' ? '' : `  (${m.details.status}${m.details.error ? ': ' + m.details.error : ''})`);
  console.log(`Tool counts for ${args.build}`);
  for (const [label, m] of [['h_CodeQL', codeql], ['h_OSV', osv], ['h_ZAP', zap]]) {
    console.log(`  ${label.padEnd(9)} ${show(m.value)}${statusOf(m)}`);
    for (const w of m.details.warnings || []) console.log(`    warning: ${w}`);
  }
  console.log(`  ${'H'.padEnd(9)} ${show(H)}`);
  console.log(`  ${'Q'.padEnd(9)} ${show(Q)}${statusOf(sonar)}`);
  console.log(`  ${'F'.padEnd(9)} ${show(F)}${statusOf(sonar)}`);
  console.log(`  ${'K'.padEnd(9)} ${show(K)}${K === null ? '' : `  (Q / F = ${Q} / ${F})`}`);
  for (const w of sonar.details.warnings || []) console.log(`    warning: ${w}`);
  console.log(`  written to ${file}`);
}

main().catch((e) => {
  console.error(`Fatal: ${e?.stack || e}`);
  process.exit(1);
});
