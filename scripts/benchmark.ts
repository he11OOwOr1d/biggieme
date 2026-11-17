import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { timeContext } from '../server/time.ts';

// Synthetic local-retrieval benchmark, not model/search latency or answer quality.
const directory = mkdtempSync(join(tmpdir(), 'minimi-bench-'));
const store = new Store(directory);
try {
  store.user('benchmark', 'UTC');
  store.db.exec('BEGIN');
  for (let chat = 0; chat < 500; chat++) {
    const session = store.create('benchmark');
    for (let turn = 0; turn < 10; turn++) {
      const date = new Date(Date.UTC(2026, 10, 1 + chat % 14, 10, turn)).toISOString();
      store.add('benchmark', session.id, 'user', `For project ${chat}, compare CRM pricing for a sales team. We also evaluated Postgres hosting. Question ${turn}.`, 'complete', [], date);
      store.add('benchmark', session.id, 'assistant', `Project ${chat}: shortlist HubSpot, Pipedrive and Zoho for CRM; Neon and Supabase for Postgres. Costs depend on billing terms.`, 'complete', [], date);
    }
  }
  store.db.exec('COMMIT');
  const windows = timeContext('3 November 2026', 'UTC', new Date('2026-11-15T10:00:00Z')).windows;
  const cases = [
    { label: 'keyword recall', query: 'Postgres hosting pricing', windows: [] },
    { label: 'date-only recall (bounded coverage)', query: 'What did I ask on 3 November?', windows },
  ];
  for (const c of cases) {
    const timings: number[] = [];
    for (let iteration = 0; iteration < 55; iteration++) {
      const start = performance.now(); store.retrieve('benchmark', c.query, c.windows);
      if (iteration >= 5) timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    console.log(`${c.label}, 10,000 messages, 50 warm samples: p50=${timings[25].toFixed(2)}ms p95=${timings[47].toFixed(2)}ms`);
  }
} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
