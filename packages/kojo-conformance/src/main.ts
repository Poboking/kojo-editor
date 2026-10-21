#!/usr/bin/env node
/**
 * conformance CLI 的**真入口薄壳**：读 `process.argv`、接真 IO、落 `process.exitCode`。
 *
 * 纪律：
 * - 一切判定都在 `src/cli.ts`（纯逻辑、可注入 IO 单测）；本文件不解释 argv、不组装报告；
 * - `bin` 直连本文件（`package.json#bin`），但仓库没有 TS 构建步骤 ⇒ 直接跑需要
 *   TS 运行器（`tsx src/main.ts ...`，或 Node 类型剥离 + `.js`→`.ts` 解析器）。
 *   仓库内可跑的转发壳是 `tools/kojo-conformance.mjs`（用已有 Vite 以 SSR 加载本文件）。
 * - `main()` 只返回/设置退出码，不调用 `process.exit`：调用方（含测试）能继续收尾。
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '@kojo/kojo-core';

import type { ConformanceAdapterRegistration, ConformanceIoPort } from './cli.js';
import { formatConformanceReport, runConformanceCli } from './cli.js';

/** 递归列文件时一跳到底的目录：工程目录不该把依赖/构建产物当口上源文件 */
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'target', '.vite']);

/** 真 IO：路径相对 `cwd` 解析；文本读 UTF-8（BOM 以 U+FEFF 保留，交给 CLI 判定） */
export function createNodeIo(cwd: string = process.cwd()): ConformanceIoPort {
  const absolute = (target: string): string => (path.isAbsolute(target) ? target : path.resolve(cwd, target));
  return {
    readText: (target: string): string => readFileSync(absolute(target), 'utf8'),
    listFiles: (dir: string): readonly string[] => {
      const out: string[] = [];
      const walk = (current: string, prefix: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) continue;
            walk(path.join(current, entry.name), `${prefix}${entry.name}/`);
          } else if (entry.isFile()) {
            out.push(`${prefix}${entry.name}`);
          }
        }
      };
      walk(absolute(dir), '');
      out.sort();
      return out;
    },
  };
}

/** 内建 adapter 注册表：CLI 只带 fixture，真实 adapter 由调用方注入（kit 不认识游戏） */
export function createNodeAdapters(): Readonly<Record<string, ConformanceAdapterRegistration>> {
  return {
    fixture: { adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND },
    // 派生 fixture：补 `@着色` 能力（与 kit 单测里的 COLOR_ADAPTER 同口径），
    // 只为让包内 color fixtures 能跑绿；仍是抽象 fixture，不含任何游戏事实。
    'fixture-color': {
      adapter: {
        ...FIXTURE_ADAPTER,
        presentation: {
          ...FIXTURE_ADAPTER.presentation,
          color: { setColor: 'SETCOLOR', resetColor: 'RESETCOLOR', hexPrefix: '0x' },
        },
      },
      backend: {
        ...FIXTURE_BACKEND,
        profile: {
          ...FIXTURE_BACKEND.profile,
          presentations: { ...FIXTURE_BACKEND.profile.presentations, color: true },
        },
      },
    },
  };
}

export interface ConformanceMainOptions {
  readonly argv: readonly string[];
  /** 相对路径基准（默认 `process.cwd()`；测试可传内存路径） */
  readonly cwd?: string;
  readonly io?: ConformanceIoPort;
  readonly adapters?: Readonly<Record<string, ConformanceAdapterRegistration>>;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
}

/**
 * 真入口（可测）：跑一次 CLI，写 stdout/stderr，返回退出码（不触碰 `process.exitCode`）。
 *
 * `--json` 只影响检查结果的输出格式；help / 用法错误永远走 usage 文本（错误去 stderr）。
 */
export function runMain(options: ConformanceMainOptions): number {
  const argv = options.argv;
  const io = options.io ?? createNodeIo(options.cwd);
  const adapters = options.adapters ?? createNodeAdapters();
  const writeOut = options.writeOut ?? ((text: string): void => void process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string): void => void process.stderr.write(text));

  const result = runConformanceCli(argv, { io, adapters });
  const text = formatConformanceReport(result.report, { json: argv.includes('--json') });
  if (result.exitCode === 2) writeErr(text);
  else writeOut(text);
  return result.exitCode;
}

/** 进程级入口：本文件被直接执行时调用；设置 `process.exitCode` 而不 `process.exit` */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const exitCode = runMain({ argv });
  process.exitCode = exitCode;
  return exitCode;
}

function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) main();
