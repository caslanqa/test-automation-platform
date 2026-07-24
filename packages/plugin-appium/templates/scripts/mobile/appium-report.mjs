#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const resultsFile = path.join(cwd, 'test-results', 'results.json');
const outputDir = path.join(cwd, 'test-results', 'appium-report');
const outputFile = path.join(outputDir, 'index.html');

if (!fs.existsSync(resultsFile)) {
  console.error(
    `[appium-report] ${path.relative(cwd, resultsFile)} not found. Run Appium tests first ` +
      '(e.g. `npm run test:appium`).',
  );
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function flattenSuites(suites, out = []) {
  for (const suite of suites ?? []) {
    if (Array.isArray(suite.specs)) {
      out.push(...suite.specs);
    }
    if (Array.isArray(suite.suites) && suite.suites.length > 0) {
      flattenSuites(suite.suites, out);
    }
  }
  return out;
}

function statusClass(status) {
  if (status === 'passed') return 'ok';
  if (status === 'failed' || status === 'timedOut') return 'bad';
  return 'skip';
}

function absolutize(p) {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

function relFromReport(absolutePath) {
  return path.relative(outputDir, absolutePath);
}

function summarizeServerLog(absolutePath) {
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return { commands: 0, errors: 0, recent: [] };
  }
  const lines = fs.readFileSync(absolutePath, 'utf8').split('\n');
  const httpCmds = lines.filter(l =>
    /\[HTTP\].*-->\s+(GET|POST|DELETE|PUT|PATCH)\s+/i.test(l),
  ).length;
  const errors = lines.filter(
    l =>
      /Encountered internal error/i.test(l) ||
      /\[error\]/i.test(l) ||
      /\bWebDriverError\b/i.test(l) ||
      /\bError:\b/.test(l),
  );
  return {
    commands: httpCmds,
    errors: errors.length,
    recent: errors.slice(-5),
  };
}

const specs = flattenSuites(data.suites);
const rows = [];

for (const spec of specs) {
  const title = [...(spec.titlePath ?? []), spec.title].filter(Boolean).join(' › ');
  for (const test of spec.tests ?? []) {
    if (test.projectName !== 'appium') continue;
    for (const result of test.results ?? []) {
      const attachments = (result.attachments ?? [])
        .filter(a => a && a.path)
        .map(a => ({
          name: a.name || path.basename(a.path),
          absolutePath: absolutize(a.path),
        }));

      const named = name =>
        attachments.find(a => a.name === name || a.name.startsWith(name))?.absolutePath;
      const serverLogPath = named('appium-server-log');
      const sessionPath = named('appium-session-details');
      const pageSourcePath = named('appium-page-source');
      const screenshotPath = named('appium-screenshot');
      const videoPath = named('appium-recording');
      const deviceLogPath = named('device-log');
      const serverSummary = summarizeServerLog(serverLogPath);

      rows.push({
        file: spec.file,
        title,
        status: result.status ?? 'unknown',
        retry: result.retry ?? 0,
        durationMs: result.duration ?? 0,
        error:
          result.error?.message ??
          (Array.isArray(result.errors) && result.errors[0]?.message) ??
          '',
        attachments,
        sessionPath,
        pageSourcePath,
        screenshotPath,
        videoPath,
        deviceLogPath,
        serverLogPath,
        serverSummary,
      });
    }
  }
}

const total = rows.length;
const passed = rows.filter(r => r.status === 'passed').length;
const failed = rows.filter(r => r.status === 'failed' || r.status === 'timedOut').length;
const skipped = rows.filter(r => r.status === 'skipped' || r.status === 'interrupted').length;
const totalDuration = rows.reduce((sum, r) => sum + r.durationMs, 0);
const totalCommands = rows.reduce((sum, r) => sum + r.serverSummary.commands, 0);
const totalServerErrors = rows.reduce((sum, r) => sum + r.serverSummary.errors, 0);

const rowsHtml = rows
  .map((r, idx) => {
    const links =
      r.attachments.length === 0
        ? '<span class="muted">-</span>'
        : r.attachments
            .map(a => `<a href="${esc(relFromReport(a.absolutePath))}">${esc(a.name)}</a>`)
            .join(' · ');

    const screenshotBlock = r.screenshotPath
      ? `<div class="preview"><img src="${esc(relFromReport(r.screenshotPath))}" alt="screenshot" /></div>`
      : '';

    const diagnostics = [
      r.sessionPath ? `Session: <a href="${esc(relFromReport(r.sessionPath))}">json</a>` : '',
      r.pageSourcePath
        ? `Page source: <a href="${esc(relFromReport(r.pageSourcePath))}">xml</a>`
        : '',
      r.serverLogPath ? `Server log: <a href="${esc(relFromReport(r.serverLogPath))}">txt</a>` : '',
      r.deviceLogPath ? `Device log: <a href="${esc(relFromReport(r.deviceLogPath))}">txt</a>` : '',
      r.videoPath ? `Video: <a href="${esc(relFromReport(r.videoPath))}">mp4</a>` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const serverRecent =
      r.serverSummary.recent.length > 0
        ? `<pre class="log">${esc(r.serverSummary.recent.join('\n'))}</pre>`
        : '<div class="muted">No server error lines captured.</div>';

    return `<tr>
      <td>${idx + 1}</td>
      <td>${esc(r.file)}</td>
      <td>
        <div class="name">${esc(r.title)}</div>
        <div class="muted">retry #${r.retry}</div>
      </td>
      <td><span class="pill ${statusClass(r.status)}">${esc(r.status)}</span></td>
      <td>${(r.durationMs / 1000).toFixed(2)}s</td>
      <td>
        <div class="muted">HTTP commands: <strong>${r.serverSummary.commands}</strong> · Server errors: <strong>${r.serverSummary.errors}</strong></div>
        <details>
          <summary>Diagnostics</summary>
          <div class="diag">${diagnostics || '<span class="muted">No diagnostics attachments.</span>'}</div>
          ${screenshotBlock}
          <div class="section-title">Recent server errors</div>
          ${serverRecent}
        </details>
      </td>
      <td>
        <div class="err">${esc(r.error || '') || '<span class="muted">-</span>'}</div>
        <div class="links">${links}</div>
      </td>
    </tr>`;
  })
  .join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Appium Diagnostics Report</title>
  <style>
    :root {
      --bg: #0f1115;
      --panel: #171a21;
      --line: #2a2f3a;
      --text: #e6ebf2;
      --muted: #9ba4b4;
      --ok-bg: #123828;
      --ok-tx: #69db9f;
      --bad-bg: #3a1518;
      --bad-tx: #ff8f9a;
      --skip-bg: #2c3340;
      --skip-tx: #cfd6e3;
      --accent: #5ea2ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(180deg, #0b0d12 0%, var(--bg) 180px);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .wrap { max-width: 1400px; margin: 0 auto; padding: 24px; }
    .header {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 18px 20px;
      margin-bottom: 14px;
    }
    .title { margin: 0; font-size: 22px; font-weight: 700; }
    .meta { color: var(--muted); margin-top: 6px; font-size: 13px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px 14px;
    }
    .label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .value { font-size: 20px; font-weight: 700; }
    .table-wrap {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead th {
      text-align: left;
      padding: 12px;
      position: sticky;
      top: 0;
      background: #141821;
      border-bottom: 1px solid var(--line);
      color: #c7d0df;
      z-index: 1;
    }
    tbody td {
      border-top: 1px solid var(--line);
      padding: 10px 12px;
      vertical-align: top;
    }
    .name { font-weight: 600; margin-bottom: 3px; }
    .muted { color: var(--muted); font-size: 12px; }
    .err { white-space: pre-wrap; word-break: break-word; max-width: 620px; margin-bottom: 6px; }
    .links { font-size: 12px; }
    .pill {
      display: inline-block;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .03em;
    }
    .ok { background: var(--ok-bg); color: var(--ok-tx); }
    .bad { background: var(--bad-bg); color: var(--bad-tx); }
    .skip { background: var(--skip-bg); color: var(--skip-tx); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    details { margin-top: 8px; }
    summary { cursor: pointer; color: #d4dded; }
    .diag { margin: 8px 0; font-size: 12px; }
    .section-title { margin-top: 8px; margin-bottom: 4px; font-size: 12px; color: var(--muted); }
    .log {
      margin: 0;
      background: #0b0e14;
      border: 1px solid #202634;
      border-radius: 8px;
      padding: 8px;
      max-height: 180px;
      overflow: auto;
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .preview {
      margin: 8px 0;
      border: 1px solid #283145;
      border-radius: 8px;
      overflow: hidden;
      max-width: 280px;
    }
    .preview img { display: block; width: 100%; height: auto; }
    @media (max-width: 1100px) {
      .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 700px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .wrap { padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1 class="title">Appium Diagnostics Report</h1>
      <div class="meta">
        Source: ${esc(path.relative(cwd, resultsFile))} · Generated: ${esc(new Date().toISOString())}
      </div>
    </div>
    <div class="grid">
      <div class="card"><div class="label">Total</div><div class="value">${total}</div></div>
      <div class="card"><div class="label">Passed</div><div class="value">${passed}</div></div>
      <div class="card"><div class="label">Failed</div><div class="value">${failed}</div></div>
      <div class="card"><div class="label">Skipped</div><div class="value">${skipped}</div></div>
      <div class="card"><div class="label">HTTP Commands</div><div class="value">${totalCommands}</div></div>
      <div class="card"><div class="label">Server Errors</div><div class="value">${totalServerErrors}</div></div>
    </div>
    <div class="meta" style="margin-bottom:10px;">Total duration: ${(totalDuration / 1000).toFixed(2)}s</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>File</th>
            <th>Test</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Diagnostics</th>
            <th>Error / Attachments</th>
          </tr>
        </thead>
        <tbody>
          ${
            rowsHtml ||
            '<tr><td colspan="7" class="muted">No Appium test rows found in results.json.</td></tr>'
          }
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, html);
console.log(`[appium-report] Generated ${path.relative(cwd, outputFile)}`);
