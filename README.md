# Measurement scripts – community habit tracker builds

Measurement instruments of the bachelor thesis *"Comparative Analysis of Agentic AI Powered Web Development Platforms for Automated Web Application Development"* (Riga Technical University, 2026).

The scripts measure builds of the same reference application (a community habit tracker) produced by different agentic AI-powered web development platforms. Every build is measured with exactly the same code and settings.

## Files

| File | Version | Purpose |
|---|---|---|
| `habit-tests.mjs` | 1.1.0 | Browser test script: runs test cases 1–18 on the published address, scans five pages with axe-core (WCAG A and AA rules) and loads "My habits" five times with Lighthouse (LCP). |
| `count-tools.mjs` | 1.1.0 | Counts high-severity findings from the CodeQL, OSV-Scanner and ZAP baseline reports (H = h_CodeQL + h_OSV + h_ZAP) and calculates the cognitive complexity per function from SonarQube (K = Q / F). |
| `package.json`, `package-lock.json` | – | Fixed package versions: Playwright 1.63.0, axe-core 4.14.0, Lighthouse 13.6.0. |

The changelog of each script is at the top of the file.

## Requirements

- Node.js 20 or newer
- `npm install` (also installs the Chromium browser used by Playwright)

## Usage

```
node habit-tests.mjs --url <published address> --build <name> [--out results]
     [--email-domain example.com] [--tz <IANA time zone>] [--headed]
     [--skip-axe] [--skip-lighthouse]

node count-tools.mjs --build <name> --zap zap.json --osv osv.json
     --codeql-alerts codeql_alerts.json --sonar sonar.json [--out results]
     (use --codeql file.sarif instead of --codeql-alerts for a SARIF file)
```

`habit-tests.mjs` writes `<out>/<build>/result.json`, one screenshot per test case and the Lighthouse reports, and appends one line to `<out>/summary.csv`.
`count-tools.mjs` writes `<out>/<build>/tools_result.json`.
The interpretation rules are written into each result file.

## Note on authorship

The scripts were written with the help of Claude (Anthropic) and checked by the author of the thesis.
