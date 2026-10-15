/**
 * G1「看这一行的状态」——宿主位点折叠片的单测（零 React、零 DOM；2026-10-16 批）。
 *
 * 钉三件事：
 * 1. **每一态都有一句话**（铁律 4：按了没反应是这批最坏的失败模式）——
 *    没编辑器 / 派生视图 / 这一行不在函数里 / 语言服务没答，四种都必须 `say`；
 * 2. **只交中性名字**：折出来的是符号树里的名字，宿主不做大小写口径、
 *    不认 ERB / 家族 / 条件（那条判据的归属在 `breadcrumb-path.ts` 的 `symbolChainAt`）；
 * 3. **发意图的载荷形状**：`locate` 带的是"文件 + 行"，函数名原样带上——
 *    判定权在回放面板，宿主不许替它算好结论。
 */
import { describe, expect, it } from 'vitest';
import type { EditorDocumentSymbol } from '@kojo/plugin-api';
import {
  readJumpProbe,
  requestJumpToState,
  setJumpProbe,
  planJumpToState,
  functionNameAt,
  type JumpProbeResult,
  type ReplayIntent,
} from '../src/ui/jump-to-state';

const fn = (name: string, startLine: number, endLine: number, children?: EditorDocumentSymbol[]): EditorDocumentSymbol => ({
  name,
  kind: 'function',
  startLine,
  endLine,
  ...(children ? { children } : {}),
});

const node = (
  name: string,
  kind: EditorDocumentSymbol['kind'],
  startLine: number,
  endLine: number,
  children?: EditorDocumentSymbol[],
): EditorDocumentSymbol => ({
  name,
  kind,
  startLine,
  endLine,
  ...(children ? { children } : {}),
});

const probe = (over: Partial<JumpProbeResult> = {}): JumpProbeResult => ({
  path: 'C:/game/kojo/a.erb',
  line: 12,
  symbols: [fn('M_KOJO_K12_310', 11, 30)],
  derivedView: false,
  ...over,
});

describe('planJumpToState — 兑现不了必须说一句人话', () => {
  it('没有编辑器位点（未挂载 / 没打开文件）→ say，且给出下一步', () => {
    const plan = planJumpToState(null);
    expect(plan.kind).toBe('say');
    if (plan.kind === 'say') {
      expect(plan.message).toContain('打开');
      expect(plan.message.length).toBeGreaterThan(8);
    }
  });

  it('派生视图（行号不属于这份文件）→ say，并指明怎么切回去', () => {
    const plan = planJumpToState(probe({ derivedView: true }));
    expect(plan.kind).toBe('say');
    if (plan.kind === 'say') expect(plan.message).toContain('Ctrl+Alt+T');
  });

  it('语言服务没答出来（symbols = null）→ say，不猜函数名', () => {
    expect(planJumpToState(probe({ symbols: null })).kind).toBe('say');
    expect(planJumpToState(probe({ symbols: [] })).kind).toBe('say');
  });

  it('这一行不在任何函数里 → say，并把行号说给作者', () => {
    const plan = planJumpToState(probe({ line: 99, symbols: [fn('M_A', 11, 30)] }));
    expect(plan.kind).toBe('say');
    if (plan.kind === 'say') expect(plan.message).toContain('99');
  });

  it('四种回话都不许出现引擎黑话', () => {
    const messages = [
      planJumpToState(null),
      planJumpToState(probe({ derivedView: true })),
      planJumpToState(probe({ symbols: null })),
      planJumpToState(probe({ line: 99 })),
    ].map((p) => (p.kind === 'say' ? p.message : ''));
    expect(messages.every((m) => m.length > 0)).toBe(true);
    for (const message of messages) {
      for (const jargon of ['回放', '谓词', '矩阵', 'replay', 'predicate', 'matrix', 'locate', 'symbol']) {
        expect(message.toLowerCase()).not.toContain(jargon.toLowerCase());
      }
    }
  });
});

describe('planJumpToState — 位点折成意图', () => {
  it('给出函数名 + 原样位点（文件 + 光标行），不做二次加工', () => {
    const plan = planJumpToState(probe({ line: 14, path: 'C:/game/kojo/消息.ERB' }));
    expect(plan.kind).toBe('replay');
    if (plan.kind === 'replay') {
      expect(plan.intent).toEqual({
        functionName: 'M_KOJO_K12_310',
        locate: { filePath: 'C:/game/kojo/消息.ERB', line: 14 },
      });
    }
  });

  it('名字口径原样送（大小写归一是对方的事，宿主不立第二个标准）', () => {
    const plan = planJumpToState(probe({ symbols: [fn('m_kojo_x', 11, 30)] }));
    expect(plan.kind === 'replay' && plan.intent.functionName).toBe('m_kojo_x');
  });
});

describe('functionNameAt — 取最靠内的 function 层', () => {
  it('嵌套形状：块在内、函数在外 → 取函数那一级（面包屑同一条链判据）', () => {
    const tree = [fn('M_A', 10, 40, [node('分支', 'block', 12, 20)])];
    expect(functionNameAt(tree, 15)).toBe('M_A');
  });

  it('平铺形状（ERB：函数区间与 `#DIM` 声明同层并列）→ 取函数，不被单行声明顶掉', () => {
    // 这一档正是面包屑 `symbolChainAt` 的判据会漏掉的形状（每层只留区间最小的一枚，
    // 单行声明比函数紧 ⇒ 外层函数在同层淘汰中消失 ⇒ 假答案"不在任何函数里"）
    const tree = [fn('M_A', 10, 40), node('CFLAG', 'declaration', 20, 20)];
    expect(functionNameAt(tree, 20)).toBe('M_A');
  });

  it('同宽双胞胎取文档序第一枚（确定性，不留随机跳转）', () => {
    const tree = [fn('M_A', 10, 20), fn('M_B', 10, 20)];
    expect(functionNameAt(tree, 15)).toBe('M_A');
  });

  it('嵌套函数取最内层（区间更紧的那一枚）', () => {
    const tree = [fn('M_OUT', 1, 100, [fn('M_IN', 40, 60)])];
    expect(functionNameAt(tree, 50)).toBe('M_IN');
  });

  it('只有非函数层（`.kojo` 的时机块）→ null（宿主不替回放侧猜名字）', () => {
    const tree = [node('时机 指令 310', 'section', 2, 40, [node('段', 'block', 5, 20)])];
    expect(functionNameAt(tree, 10)).toBeNull();
  });

  it('名字空白 = 没有名字（不给空串去查记录）', () => {
    expect(functionNameAt([fn('   ', 10, 40)], 12)).toBeNull();
  });

  it('行号落在两段之间 → null（区间不重叠是 ERB 侧的既有口径）', () => {
    const tree = [fn('M_A', 10, 20), fn('M_B', 21, 30)];
    expect(functionNameAt(tree, 40)).toBeNull();
  });
});

describe('requestJumpToState — 两个出口', () => {
  const collect = (source: JumpProbeResult | null) => {
    const intents: ReplayIntent[] = [];
    const said: string[] = [];
    const kind = requestJumpToState({
      probe: () => source,
      emit: (intent) => intents.push(intent),
      say: (message) => said.push(message),
    });
    return { kind, intents, said };
  };

  it('能兑现：只发意图，不回话', () => {
    const r = collect(probe());
    expect(r.kind).toBe('replay');
    expect(r.intents).toHaveLength(1);
    expect(r.said).toHaveLength(0);
  });

  it('兑现不了：只回话，不发意图（面板不会被半吊子请求打扰）', () => {
    const r = collect(probe({ line: 99 }));
    expect(r.kind).toBe('say');
    expect(r.intents).toHaveLength(0);
    expect(r.said).toHaveLength(1);
  });
});

describe('位点探针的注册（模块级单源）', () => {
  it('未注册 → null；注册后可读；清空回到 null（编辑器卸载不许留下悬探针）', () => {
    setJumpProbe(null);
    expect(readJumpProbe()).toBeNull();
    setJumpProbe(() => probe({ line: 7 }));
    expect(readJumpProbe()?.line).toBe(7);
    setJumpProbe(() => null); // 探针自己说"现在没有位点"
    expect(readJumpProbe()).toBeNull();
    setJumpProbe(null);
    expect(readJumpProbe()).toBeNull();
  });
});

describe('命令入口恒在注册表（与「切换 .kojo 预览」同一片）', () => {
  const read = async (): Promise<string> => {
    const { readFileSync } = await import('node:fs');
    return readFileSync(new URL('../src/ui/ProjectView.tsx', import.meta.url), 'utf8');
  };

  it('workbench.jumpToState 带快捷键注册进 extraCommands', async () => {
    const src = await read();
    expect(src).toContain("id: 'workbench.jumpToState'");
    expect(src).toContain("keybinding: 'ctrl+alt+s'");
    expect(src).toContain("title: '看这一行的状态'");
    // 刻意不给 when：灰掉不说话就是"按了没反应"（铁律 4）
    expect(src).not.toMatch(/jumpToState[\s\S]{0,200}when:/);
  });
});
