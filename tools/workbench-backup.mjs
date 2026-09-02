#!/usr/bin/env node

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkbenchStore } from '../src/workbench-store.mjs';

const PROJECT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = resolve(process.env.XHS_DATA_DIR || join(PROJECT_DIR, 'data'));

function usage() {
  return [
    '用法：',
    '  npm run backup:workbench -- list',
    '  npm run backup:workbench -- create [--include-media] [--id <backupId>]',
    '  npm run backup:workbench -- verify <backupId>',
    '  npm run backup:workbench -- restore <backupId> --target <empty-directory>',
    '  npm run backup:workbench -- prune [--keep <count>] [--max-age-days <days>]',
  ].join('\n');
}

function parseArgs(argv) {
  const [command = 'list', ...rest] = argv;
  const options = { includeMedia: false, id: null, target: null, keep: null, maxAgeDays: null };
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--include-media') options.includeMedia = true;
    else if (rest[index] === '--id') {
      options.id = rest[index + 1];
      index += 1;
    } else if (rest[index] === '--target') {
      options.target = rest[index + 1];
      index += 1;
    } else if (rest[index] === '--keep') {
      options.keep = Number(rest[index + 1]);
      index += 1;
    } else if (rest[index] === '--max-age-days') {
      options.maxAgeDays = Number(rest[index + 1]);
      index += 1;
    } else if (rest[index].startsWith('--')) throw new Error(`未知参数：${rest[index]}`);
    else positional.push(rest[index]);
  }
  return { command, options, positional };
}

async function main() {
  const { command, options, positional } = parseArgs(process.argv.slice(2));
  if (command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  const store = await WorkbenchStore.open(DATA_DIR);
  try {
    if (command === 'list') {
      console.log(JSON.stringify(await store.listBackups(), null, 2));
      return;
    }
    if (command === 'create') {
      const backup = await store.createBackup({ backupId: options.id, includeMedia: options.includeMedia });
      console.log(JSON.stringify(backup, null, 2));
      return;
    }
    if (command === 'verify') {
      const backupId = options.id || positional[0];
      if (!backupId) throw new Error('verify 需要 backupId');
      const verification = await store.verifyBackup(backupId);
      console.log(JSON.stringify(verification, null, 2));
      if (verification.status !== 'PASS') process.exitCode = 1;
      return;
    }
    if (command === 'restore') {
      const backupId = options.id || positional[0];
      if (!backupId) throw new Error('restore 需要 backupId');
      if (!options.target) throw new Error('restore 需要 --target <empty-directory>');
      const restored = await store.restoreBackup(backupId, options.target);
      console.log(JSON.stringify(restored, null, 2));
      if (restored.status !== 'PASS') process.exitCode = 1;
      return;
    }
    if (command === 'prune') {
      const pruned = await store.pruneBackups({ keep: options.keep, maxAgeDays: options.maxAgeDays });
      console.log(JSON.stringify(pruned, null, 2));
      if (pruned.status === 'PARTIAL') process.exitCode = 1;
      return;
    }
    throw new Error(`未知命令：${command}`);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error('工作台备份命令失败：' + (error?.message || error));
  console.error(usage());
  process.exitCode = 1;
});
