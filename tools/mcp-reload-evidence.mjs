/**
 * MCP-RELOAD-HOOK 双通道取证量具（2026-11-28）。
 *
 * 用法（先各起一套会话，见 tools/debug-cli.mjs serve / shell --isolate）：
 *   node tools/mcp-reload-evidence.mjs debug-host
 *   node tools/mcp-reload-evidence.mjs real-shell
 *
 * 读数只在**当前会话自己的页内**产生：动态 import 应用侧 reload 模块，本通道登记
 * 自己的钩子与快照，发 50 次换代请求，回 samples / reloaded / p95Ms / sourceStamp。
 * 两侧不共享账本、不共享钩子、不互借 stamp；输出 --json 便于对拍。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'tools', 'debug-cli.mjs');
const mode = process.argv[2];
if (mode !== 'debug-host' && mode !== 'real-shell') {
  process.stderr.write('用法：node tools/mcp-reload-evidence.mjs <debug-host|real-shell>\n');
  process.exit(2);
}

const expr = `await (async () => {
  const m = await import('/src/mcp/project-reload.ts');
  const root = 'C:\\\\kojo-reload-evidence-${mode}';
  const id = m.rootIdOf(root);
  const channel = '${mode}';
  const handlers = {};
  const bus = {
    on: (type, handler) => {
      const list = handlers[type] || [];
      list.push(handler);
      handlers[type] = list;
      return () => {};
    },
    emit: (type, payload) => {
      for (const handler of handlers[type] || []) handler(payload);
    },
  };
  const snapshot = () => ({ generation: 400, fileCount: 400 });
  m.registerProjectReloadHook(m.createS1SnapshotReloadHook(snapshot), channel);
  const off = m.installProjectReloadObserver(bus, { snapshot, ledger: channel });
  for (let i = 0; i < 50; i += 1) {
    bus.emit('project.reload', { rootId: id, rootDir: root, trigger: 'returned', reason: 'fast-switch' });
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  const rows = m.reloadLedger(channel).filter((r) => r.event === 'reload.result');
  off();
  return {
    channel,
    samples: rows.length,
    reloaded: rows.filter((r) => r.claim === 'reloaded').length,
    p95Ms: m.reloadP95(rows),
    sourceStamp: rows[0] ? rows[0].sourceStamp : null,
    rootId: id,
  };
})()`;

try {
  const out = execFileSync(process.execPath, [cli, 'eval', expr], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 90_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reading = JSON.parse(out);
  process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
} catch (err) {
  process.stderr.write(`取证失败（${mode}）：${String(err)}\n`);
  process.exit(1);
}
