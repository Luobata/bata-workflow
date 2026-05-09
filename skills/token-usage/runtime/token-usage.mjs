#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = os.homedir();
const COCO_ROOT = process.env.COCO_SESSIONS_ROOT || path.join(HOME, 'Library/Caches/coco/sessions');
const CODEX_DB = process.env.CODEX_STATE_DB || path.join(HOME, '.codex/state_5.sqlite');
const args = process.argv.slice(2);

function printHelp() {
  console.log(`Usage: token-usage <command> [options]

Commands:
  today                 Today's token usage (default)
  day <YYYY-MM-DD>      One day, also supports "yesterday"
  recent                Recent sessions
  session <id-prefix>   One session by id or prefix
  range                 Date range summary
  codex-today           Shortcut for today --source codex
  coco-today            Shortcut for today --source coco

Options:
  --agent coco|codex|all  Agent/source to query; default auto-detects current client
  --source coco|codex|all Alias of --agent
  --limit <n>
  --days <n>
  --from <YYYY-MM-DD>
  --to <YYYY-MM-DD>
  --group day|model|source
  --format json|text`);
}

function parseArgs(argv) {
  const out = { command: 'today', positionals: [], source: detectAgent(), limit: 10, group: '', format: 'text' };
  if (argv[0] && !argv[0].startsWith('-')) out.command = argv.shift();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { out.positionals.push(arg); continue; }
    const key = arg.replace(/^--?/, '');
    if (['source', 'agent', 'limit', 'group', 'format', 'from', 'to', 'days'].includes(key)) {
      const value = argv[i + 1];
      if (key === 'agent') out.source = value;
      else out[key] = value;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  out.limit = Number(out.limit || 10);
  out.days = out.days ? Number(out.days) : undefined;
  if (out.command.startsWith('codex-')) { out.source = 'codex'; out.command = out.command.slice(6); }
  if (out.command.startsWith('coco-')) { out.source = 'coco'; out.command = out.command.slice(5); }
  return out;
}

function detectAgent() {
  const explicit = process.env.TOKEN_USAGE_AGENT || process.env.CURRENT_AGENT || process.env.AGENT_NAME;
  if (explicit && /codex/i.test(explicit)) return 'codex';
  if (explicit && /coco|trae/i.test(explicit)) return 'coco';
  const argv = [process.env._, process.env.npm_lifecycle_script, process.title].filter(Boolean).join(' ');
  if (/codex/i.test(argv)) return 'codex';
  if (/coco|trae/i.test(argv)) return 'coco';
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return 'codex';
  return 'coco';
}

function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(yyyyMMdd, delta) {
  const [y, m, d] = yyyyMMdd.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + delta));
}

function resolveDay(value) {
  if (!value || value === 'today') return localDate();
  if (value === 'yesterday') return addDays(localDate(), -1);
  return value;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readCocoSessions() {
  const rows = [];
  if (!fs.existsSync(COCO_ROOT)) return rows;
  for (const name of fs.readdirSync(COCO_ROOT)) {
    const dir = path.join(COCO_ROOT, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const meta = readJson(path.join(dir, 'session.json')) || {};
    const md = meta.metadata || {};
    const created = meta.created_at || '';
    const updated = meta.updated_at || created;
    const byInvocation = new Map();
    const tracePath = path.join(dir, 'traces.jsonl');
    if (fs.existsSync(tracePath)) {
      for (const line of fs.readFileSync(tracePath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        for (const log of obj.logs || []) {
          const vals = Object.fromEntries((log.fields || []).map((f) => [f.key, f.value]));
          if (!('telemetry.tokens.input' in vals) && !('telemetry.tokens.output' in vals)) continue;
          const invocation = vals['telemetry.invocation.id'] || vals['telemetry.user_prompt.id'] || `${obj.traceID}:${obj.spanID}:${log.timestamp}`;
          const input = Number(vals['telemetry.tokens.input'] || 0);
          const output = Number(vals['telemetry.tokens.output'] || 0);
          const old = byInvocation.get(invocation) || { input: 0, output: 0 };
          byInvocation.set(invocation, { input: Math.max(old.input, input), output: Math.max(old.output, output) });
        }
      }
    }
    const input = [...byInvocation.values()].reduce((sum, item) => sum + item.input, 0);
    const output = [...byInvocation.values()].reduce((sum, item) => sum + item.output, 0);
    rows.push({ source: 'coco', id: name, created, updated, date: created.slice(0, 10), model: md.model_name || '', title: md.title || '', input, output, total: input + output, invocations: byInvocation.size });
  }
  return rows;
}

function readCodexSessions() {
  if (!fs.existsSync(CODEX_DB)) return [];
  const sql = `select id, title, tokens_used, model, datetime(created_at_ms/1000,'unixepoch','localtime'), datetime(updated_at_ms/1000,'unixepoch','localtime') from threads order by updated_at_ms desc;`;
  const result = spawnSync('sqlite3', ['-separator', '\t', CODEX_DB, sql], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [id, title, total, model, created, updated] = line.split('\t');
    return { source: 'codex', id, created, updated, date: (created || '').slice(0, 10), model: model || '', title: title || '', input: null, output: null, total: Number(total || 0), invocations: null };
  });
}

function wantedRows(options) {
  const sources = options.source === 'all' ? ['coco', 'codex'] : [options.source];
  return [
    ...(sources.includes('coco') ? readCocoSessions() : []),
    ...(sources.includes('codex') ? readCodexSessions() : []),
  ];
}

function filterRows(rows, options) {
  if (options.command === 'recent') return rows.sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created))).slice(0, options.limit);
  if (options.command === 'session') {
    const id = options.positionals[0];
    return rows.filter((row) => row.id === id || row.id.startsWith(id || ''));
  }
  if (options.command === 'range') {
    const to = resolveDay(options.to || 'today');
    const from = options.from ? resolveDay(options.from) : addDays(to, -((options.days || 7) - 1));
    return rows.filter((row) => row.date >= from && row.date <= to);
  }
  const day = resolveDay(options.command === 'day' ? options.positionals[0] : options.command);
  return rows.filter((row) => row.date === day);
}

function summarize(rows) {
  return {
    sessions: rows.length,
    input: rows.reduce((sum, row) => sum + (Number.isFinite(row.input) ? row.input : 0), 0),
    output: rows.reduce((sum, row) => sum + (Number.isFinite(row.output) ? row.output : 0), 0),
    total: rows.reduce((sum, row) => sum + (row.total || 0), 0),
  };
}

function groupRows(rows, key) {
  if (!key) return null;
  const groups = new Map();
  for (const row of rows) {
    const groupKey = key === 'day' ? row.date : key === 'model' ? (row.model || 'unknown') : key === 'source' ? row.source : row[key] || 'unknown';
    const current = groups.get(groupKey) || [];
    current.push(row);
    groups.set(groupKey, current);
  }
  return [...groups.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([name, items]) => ({ name, ...summarize(items) }));
}

function printText(payload) {
  console.log(`${payload.command} source=${payload.source}`);
  console.log(`sessions=${payload.summary.sessions} input=${payload.summary.input} output=${payload.summary.output} total=${payload.summary.total}`);
  if (payload.groups) {
    for (const group of payload.groups) console.log(`${group.name}\tsessions=${group.sessions}\tinput=${group.input}\toutput=${group.output}\ttotal=${group.total}`);
    return;
  }
  for (const row of payload.rows) {
    const input = row.input == null ? 'n/a' : row.input;
    const output = row.output == null ? 'n/a' : row.output;
    console.log(`${row.source}\t${row.created || ''}\t${row.id}\ttotal=${row.total}\tinput=${input}\toutput=${output}\t${row.model}\t${String(row.title || '').replace(/\s+/g, ' ').slice(0, 80)}`);
  }
}

const options = parseArgs(args);
if (options.help || options.command === 'help') {
  printHelp();
  process.exit(0);
}
const rows = filterRows(wantedRows(options), options);
const payload = {
  command: options.command,
  source: options.source,
  checked: { cocoSessionsRoot: COCO_ROOT, codexStateDb: CODEX_DB },
  summary: summarize(rows),
  groups: groupRows(rows, options.group),
  rows,
};

if (options.format === 'json') console.log(JSON.stringify(payload, null, 2));
else printText(payload);
