/**
 * E2 联动单测：**保存时格式化 × 全角空格告警**——钉死"不双弹、也不把作者的选择吞成静默"。
 *
 * 为什么要跨包引 `@kojo/plugin-kojo-sugar`（解耦审计 C 项对测试豁免）：本文件要证的正是
 * "格式化 → 保存编排"这条**顺序**的语义，而告警的真源是 `planSave` 对它**拿到的那份文本**
 * 跑 `fullwidthSpaceLines`。所以必须用真的转译服务 + 真的规则函数，替身会把结论证空。
 *
 * 宿主那半边（`app/src/ui/format-on-save.ts` 的开关读取 / 异常降级）在
 * `packages/app/tests/format-on-save.test.ts` 里证；两半合起来就是完整链路。
 *
 * 三条结论：
 * 1. 偏好关着 ⇒ 现状逐字不变（缩进位的全角空格照样 `needs-choice`）；
 * 2. 偏好开着 ⇒ 缩进位/注释位的全角空格已被整理掉 ⇒ **不弹**，落盘与编译用的都是整理后的文本；
 * 3. 台词正文里的全角空格格式化**故意不动** ⇒ 仍弹，且只弹一次：
 *    「仍然保存」（带 acknowledge 重存）与「替换为半角并保存」（整篇替换后重存，
 *    第二轮格式化零改动）都不会出现第二个窗。
 */

import { describe, expect, it } from 'vitest';
import { FULLWIDTH_SPACE, type EditorSaveRequest, type SugarCompileResult } from '@kojo/plugin-api';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { createSugarTranspileService, formatText } from '@kojo/plugin-kojo-sugar';
import { performSugarSave, type SugarSaveDeps } from '../src/save-handler';

const PATH_KOJO = '/proj/x.kojo1';

/** 全角空格只出现在**行首缩进**（整理能消掉的那一类） */
const DOC_INDENT_FW = ['角色: 12', '时机 指令 310：', `${FULLWIDTH_SPACE}${FULLWIDTH_SPACE}「呀。」`].join('\n') + '\n';

/** 全角空格出现在**台词正文**（格式化故意不动的那一类） */
const DOC_TEXT_FW = ['角色: 12', '时机 指令 310：', `    「呀。」${FULLWIDTH_SPACE}嗯`].join('\n') + '\n';

interface Harness {
  readonly deps: SugarSaveDeps;
  readonly writes: Array<{ path: string; text: string }>;
  readonly compiles: Array<{ source: string; targetPath: string }>;
}

/** 真 `planSave` + 记录型 io：磁盘不碰，但"写了什么、编译了什么"逐条可断言 */
function harness(): Harness {
  const sugar = createSugarTranspileService({ faceTable: createEratwFaceTable() });
  const writes: Array<{ path: string; text: string }> = [];
  const compiles: Array<{ source: string; targetPath: string }> = [];
  const files = new Map<string, string>();
  const deps: SugarSaveDeps = {
    sugar: {
      planSave: (request) => sugar.planSave(request),
      compileToFile: async (source, targetPath): Promise<SugarCompileResult> => {
        compiles.push({ source, targetPath });
        return { erbPath: targetPath, byteSize: 7, backupPath: null, diagnostics: [] };
      },
    },
    io: {
      writeText: async (path, text) => {
        writes.push({ path, text });
        files.set(path, text);
      },
      readText: async (path) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`not found: ${path}`);
        return { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 1 };
      },
      exists: async (path) => files.has(path),
      removeFile: async (path) => {
        files.delete(path);
      },
    },
  };
  return { deps, writes, compiles };
}

const request = (text: string, choices?: EditorSaveRequest['choices']): EditorSaveRequest => ({
  path: PATH_KOJO,
  text,
  project: null,
  ...(choices ? { choices } : {}),
});

/** 宿主 `savePath` 里的那一步：开着就先整理，关着原样交给链路 */
const hostFormatStep = (text: string, enabled: boolean): string =>
  enabled ? formatText(text, 'kojo').text : text;

describe('前提：两份样例文档都能编译（否则"不弹"是被 blocked 顶掉的假结论）', () => {
  it('planSave 不 blocked，且全角空格行号正是样例设计的那一行', () => {
    const sugar = createSugarTranspileService({ faceTable: createEratwFaceTable() });
    for (const doc of [DOC_INDENT_FW, DOC_TEXT_FW]) {
      const plan = sugar.planSave({ source: doc, sourcePath: PATH_KOJO });
      expect(plan.blocked, doc).toBe(false);
      expect(plan.fullwidthSpaceLines, doc).toEqual([3]);
    }
  });
});

describe('偏好关着：现状逐字不变', () => {
  it('缩进位的全角空格照样 needs-choice，且磁盘一个字都没写', async () => {
    const h = harness();
    const out = await performSugarSave(h.deps, request(hostFormatStep(DOC_INDENT_FW, false)));
    expect(out.status).toBe('needs-choice');
    if (out.status !== 'needs-choice') return;
    expect(out.warning.kind).toBe('fullwidth-space');
    expect(out.warning.lines).toEqual([3]);
    expect(h.writes).toEqual([]);
    expect(h.compiles).toEqual([]);
  });
});

describe('偏好开着：整理过的位置不再弹', () => {
  it('needs-choice 消失，源与产物用的都是整理后的文本', async () => {
    const formatted = hostFormatStep(DOC_INDENT_FW, true);
    expect(formatted).not.toBe(DOC_INDENT_FW);
    expect(formatted).toContain('    「呀。」');

    const h = harness();
    const out = await performSugarSave(h.deps, request(formatted));
    expect(out.status).toBe('saved');
    expect(h.writes).toEqual([{ path: PATH_KOJO, text: formatted }]);
    expect(h.compiles).toHaveLength(1);
    expect(h.compiles[0]!.source).toBe(formatted);
  });

  it('行尾风格随整理后的文本一路到底（io 收到的仍是 CRLF，一格没被换算）', async () => {
    const crlf = DOC_INDENT_FW.replace(/\n/g, '\r\n');
    const formatted = hostFormatStep(crlf, true);
    const lf = (formatted.match(/\n/g) ?? []).length;
    const wanted = (crlf.match(/\r\n/g) ?? []).length;
    expect(wanted).toBeGreaterThan(0);
    // 每一个 LF 都跟在 CR 后面 ⇒ 整理没有引入裸 LF（也没有把 CRLF 拆开）
    expect(lf).toBe(wanted);

    const h = harness();
    await performSugarSave(h.deps, request(formatted));
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.text).toBe(formatted);
  });
});

describe('偏好开着：台词正文里的全角空格仍要问，但只问一次', () => {
  it('第一轮 needs-choice（行号仍是正文那一行）', async () => {
    const formatted = hostFormatStep(DOC_TEXT_FW, true);
    const h = harness();
    const out = await performSugarSave(h.deps, request(formatted));
    expect(out.status).toBe('needs-choice');
    expect(h.writes).toEqual([]);
  });

  it('「仍然保存」= 带 acknowledge 重存 ⇒ saved，且第二次不会再要选择', async () => {
    const formatted = hostFormatStep(DOC_TEXT_FW, true);
    const h = harness();
    const out = await performSugarSave(h.deps, request(formatted, { acknowledgeFullwidthSpace: true }));
    expect(out.status).toBe('saved');
    expect(h.writes).toEqual([{ path: PATH_KOJO, text: formatted }]);
  });

  it('「替换为半角并保存」= 整篇替换后重存 ⇒ 第二轮格式化零改动（这正是"不双弹"的依据）', async () => {
    const formatted = hostFormatStep(DOC_TEXT_FW, true);
    // 宿主 `decideSaveWarning('fix-and-save')` 的动作本体（同一条替换口径）
    const fixed = formatted.split(FULLWIDTH_SPACE).join(' ');
    expect(formatText(fixed, 'kojo').edits).toEqual([]);

    const h = harness();
    const out = await performSugarSave(h.deps, request(hostFormatStep(fixed, true)));
    expect(out.status).toBe('saved');
    expect(h.writes).toEqual([{ path: PATH_KOJO, text: fixed }]);
  });

  it('关着时同一份文本照样弹（对照：弹不弹取决于偏好，不取决于文档长相变了没）', async () => {
    const h = harness();
    const out = await performSugarSave(h.deps, request(hostFormatStep(DOC_TEXT_FW, false)));
    expect(out.status).toBe('needs-choice');
  });
});
