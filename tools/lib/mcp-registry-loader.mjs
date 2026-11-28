/**
 * `tools/lib/mcp-registry-loader.mjs` —— 把能力面注册表**真的装载起来**的唯一入口。
 *
 * 为什么要有这个文件：`tools/mcp-list-payload-evidence.mjs` 与 `tools/mcp-health.mjs`
 * 都要读同一份真源（`packages/mcp-host/src/index.ts`）。各抄一份 `vite.createServer` +
 * `ssrLoadModule` 的样板，等于两份「怎么算装载成功」的判断——正是本项目一直在收的那种
 * 双真值。装载口径只留这一处。
 *
 * 纪律（从载荷量具继承，逐字不变）：
 *  - 只走 vite SSR 变换装载**同一份运行时源码**，不降级成正则估、不手写 schema；
 *  - 装不起来就抛 `RegistryLoadError`，由调用方决定退出码与文案，**绝不返回半份模块**；
 *  - 必需导出缺席也算装载失败（装载成功但缺 `createMcpCapabilityRegistry` 的模块没有意义）。
 */
import * as path from 'node:path';

/** 装载失败。`stage` 让调用方保留自己原有的报错措辞（vite 缺席 / 装载炸了 / 缺导出）。 */
export class RegistryLoadError extends Error {
  /**
   * @param {string} message
   * @param {{ stage: 'vite' | 'load' | 'exports', cause?: unknown }} detail
   */
  constructor(message, { stage, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RegistryLoadError';
    this.stage = stage;
  }
}

const DEFAULT_REQUIRED_EXPORTS = Object.freeze([
  'createMcpCapabilityRegistry',
  'SEMANTIC_TOOL_SPECS',
  'KERNEL_IO_TOOL_SPECS',
  'SUPPLEMENTAL_TOOL_SPECS',
]);

/**
 * 装载能力面注册表模块。
 *
 * @param {{ repoRoot: string, requiredExports?: readonly string[] }} options
 * @returns {Promise<{ mod: Record<string, any>, dispose: () => Promise<void> }>}
 */
export async function loadRegistry({ repoRoot, requiredExports = DEFAULT_REQUIRED_EXPORTS }) {
  const root = path.resolve(repoRoot);
  let vite;
  try {
    vite = await import('vite');
  } catch (err) {
    throw new RegistryLoadError(`装载 vite 失败（${err?.message ?? err}）`, { stage: 'vite', cause: err });
  }
  const server = await vite.createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  let mod;
  try {
    mod = await server.ssrLoadModule('/packages/mcp-host/src/index.ts');
  } catch (err) {
    await server.close().catch(() => {});
    throw new RegistryLoadError(`注册表真源装不起来（${err?.message ?? err}）`, { stage: 'load', cause: err });
  }
  const missing = requiredExports.filter((name) => !mod?.[name]);
  if (missing.length > 0) {
    await server.close().catch(() => {});
    throw new RegistryLoadError(`注册表真源装载成功但缺导出 ${missing.join(', ')}`, { stage: 'exports' });
  }
  let closed = false;
  return {
    mod,
    dispose: async () => {
      if (closed) return;
      closed = true;
      await server.close().catch(() => {});
    },
  };
}
