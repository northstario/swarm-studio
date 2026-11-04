#!/usr/bin/env node
// Start a simulation from the command line:
//   node bin/new.mjs -q "question" [-a 150] [-r 30] [--manual] [--text "pasted text"] file1.pdf file2.md
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    question: { type: 'string', short: 'q' },
    agents: { type: 'string', short: 'a', default: '150' },
    rounds: { type: 'string', short: 'r', default: '30' },
    text: { type: 'string', short: 't' },
    name: { type: 'string', short: 'n' },
    manual: { type: 'boolean', default: false },
  },
});
const base = `http://localhost:${process.env.PORT || 4321}`;
if (!values.question || (!positionals.length && !values.text)) {
  console.error('usage: new.mjs -q "what to predict" [-a agents] [-r rounds] [--manual] [--text "..."] files...');
  process.exit(2);
}
const files = positionals.map((f) => ({ name: path.basename(f), data: fs.readFileSync(f).toString('base64') }));
const res = await fetch(`${base}/api/sims`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ requirement: values.question, name: values.name, text: values.text, files, agents: Number(values.agents), rounds: Number(values.rounds), auto: !values.manual }),
});
const body = await res.json();
if (!res.ok) {
  console.error(body.error);
  process.exit(1);
}
console.log(JSON.stringify({ id: body.id, url: `${base}/#/sim/${body.id}`, status: body.status, settings: body.settings }));
