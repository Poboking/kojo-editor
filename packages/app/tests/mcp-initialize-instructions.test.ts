/**
 * T2 · `initialize.instructions`（模型侧取向说明）—— 静态面判据。
 *
 * 为什么有这一份：跨面共用的约定（档位模型 / 分页单旋钮 / 资源 URI 语义 / 新鲜度 /
 * 总数未知）原本只能在每枚工具描述里各抄一遍。MCP 规范里 `InitializeResult.instructions`
 * 就是干这件事的：一次握手说清取向，面上只留「这一枚工具自己」的事。
 *
 * 四条判据：
 *  - **S1**：收口后的档位尾注仍以事实标记 `Tier: privileged` 开头（模型得知道这是特权档）。
 *  - **S2**：**每一枚** privileged 面的描述里同时有 `Tier: privileged` 与 `` `initialize` ``
 *    ——事实标记不许丢，落点必须点名，否则模型不知道该去哪儿读可见性规则。
 *  - **S3**：尾注字节长度 < 130（证明是真收口，不是换了个说法）。
 *  - **S4**：**同源**——本文件不另抄一份 instructions 文本，而是从
 *    `packages/app/src-tauri/src/mcp/protocol.rs` 里用正则抽出那段字面量来断言。
 *    两份拷贝就是下一轮漂移；这里钉的就是「只有一份」。
 *
 * 复现：`node node_modules/vitest/vitest.mjs run packages/app/tests/mcp-initialize-instructions.test.ts`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KERNEL_IO_TOOL_SPECS,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
} from '@kojo/mcp-host';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const HOST_SRC = readFileSync(`${REPO_ROOT}/packages/mcp-host/src/index.ts`, 'utf8');
const PROTOCOL_SRC = readFileSync(`${REPO_ROOT}/packages/app/src-tauri/src/mcp/protocol.rs`, 'utf8');

const HOST_SPECS = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];
const PRIVILEGED = HOST_SPECS.filter((s) => s.tier === 'privileged');

/** 从 `index.ts` 源码里抽档位尾注的字面量（不 import——它是模块私有常量）。 */
function extractTierNote(): string {
  const m = HOST_SRC.match(/const PRIVILEGED_TIER_NOTE\s*=\s*\n?\s*'((?:[^'\\]|\\.)*)'/);
  expect(m, '在 packages/mcp-host/src/index.ts 里找不到 PRIVILEGED_TIER_NOTE 的字面量').not.toBeNull();
  return m![1]!.replace(/\\(['\\])/g, '$1');
}

/** 从 `protocol.rs` 源码里抽 `INSTRUCTIONS` 的原始字符串字面量。 */
function extractInstructions(): string {
  const m = PROTOCOL_SRC.match(/const INSTRUCTIONS: &str = r#"([\s\S]*?)"#;/);
  expect(m, '在 protocol.rs 里找不到 `const INSTRUCTIONS: &str = r#"…"#;`').not.toBeNull();
  return m![1]!;
}

const TIER_NOTE = extractTierNote();
const INSTRUCTIONS = extractInstructions();

describe('T2 · initialize.instructions 与特权档位文案收口', () => {
  it('S1 尾注仍以事实标记 `Tier: privileged` 开头', () => {
    expect(TIER_NOTE.startsWith('Tier: privileged')).toBe(true);
  });

  it('S2 每枚 privileged 面都同时点名事实标记与落点 `initialize`', () => {
    expect(PRIVILEGED.length, 'privileged 面枚数变了（86＝read 41 / edit 15 / privileged 30）').toBe(30);
    for (const s of PRIVILEGED) {
      const d = s.description ?? '';
      expect(d, `${s.name} 丢了档位事实标记 \`Tier: privileged\``).toContain('Tier: privileged');
      expect(d, `${s.name} 没点名落点 \`initialize\``).toContain('`initialize`');
    }
  });

  it('S3 尾注字节长度 < 130（真收口，不是换个说法）', () => {
    const bytes = Buffer.byteLength(TIER_NOTE, 'utf8');
    expect(bytes, `尾注 ${bytes} B：${TIER_NOTE}`).toBeLessThan(130);
  });

  it('S3b 旧的 187 字符长句在宿主源码里已经不存在（没有第二份拷贝）', () => {
    const legacy =
      'absent from tools/list until this EXACT name is approved in the 4th table (a wildcard such as launcher_* approves nothing)';
    expect(HOST_SRC.includes(legacy), '旧长句仍在 index.ts 里（说明只改了一部分）').toBe(false);
  });

  it('S4 instructions 只有一份真源：五个语义点逐个在 protocol.rs 的那段字面量里', () => {
    // ① 档位模型 + 逐项批准 + 通配符不算批准 + 批准后仍受宿主闸门
    expect(INSTRUCTIONS).toContain('read, edit, or privileged');
    expect(INSTRUCTIONS).toContain('tools/list');
    expect(INSTRUCTIONS).toContain('wildcard such as launcher_* approves nothing');
    // ② 分页只有一个旋钮 `limit`；续页凭据 `nextCursor`；翻页期间快照变化 `changedDuringPaging:true`
    expect(INSTRUCTIONS).toContain('`limit`');
    expect(INSTRUCTIONS).toContain('`nextCursor`');
    expect(INSTRUCTIONS).toContain('`changedDuringPaging:true`');
    expect(INSTRUCTIONS).toContain('must NOT be spliced onto the old page');
    // ③ 资源是 URI 语义
    expect(INSTRUCTIONS).toContain('`kojo://`');
    expect(INSTRUCTIONS).toContain('URIs, not file paths');
    // ④ 只读应答带新鲜度标注
    expect(INSTRUCTIONS).toContain('`fsFreshness`');
    expect(INSTRUCTIONS).toContain('stale mark means re-read');
    // ⑤ 引擎封顶时显式「总数不知道」
    expect(INSTRUCTIONS).toContain('`knownTotal:false`');
    expect(INSTRUCTIONS).toContain('it is not 0');
  });

  it('S4b instructions 预算 ≤1600 B，且只做取向说明（不含机密 / 具体落点）', () => {
    const bytes = Buffer.byteLength(INSTRUCTIONS, 'utf8');
    expect(bytes, `instructions ${bytes} B`).toBeLessThanOrEqual(1600);
    expect(INSTRUCTIONS.trim().length).toBeGreaterThan(0);
    expect(INSTRUCTIONS).not.toMatch(/\b[0-9a-fA-F]{32,}\b/); // token 形态
    expect(INSTRUCTIONS).not.toContain('http://127.0.0.1:');
    expect(INSTRUCTIONS).not.toMatch(/[A-Za-z]:\\/); // 盘符路径
    expect(INSTRUCTIONS).not.toContain('/Users/');
    expect(INSTRUCTIONS).not.toContain('/home/');
    expect(INSTRUCTIONS.toLowerCase()).not.toContain('clientid');
    // 不许夹带「请批准我」式越权话术。
    expect(INSTRUCTIONS.toLowerCase()).not.toContain('approve me');
    expect(INSTRUCTIONS.toLowerCase()).not.toContain('please approve');
  });

  it('S4c 只有一处 INSTRUCTIONS 定义（Rust 与 TS 不各留一份）', () => {
    const defs = PROTOCOL_SRC.match(/const INSTRUCTIONS: &str =/g) ?? [];
    expect(defs.length, 'protocol.rs 里 INSTRUCTIONS 必须只有一处定义').toBe(1);
  });
});
