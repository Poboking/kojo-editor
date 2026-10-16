import { editor, Uri } from '../monaco/entry';
import {
  applyLineEdits,
  compileReplaceMatcher,
  planLineEdit,
  planSingleReplacement,
  type FileLineEdit,
  type ReplaceMatcher,
} from './search-replace';
import type { MatchTarget, ReplaceOutcome, ReplaceRequest, SearchOptionsState } from './search-store';

/**
 * 替换执行器（宿主层装配）：把替换计划落成**两种通道**——与 `erb-rename.ts` 先例同形。
 *
 * - **已打开**：Monaco live model 逐行现匹配 + `applyEdits`（原生脏标记 / 撤销步全套现成）；
 *   model 从 Monaco 全局注册表按 `file:` URI 取——EditorPane 只用 `Uri.file(path)` 建
 *   真文件 model，糖视图 model 是 `inmemory://sugar/` scheme（见 EditorPane），注册表
 *   按路径取永不撞上派生物。
 * - **未打开**：内核 io 读改写（保编码保换行 + 原子写 + 备份，写允许域由内核 io 强制
 *   ——绕开写允许域没有第二条路，铁律 6）。**只读文件逐文件跳过并计数**，汇总明示
 *   「n 个文件只读未改」，不静默丢。
 *
 * 每一处替换都在**现文本**上重新匹配（全部替换 = 现场重扫；单条替换 = sticky 定列验证
 * + 与检索原文比对），陈旧坐标绝不硬写。全部替换走文件的**每一行**——检索结果只是
 * 预览，替换以现状为准（与 VSCode「全部替换」同语义）。编辑计划与降序应用全在
 * `search-replace.ts` 纯逻辑（node 单测钉死），本模块只做 Monaco 协议翻译与 io 编排。
 */

/** 降序应用交给纯逻辑；这里只把行号数组与 io 往返接起来 */
function rewriteClosedText(
  text: string,
  m: ReplaceMatcher,
  template: string,
): { edits: readonly FileLineEdit[]; next: string } {
  const lines = text.split('\n');
  const edits: FileLineEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const e of planLineEdit(lines[i]!, m, template)) {
      edits.push({ lineNumber: i + 1, start: e.start, end: e.end, text: e.text });
    }
  }
  return { edits, next: edits.length > 0 ? applyLineEdits(lines, edits) : text };
}

function outcome(patch: Partial<ReplaceOutcome>): ReplaceOutcome {
  return { applied: 0, filesChanged: 0, stale: 0, readOnlyFiles: 0, errors: [], ...patch };
}

export interface FileReplaceDeps {
  io: {
    isWritable(path: string): boolean;
    readText(path: string): Promise<{ text: string }>;
    writeText(path: string, text: string): Promise<void>;
  };
  /** 已打开文件的 live model 查找（缺省 = Monaco 注册表按 file: URI） */
  modelFor?: (path: string) => editor.ITextModel | undefined;
}

/**
 * 组装替换执行器（browser 侧装配；单测打 `modelFor` + 假 io，不 import 本模块）。
 */
export function createFileReplaceRunner(
  deps: FileReplaceDeps,
): (request: ReplaceRequest) => Promise<ReplaceOutcome> {
  const modelFor =
    deps.modelFor ?? ((path: string) => editor.getModel(Uri.file(path)) as editor.ITextModel | undefined);

  /** 已打开 model：逐行现匹配 → applyEdits（一次调用 = 一步撤销） */
  const replaceInModel = (
    model: editor.ITextModel,
    m: ReplaceMatcher,
    template: string,
  ): number => {
    const count = model.getLineCount();
    const ops: Array<{
      range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
      text: string;
    }> = [];
    for (let ln = 1; ln <= count; ln++) {
      const line = model.getLineContent(ln);
      for (const e of planLineEdit(line, m, template)) {
        ops.push({
          range: {
            startLineNumber: ln,
            startColumn: e.start + 1,
            endLineNumber: ln,
            endColumn: e.end + 1,
          },
          text: e.text,
        });
      }
    }
    if (ops.length > 0) model.applyEdits(ops);
    return ops.length;
  };

  /** 未打开：io 读 → 逐行现匹配 → 有实改才写回（保编码保换行由内核兜住） */
  const replaceInClosedFile = async (
    path: string,
    m: ReplaceMatcher,
    template: string,
  ): Promise<{ applied: number }> => {
    const { text } = await deps.io.readText(path);
    const { edits, next } = rewriteClosedText(text, m, template);
    if (edits.length === 0) return { applied: 0 };
    await deps.io.writeText(path, next);
    return { applied: edits.length };
  };

  return async (request: ReplaceRequest): Promise<ReplaceOutcome> => {
    const opts: Pick<SearchOptionsState, 'isRegex' | 'caseSensitive' | 'wholeWord'> = {
      isRegex: request.options.isRegex,
      caseSensitive: request.options.caseSensitive,
      wholeWord: request.options.wholeWord,
    };
    let m: ReplaceMatcher | null = null;
    try {
      m = compileReplaceMatcher(request.query, opts);
    } catch (e: unknown) {
      return outcome({ errors: [`检索词不是有效正则：${e instanceof Error ? e.message : String(e)}`] });
    }
    if (m === null) return outcome({ errors: ['检索词为空，未替换'] });

    if (request.mode.kind === 'one') return replaceOne(request.mode.target, m, request.replaceText);

    // ---- 全部替换：结果里的文件逐个落（截断/取消的结果不允许走到这里，store 已挡）----
    const seen = new Set<string>();
    let applied = 0;
    let filesChanged = 0;
    let readOnlyFiles = 0;
    const errors: string[] = [];
    for (const f of request.files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      const open = modelFor(f.path);
      if (open !== undefined) {
        try {
          const n = replaceInModel(open, m, request.replaceText);
          if (n > 0) {
            applied += n;
            filesChanged++;
          }
        } catch (e: unknown) {
          errors.push(`${f.path}：${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }
      if (!deps.io.isWritable(f.path)) {
        readOnlyFiles++;
        continue;
      }
      try {
        const { applied: n } = await replaceInClosedFile(f.path, m, request.replaceText);
        if (n > 0) {
          applied += n;
          filesChanged++;
        }
      } catch (e: unknown) {
        // 写允许域 / io 故障：逐文件可见，不中断其余文件（铁律 4：不静默）
        errors.push(`${f.path}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return outcome({ applied, filesChanged, readOnlyFiles, errors });

    // ---- 单条替换：检索行列定起点，sticky 验证后单点落 ----
    async function replaceOne(
      target: MatchTarget,
      matcher: ReplaceMatcher,
      template: string,
    ): Promise<ReplaceOutcome> {
      const file = request.files.find((f) => f.path === target.path);
      const match = file?.matches.find((mm) => mm.line === target.line && mm.column === target.column);
      // 检索结果里找不回这条命中 = 行列已陈旧，按验证失败处理（不猜）
      const expected = match !== undefined ? match.preview.slice(match.start, match.end) : null;
      const open = modelFor(target.path);
      if (open !== undefined) {
        if (target.line < 1 || target.line > open.getLineCount()) {
          return outcome({ stale: 1, errors: ['该行已不存在（文本已变化），未替换'] });
        }
        const line = open.getLineContent(target.line);
        const v = planSingleReplacement(line, target.column - 1, matcher, template, expected);
        if (v.kind === 'skip') return outcome({ stale: 1, errors: [v.reason] });
        open.applyEdits([
          {
            range: {
              startLineNumber: target.line,
              startColumn: v.start + 1,
              endLineNumber: target.line,
              endColumn: v.end + 1,
            },
            text: v.text,
          },
        ]);
        return outcome({ applied: 1, filesChanged: 1 });
      }
      if (!deps.io.isWritable(target.path)) {
        return outcome({ readOnlyFiles: 1, errors: ['该文件只读（写权限未批准），未替换'] });
      }
      try {
        const { text } = await deps.io.readText(target.path);
        const lines = text.split('\n');
        if (target.line < 1 || target.line > lines.length) {
          return outcome({ stale: 1, errors: ['该行已不存在（文本已变化），未替换'] });
        }
        const v = planSingleReplacement(lines[target.line - 1]!, target.column - 1, matcher, template, expected);
        if (v.kind === 'skip') return outcome({ stale: 1, errors: [v.reason] });
        const line = lines[target.line - 1]!;
        lines[target.line - 1] = line.slice(0, v.start) + v.text + line.slice(v.end);
        await deps.io.writeText(target.path, lines.join('\n'));
        return outcome({ applied: 1, filesChanged: 1 });
      } catch (e: unknown) {
        return outcome({ errors: [`${target.path}：${e instanceof Error ? e.message : String(e)}`] });
      }
    }
  };
}
