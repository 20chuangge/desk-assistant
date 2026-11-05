#!/usr/bin/env node
/**
 * verify-workflows.mjs — parse the GitHub workflow YAML and print what it found.
 *
 * The workflows cannot be executed on this machine (no JDK/SDK/Xcode), so the
 * cheapest real check is: does the YAML parse, and does the structure look like
 * a GitHub Actions workflow (name / on / jobs / steps with runs-on)? This script
 * does that with a real YAML parser (`yaml`, a devDependency) instead of eyeballing.
 *
 * Usage: node scripts/verify-workflows.mjs   (npm run verify:yaml)
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(here, '..', '..', '.github', 'workflows');

function fail(message) {
  console.error(`[verify:yaml] FAIL ${message}`);
  process.exitCode = 1;
}

async function main() {
  let files;
  try {
    files = (await fsp.readdir(workflowsDir)).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch (err) {
    fail(`cannot read ${workflowsDir}: ${err.message}`);
    return;
  }
  if (files.length === 0) {
    fail(`no workflow files in ${workflowsDir}`);
    return;
  }

  for (const file of files.sort()) {
    const full = path.join(workflowsDir, file);
    const text = await fsp.readFile(full, 'utf8');
    let doc;
    try {
      doc = YAML.parse(text);
    } catch (err) {
      fail(`${file} does not parse: ${err.message}`);
      continue;
    }

    if (!doc || typeof doc !== 'object') {
      fail(`${file} did not parse to a mapping`);
      continue;
    }
    if (!doc.on) fail(`${file} has no "on" trigger`);
    if (!doc.jobs || typeof doc.jobs !== 'object') {
      fail(`${file} has no "jobs"`);
      continue;
    }

    const jobNames = Object.keys(doc.jobs);
    console.log(`\n[verify:yaml] ${file}  "${doc.name || '(unnamed)'}"  ${jobNames.length} job(s)`);
    for (const jobName of jobNames) {
      const job = doc.jobs[jobName];
      if (!job['runs-on']) fail(`${file}:${jobName} has no runs-on`);
      const steps = Array.isArray(job.steps) ? job.steps : [];
      if (steps.length === 0) fail(`${file}:${jobName} has no steps`);
      console.log(`  job ${jobName}`);
      console.log(`    runs-on: ${job['runs-on']}`);
      for (const [index, step] of steps.entries()) {
        const label = step.name || step.uses || '(unnamed step)';
        const kind = step.uses ? `uses ${step.uses}` : 'run';
        const guard = step.if ? `  [if: ${String(step.if).replace(/\s+/g, ' ').slice(0, 64)}…]` : '';
        console.log(`    ${String(index + 1).padStart(2, '0')}. ${label} (${kind})${guard}`);
        if (!step.uses && !step.run) fail(`${file}:${jobName}:${index + 1} has neither uses nor run`);
      }
    }
  }

  if (process.exitCode) {
    console.error('\n[verify:yaml] one or more problems above');
  } else {
    console.log(`\n[verify:yaml] OK — ${files.length} workflow file(s) parsed and shaped correctly`);
  }
}

main().catch((err) => {
  console.error('[verify:yaml] crashed:', err);
  process.exit(1);
});
