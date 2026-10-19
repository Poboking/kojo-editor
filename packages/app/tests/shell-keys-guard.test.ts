import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_KEY_GATE_PRIORITY,
  isEditableKeyTarget,
  resolveGlobalKeyGate,
  shouldRunGlobalCommand,
  type GlobalCommandDecision,
} from '../src/ui/shell-keys';

/**
 * 全局快捷键闸门（2026-10-19 语言 P0 批）。
 *
 * 守的是两条实机缺陷：
 * ① 树内改名 / 过滤输入框出现时按 Ctrl+W / Ctrl+B：标签被关、侧栏被折，输入框 blur
 *    触发 onCancel，**一次改名静默作废**；
 * ② 无项目时 Ctrl+N 仍弹新建向导，而命令面板里同一条命令是灰的——键盘与面板两套口径。
 *
 * 测试环境是 node（无 jsdom）：元素替身按仓库既有做法（drag-drop.test.ts 的 fakeEl）
 * 给最小结构面，判定逻辑走 `nodeType` / `tagName` / `closest`，与真实 DOM 同一套判据。
 */

/** 最小元素替身：nodeType 1 + tagName + closest（只认本模块用到的两个选择器族） */
function fakeElement(spec: {
  readonly tagName: string;
  readonly contenteditable?: string | null;
  readonly inMonaco?: boolean;
}): EventTarget {
  const ce = spec.contenteditable ?? null;
  const el = {
    nodeType: 1,
    tagName: spec.tagName,
    closest(selector: string): unknown {
      if (selector.includes('.monaco-editor')) return spec.inMonaco === true ? el : null;
      if (selector.includes('contenteditable')) {
        return ce === '' || ce === 'true' ? el : null;
      }
      return null;
    },
  };
  return el as unknown as EventTarget;
}

describe('isEditableKeyTarget：输入面判定', () => {
  it('input / textarea / select 都算「正在输入」', () => {
    expect(isEditableKeyTarget(fakeElement({ tagName: 'INPUT' }))).toBe(true);
    expect(isEditableKeyTarget(fakeElement({ tagName: 'textarea' }))).toBe(true);
    expect(isEditableKeyTarget(fakeElement({ tagName: 'SELECT' }))).toBe(true);
  });

  it('contenteditable：空串与 "true" 算；"false" 与未设置不算', () => {
    expect(isEditableKeyTarget(fakeElement({ tagName: 'DIV', contenteditable: '' }))).toBe(true);
    expect(isEditableKeyTarget(fakeElement({ tagName: 'DIV', contenteditable: 'true' }))).toBe(true);
    expect(isEditableKeyTarget(fakeElement({ tagName: 'DIV', contenteditable: 'false' }))).toBe(false);
    expect(isEditableKeyTarget(fakeElement({ tagName: 'DIV' }))).toBe(false);
  });

  it('普通元素（body）与 null / 非元素一律 false', () => {
    expect(isEditableKeyTarget(fakeElement({ tagName: 'BODY' }))).toBe(false);
    expect(isEditableKeyTarget(null)).toBe(false);
    // 文本节点（nodeType 3）/ Document（9）/ 空对象：都不是 Element
    expect(isEditableKeyTarget({ nodeType: 3, tagName: '#text' } as unknown as EventTarget)).toBe(false);
    expect(isEditableKeyTarget({ nodeType: 9, tagName: '#document' } as unknown as EventTarget)).toBe(false);
    expect(isEditableKeyTarget({} as unknown as EventTarget)).toBe(false);
  });

  it('`.monaco-editor` 内的隐藏 textarea 不算：编辑器内 Ctrl+W / Ctrl+B 继续走宿主分发', () => {
    expect(
      isEditableKeyTarget(fakeElement({ tagName: 'TEXTAREA', inMonaco: true })),
    ).toBe(false);
  });

  it('Monaco 覆盖优先于输入面判据：可编辑子节点也在放行之列（VSCode 行为）', () => {
    expect(
      isEditableKeyTarget(
        fakeElement({ tagName: 'DIV', contenteditable: 'true', inMonaco: true }),
      ),
    ).toBe(false);
  });
});

/** 分发决策真值表：四类早退各一条 + 全通过一条 */
const DECISIONS: Array<[string, GlobalCommandDecision, boolean]> = [
  [
    '全通过（普通焦点 + 命令启用）⇒ 执行',
    { defaultPrevented: false, composing: false, editableTarget: false, enabled: true },
    true,
  ],
  [
    '早退①：内层已 preventDefault ⇒ 让位',
    { defaultPrevented: true, composing: false, editableTarget: false, enabled: true },
    false,
  ],
  [
    '早退②：输入法合成期 ⇒ 让位',
    { defaultPrevented: false, composing: true, editableTarget: false, enabled: true },
    false,
  ],
  [
    '早退③：事件目标正在输入 ⇒ 让位',
    { defaultPrevented: false, composing: false, editableTarget: true, enabled: true },
    false,
  ],
  [
    '早退④：命令禁用（when 不满足）⇒ 不吞键、不执行',
    { defaultPrevented: false, composing: false, editableTarget: false, enabled: false },
    false,
  ],
];

describe('shouldRunGlobalCommand：分发决策真值表', () => {
  it.each(DECISIONS)('%s', (_label, decision, expected) => {
    expect(shouldRunGlobalCommand(decision)).toBe(expected);
  });

  it('任一早退层命中即短路——即使命令是启用的（输入框里 Ctrl+W/Ctrl+B 不许落到布局）', () => {
    const blockers: readonly GlobalCommandDecision[] = [
      { defaultPrevented: true, composing: false, editableTarget: false, enabled: true },
      { defaultPrevented: false, composing: true, editableTarget: false, enabled: true },
      { defaultPrevented: false, composing: false, editableTarget: true, enabled: true },
    ];
    expect(blockers).toHaveLength(GLOBAL_KEY_GATE_PRIORITY.length);
    for (const decision of blockers) {
      expect(shouldRunGlobalCommand(decision)).toBe(false);
    }
  });
});

describe('resolveGlobalKeyGate：三层早退的顺序单源', () => {
  it('优先级钉死 defaultPrevented > composing > editableTarget', () => {
    expect([...GLOBAL_KEY_GATE_PRIORITY]).toEqual([
      'defaultPrevented',
      'composing',
      'editableTarget',
    ]);
  });

  it('同时命中多层只报最靠前的一层；全不命中返回 null', () => {
    expect(
      resolveGlobalKeyGate({ defaultPrevented: true, composing: true, editableTarget: true }),
    ).toBe('defaultPrevented');
    expect(
      resolveGlobalKeyGate({ defaultPrevented: false, composing: true, editableTarget: true }),
    ).toBe('composing');
    expect(
      resolveGlobalKeyGate({ defaultPrevented: false, composing: false, editableTarget: true }),
    ).toBe('editableTarget');
    expect(
      resolveGlobalKeyGate({ defaultPrevented: false, composing: false, editableTarget: false }),
    ).toBeNull();
  });
});

describe('显式回归钉：Monaco 内 Ctrl+W / Ctrl+B 仍放行', () => {
  it('隐藏 textarea 在 `.monaco-editor` 内 ⇒ editableTarget=false ⇒ 决策为 run', () => {
    const monacoTextarea = fakeElement({ tagName: 'TEXTAREA', inMonaco: true });
    expect(
      shouldRunGlobalCommand({
        defaultPrevented: false,
        composing: false,
        editableTarget: isEditableKeyTarget(monacoTextarea),
        enabled: true,
      }),
    ).toBe(true);
  });

  it('反例：树内改名框（普通 input）⇒ 决策为不 run（缺陷①的病灶）', () => {
    const renameInput = fakeElement({ tagName: 'INPUT' });
    expect(
      shouldRunGlobalCommand({
        defaultPrevented: false,
        composing: false,
        editableTarget: isEditableKeyTarget(renameInput),
        enabled: true,
      }),
    ).toBe(false);
  });
});

/**
 * 接线静态守门：纯函数对了还不够，壳层「接没接上」是最后会悄悄丢的一处
 * （node 环境不能渲染 ShellLayout，照 workspace-symbols.test.ts / ps10 的做法读源码钉）。
 */
describe('ShellLayout 接线（静态守门）', () => {
  const src = readFileSync(new URL('../src/ui/ShellLayout.tsx', import.meta.url), 'utf8');

  it('keydown 最前面走 resolveGlobalKeyGate 单源，且早于任何按键消费（含 Ctrl+K 和弦记录）', () => {
    const gateAt = src.indexOf('resolveGlobalKeyGate(keyEvidence)');
    expect(gateAt).toBeGreaterThan(-1);
    expect(src).toContain('editableTarget: isEditableKeyTarget(e.target)');
    expect(gateAt).toBeLessThan(src.indexOf("const k = e.key.toLowerCase()"));
  });

  it('注册表分发在 cmd.run 前过启用态闸（commandEnabled + shouldRunGlobalCommand）', () => {
    // 取最后一处：workbench API 里也有一句 `void cmd.run(commandCtxRef.current)`，
    // 注册表分发那处是文件末尾的全局 keydown 处理器
    const runAt = src.lastIndexOf('void cmd.run(commandCtxRef.current)');
    const enabledAt = src.lastIndexOf('commandEnabled(cmd, commandCtxRef.current)');
    const decisionAt = src.lastIndexOf('shouldRunGlobalCommand({');
    expect(runAt).toBeGreaterThan(-1);
    expect(enabledAt).toBeGreaterThan(-1);
    expect(decisionAt).toBeGreaterThan(-1);
    expect(enabledAt).toBeLessThan(runAt);
    expect(decisionAt).toBeLessThan(runAt);
  });
});
