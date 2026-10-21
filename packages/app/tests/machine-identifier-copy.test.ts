import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { opKindLabel } from '../src/ui/ops-history';

/**
 * 作者面文案守卫（2026-10-19 用户反馈批）：**机器标识不上屏**。
 *
 * 这批修的是同一类病：内部 API 名（`kernel.ops` / `Monaco 注册表` / `functionFamilyIndex`）、
 * 机器 id（op id `op-<时间戳>-<随机>`、插件 id、原始 kind）、以及把原始异常串当常驻 chrome。
 * 一句一句改完如果只留单测，下一次照样能再漏一遍——所以这里守的是**文案的形态**：
 *
 * ① **不许复活的旧形态**（`LEAK_PHRASES` / `LEAK_SHAPES`）：旧原话逐字列出，加上三类结构性
 *    形态（kind 兜底回落到自身、屏上句子插机器 id、屏上句子插提供方 id）；
 * ② **修好的原话必须还在**（`PINNED_COPY`：文件 + 逐字片段 + 处数，多一处少一处都红）——
 *    防的是"改漏了别处顺手删一句"和"同一句话在两处各抄一份"；
 * ③ **合法露面的台账**（`ON_SCREEN_MACHINE_ID_EXEMPTIONS`）：机器标识确有该露的地方
 *    （插件状态面板的主体就是插件本身、原始错误只进悬停 title），逐条钉到行 + 处数，
 *    台账本身也是账：豁免的行消失了同样红。
 *
 * 与 `kojo-extension-single-source.test.ts` 的差别（别照抄那边的手法）：那边**连注释一起查**，
 * 因为它防的是"把判据抄进宿主"，注释正是抄判据的第一站；这里防的是**上屏文本**，而本仓注释
 * 引用内部标识（`kernel.ops` 这类）是正当的工程语言——所以扫描前先剔注释，只盯代码行。
 * 判据落在"代码行"上还有一个好处：把修好的原话挪进注释（等于从屏上删了）会被 ② 判红。
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** 本批审计过的文案文件：app 侧的宿主 copy + 各插件的上屏文案宿主 */
const COPY_FILES = [
  'packages/app/src/ui/App.tsx',
  // REF-FRONT-PERF：项目生命周期 / 错误条 / 错误边界的新文案面
  'packages/app/src/ui/use-project-session.ts',
  'packages/app/src/ui/project-close.ts',
  'packages/app/src/ui/project-error-notice.tsx',
  // WRITE-ADMIT-SPLIT 出路①：宿主写域事实与那颗出路按钮的上屏句子都住这里
  'packages/app/src/ui/write-domain.ts',
  // SAVE-BUTTON-IO-SEAM 出路②：保存按钮置灰态的悬停句子引用 write-domain 同一份文案，
  // 组件本体只消费布尔判定——句子字面量不许在这颗按钮上重抄一份
  'packages/app/src/ui/save-button.tsx',
  'packages/app/src/ui/error-boundary.tsx',
  'packages/app/src/ui/CallHierarchyOverlay.tsx',
  'packages/app/src/ui/FileHistoryOverlay.tsx',
  'packages/app/src/ui/OpsHistoryOverlay.tsx',
  'packages/app/src/ui/ShellLayout.tsx',
  'packages/app/src/ui/file-history.ts',
  'packages/app/src/ui/ops-history.ts',
  'packages/app/src/ui/search-replace-exec.ts',
  'packages/app/src/ui/search-scope.ts',
  'packages/plugins/state-replay/src/evaluate.ts',
  'packages/plugins/state-replay/src/state-view.ts',
  'packages/plugins/ui-condition-matrix/src/index.ts',
  'packages/plugins/ui-plugin-status/src/maintenance.ts',
  'packages/plugins/ui-plugin-status/src/index.ts',
  'packages/plugins/ui-state-replay/src/preview.ts',
  'packages/plugins/ui-state-replay/src/scene-actions.ts',
  'packages/plugins/ui-sugar-editor/src/new-file-wizard.ts',
] as const;

/**
 * 逐行剥注释后的代码行（引号态跟踪：`'` / `"` / `` ` `` 里的 `//` 不是注释起点）。
 * 返回 `{ at, text }`，`at` = `file:line`，报错时直接能点回原位。
 */
function codeLines(rel: string): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  let inBlock = false;
  readFileSync(path.join(ROOT, rel), 'utf8')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      let text = '';
      let quote: string | null = null;
      for (let k = 0; k < raw.length; k += 1) {
        const ch = raw[k]!;
        const next = raw[k + 1];
        if (inBlock) {
          if (ch === '*' && next === '/') {
            inBlock = false;
            k += 1;
          }
          continue;
        }
        if (quote !== null) {
          text += ch;
          if (ch === '\\') {
            text += next ?? '';
            k += 1;
          } else if (ch === quote) {
            quote = null;
          }
          continue;
        }
        if (ch === '/' && next === '/') break;
        if (ch === '/' && next === '*') {
          inBlock = true;
          k += 1;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        text += ch;
      }
      out.push({ at: `${rel}:${i + 1}`, text });
    });
  return out;
}

/* ─────────────────── ① 不许复活的旧形态（逐字 / 结构） ─────────────────── */

/** 旧原话里的机器标识片段（逐字；扫描的是剥注释后的代码行，散文里的同一串不算） */
const LEAK_PHRASES: readonly { readonly phrase: string; readonly why: string }[] = [
  { phrase: 'kernel.ops 未注册', why: '内部服务键当成了给作者的解释' },
  { phrase: 'kernel.ops 不在位', why: '同上（时间线 notes 那两处）' },
  { phrase: 'kernel.io 未注册', why: '内部服务键（回收站恢复/彻底删除）' },
  { phrase: 'kernel.io 句柄不在位', why: '内部服务键 + 句柄，两处内部词叠在一起' },
  { phrase: '解析器未构建 references', why: '契约字段名 references 上屏' },
  { phrase: 'Monaco 注册表未就绪', why: '编辑器实现名当成了给作者的解释' },
  { phrase: '（将只允许 appDataDir 写入）', why: '宿主路径 API 名上屏' },
  { phrase: '没有提供 functionFamilyIndex', why: '契约字段名上屏（条件矩阵空态）' },
  { phrase: 'kojoFaceTemplates.registration.declare', why: '契约属性路径上屏（新建向导降级）' },
  { phrase: '工作区 artifact：', why: '内部数据模型名 artifact 当标题（屏上同一处写着「我的口上项目」）' },
  { phrase: 'open 残留', why: 'op 文档的内部状态词 open 上屏（维护明细）' },
  { phrase: 'rename 词无法求值', why: '表达式类别码 rename 混进中文句子' },
  { phrase: 'int 全 0', why: '槽位类型码 int / str 上屏' },
];

/** 结构性复发形态：机器 id / kind 直接拼进屏上句子 */
const LEAK_SHAPES: readonly { readonly re: RegExp; readonly why: string }[] = [
  {
    re: /KIND_LABELS\[[a-zA-Z]*\]\s*\?\?\s*kind\b/,
    why: '未登记 kind 兜底回落到自身 = 把内部类别码原样上屏',
  },
  {
    re: /KIND_LABELS\[kind\.slice\(5\)\]\s*\?\?\s*kind\.slice\(5\)/,
    why: 'undo:<kind> 的兜底同样不许把类别码上屏',
  },
  {
    re: /已撤销「\$\{[^}]*item\.id[^}]*\}」/,
    why: '回调成功提示里插 op id（`op-<时间戳>-<随机>`）',
  },
  {
    re: /范围提供方「\$\{(?:owner|contribution\.id)\}/,
    why: '搜索范围提示里插插件 id',
  },
  {
    re: /["'`][^"'`\n]*(?:kernel\.(?:ops|io)|Monaco\b|appDataDir|functionFamilyIndex|kojoFaceTemplates|registration\.declare)/,
    why: '内部 API 名被写进了字符串（上屏文本一律不许出现）',
  },
];

describe('① 旧形态不许复活（剥注释后逐行扫）', () => {
  it.each(COPY_FILES)('无旧原话残句：%s', (rel) => {
    const hits = codeLines(rel)
      .filter(({ text }) => LEAK_PHRASES.some(({ phrase }) => text.includes(phrase)))
      .map(({ at, text }) => `${at} ${text.trim().slice(0, 100)}`);
    expect(hits).toEqual([]);
  });

  it.each(COPY_FILES)('无结构性复发（id / kind / API 名拼进文案）：%s', (rel) => {
    const hits = codeLines(rel)
      .filter(({ text }) => LEAK_SHAPES.some(({ re }) => re.test(text)))
      .map(({ at, text }) => `${at} ${text.trim().slice(0, 100)}`);
    expect(hits).toEqual([]);
  });
});

/* ─────────────────── ② 修好的原话还在（处数钉死） ─────────────────── */

/**
 * 屏上原话逐字钉住：`count` = 该文件代码行里出现的次数（**多一处少一处都红**）。
 * 少一处 = 被改回去了 / 被挪进注释（等于从屏上删掉）；多一处 = 同一句话被抄了第二份。
 */
const PINNED_COPY: readonly {
  readonly file: (typeof COPY_FILES)[number];
  readonly phrase: string;
  readonly count: number;
  readonly why: string;
}[] = [
  {
    file: 'packages/app/src/ui/write-domain.ts',
    phrase: '这个项目文件夹眼下不能写入',
    count: 1,
    why: 'fail-closed 的后果说人话：机制名「写允许域」与宿主路径 API 名都不上屏，落点改说「编辑器自己的文件夹」；句首不写「可写范围登记失败」——尾接的 Rust 原句自带「可写范围…」，同一个词在一句里出现两遍就是叠话（REF-FRONT-PERF 后这句随 openProject 搬进 hook；WRITE-ADMIT-SPLIT 出路①再搬进本文件——第一次登记与点按钮重交付共用这一份文案，不许两处各抄）',
  },
  {
    file: 'packages/app/src/ui/write-domain.ts',
    phrase: '重新选择这个文件夹',
    count: 1,
    why: '出路那颗按钮的中文名，与原生选目录框标题同源（同一个 const ⇒ 屏幕上不会出现两种叫法；作者面不写「重新交付」「准入门」这类机制词；SAVE-BUTTON-IO-SEAM 出路② 的保存停用句用插值引用它，字面量不增处）',
  },
  {
    file: 'packages/app/src/ui/write-domain.ts',
    phrase: '这个文件夹还没有交给编辑器写入',
    count: 1,
    why: 'SAVE-BUTTON-IO-SEAM 出路②：宿主拒绝态下保存按钮的悬停与 Ctrl+S 前置拦截共用这同一句（按钮 title 与通知引用同一个 const）；只指路到那条常驻错误条与那颗出路按钮，「准入门」「写允许域」等机制词不上屏',
  },
  {
    file: 'packages/app/src/ui/write-domain.ts',
    phrase: '在弹出的系统选目录框里选回这个项目文件夹，编辑器才会允许写入',
    count: 1,
    why: '按钮 title：那几个字说不清的"点下去会发生什么"放悬停里（说的是系统框与写入许可，不出现对话框命令名）',
  },
  {
    file: 'packages/app/src/ui/write-domain.ts',
    phrase: '宿主没有说明原因',
    count: 1,
    why: '原因缺省也要成句：屏上绝不出现 undefined',
  },
  {
    file: 'packages/app/src/ui/CallHierarchyOverlay.tsx',
    phrase: '解析器还没交出引用台账',
    count: 1,
    why: '契约字段 references 换成人话',
  },
  {
    file: 'packages/app/src/ui/FileHistoryOverlay.tsx',
    phrase: '批操作账暂时不可用（内核没有交出批操作记录）',
    count: 1,
    why: 'kernel.ops 缺席的解释说人话',
  },
  {
    file: 'packages/app/src/ui/FileHistoryOverlay.tsx',
    phrase: '在对比视图里看这一条与磁盘当前内容的逐行差异',
    count: 1,
    why: '与屏上「对比」按钮同名；不再点 Monaco',
  },
  {
    file: 'packages/app/src/ui/OpsHistoryOverlay.tsx',
    phrase: '回收站暂时不可用（没有接上文件读写通道）',
    count: 2,
    why: '彻底删除 / 放回原位两条路各一句（同一口径，不许只改一条）',
  },
  {
    file: 'packages/app/src/ui/OpsHistoryOverlay.tsx',
    phrase: '已撤销「${label}」',
    count: 1,
    why: '撤销回执说的是账本 label（人话），不是 op id',
  },
  {
    file: 'packages/app/src/ui/OpsHistoryOverlay.tsx',
    phrase: '编辑器内的普通编辑走编辑器自己的 Ctrl+Z',
    count: 1,
    why: '讲 Ctrl+Z 不必点名编辑器实现（Monaco）',
  },
  {
    file: 'packages/app/src/ui/file-history.ts',
    phrase: '回滚不动编辑器的撤销栈',
    count: 1,
    why: '同上：撤销栈是编辑器的，不是 Monaco 的',
  },
  {
    file: 'packages/app/src/ui/ShellLayout.tsx',
    phrase: '索引失败',
    count: 2,
    why: '状态栏一格只说状态（title 里那句 + 这一句；原文只进悬停）',
  },
  {
    file: 'packages/app/src/ui/ShellLayout.tsx',
    phrase: 'title={`索引失败：${stats.indexError}`}',
    count: 1,
    why: '原始错误逐字留在悬停里，技术信息一条不丢',
  },
  {
    file: 'packages/app/src/ui/file-history.ts',
    phrase: '内核没有交出批操作记录',
    count: 2,
    why: '单文件时间线 / 全局时间线两条 notes 同口径',
  },
  {
    file: 'packages/app/src/ui/file-history.ts',
    phrase: '宿主没有交出文件读写通道',
    count: 1,
    why: '回收站账缺席的 notes',
  },
  {
    file: 'packages/app/src/ui/file-history.ts',
    phrase: '在对比视图里逐行对比选中的这两版',
    count: 1,
    why: '两版互比按钮的启用理由与「对比两版」同名',
  },
  {
    file: 'packages/app/src/ui/ops-history.ts',
    phrase: "const UNKNOWN_KIND_LABEL = '其它操作';",
    count: 1,
    why: '未登记 kind 的唯一兜底',
  },
  {
    file: 'packages/app/src/ui/search-replace-exec.ts',
    phrase: '编辑器的标签登记还没就绪',
    count: 1,
    why: 'Monaco 注册表换成人话',
  },
  {
    file: 'packages/app/src/ui/search-scope.ts',
    phrase: '有一处范围提供方没能给出候选',
    count: 1,
    why: '不再点名提供方 id（原始错误串照旧逐字带出）',
  },
  {
    file: 'packages/app/src/ui/search-scope.ts',
    phrase: '的候选编号重复或为空，已忽略',
    count: 1,
    why: '能指名的只有候选自己的中文标签',
  },
  {
    file: 'packages/plugins/state-replay/src/evaluate.ts',
    phrase: '改名记号无法求值',
    count: 1,
    why: 'rename 类别码换成人话（名字也不与编辑器 F2「重命名」撞同一个"词"字）',
  },
  {
    file: 'packages/plugins/state-replay/src/state-view.ts',
    phrase: '改名记号无法求值',
    count: 2,
    why: '角色参数 / 索引段两条路各一句',
  },
  {
    file: 'packages/plugins/ui-state-replay/src/preview.ts',
    phrase: "rename: '改名记号'",
    count: 1,
    why: '未知类别提示与求值侧同口径',
  },
  {
    file: 'packages/plugins/ui-condition-matrix/src/index.ts',
    phrase: '这张归属表由适配器提供',
    count: 1,
    why: 'functionFamilyIndex 换成人话',
  },
  {
    file: 'packages/plugins/ui-condition-matrix/src/index.ts',
    phrase: '我的口上项目：可按角色号',
    count: 1,
    why: '与同一格的可见标题同名（工作区 artifact 不再露头）',
  },
  {
    file: 'packages/plugins/ui-condition-matrix/src/index.ts',
    phrase: '我的口上项目的目录名',
    count: 1,
    why: '同上（同名归属那一条 title）',
  },
  {
    file: 'packages/plugins/ui-plugin-status/src/maintenance.ts',
    phrase: '未收尾残留',
    count: 1,
    why: 'op 文档状态词 open 换成人话',
  },
  {
    file: 'packages/plugins/ui-state-replay/src/scene-actions.ts',
    phrase: '数值槽填 0＝假设、文字槽留空＝未提供',
    count: 1,
    why: '两种槽位的默认各自说清（别合并成"全 0"）',
  },
  {
    file: 'packages/plugins/ui-sugar-editor/src/new-file-wizard.ts',
    phrase: '新文件名由登记函数的名字模板代入角色号推导',
    count: 1,
    why: '契约属性路径换成人话，且说的是登记模板而不是分野表',
  },
];

describe('② 修好的原话还在（文件 + 逐字片段 + 处数）', () => {
  it.each(PINNED_COPY)('$file 含「$phrase」恰好 $count 处', ({ file, phrase, count }) => {
    const n = codeLines(file).filter(({ text }) => text.includes(phrase)).length;
    expect(n).toBe(count);
  });
});

/* ─────────────────── ③ 合法露面台账（机器标识确有该露的地方） ─────────────────── */

/**
 * 机器标识在作者面前的**合法**露面处，逐条钉到行 + 处数（台账本身也是账：
 * 豁免行没了 ⇒ 红，提示把它删掉；多出一行同形 ⇒ 也是红，提示这处该不该豁免）。
 */
const ON_SCREEN_MACHINE_ID_EXEMPTIONS: readonly {
  readonly file: (typeof COPY_FILES)[number];
  readonly re: RegExp;
  readonly count: number;
  readonly why: string;
}[] = [
  {
    file: 'packages/plugins/ui-plugin-status/src/index.ts',
    re: /className: 'plugin-id', title: r\.id/,
    count: 1,
    why: '插件状态面板的主体就是插件本身：id 是作者报障时的唯一定位符，藏掉反而无从对账',
  },
  {
    file: 'packages/app/src/ui/ShellLayout.tsx',
    re: /title=\{`索引失败：\$\{stats\.indexError\}`\}/,
    count: 1,
    why: '原始异常串（路径 + 英文片段）只进悬停 title：首句人话、原文一条不丢',
  },
];

describe('③ 合法露面台账（钉到行 + 处数，多一处少一处都红）', () => {
  it.each(ON_SCREEN_MACHINE_ID_EXEMPTIONS)('$file 的豁免处数恰好 $count', ({ file, re, count, why }) => {
    const n = codeLines(file).filter(({ text }) => re.test(text)).length;
    expect(n, `${file} 的豁免处数（${why}）`).toBe(count);
  });
});

/* ─────────────────── ④ 兜底行为（源码形态之外的活口） ─────────────────── */

describe('④ 未登记 kind 的兜底是中文，不是类别码', () => {
  it('登记过的类别照旧有中文名', () => {
    expect(opKindLabel('scaffold')).toBe('新建制品（脚手架）');
    expect(opKindLabel('search-replace')).toBe('全部替换（跨文件）');
  });

  it('未登记类别 → 兜底中文，类别码不上屏', () => {
    expect(opKindLabel('some-future-kind')).toBe('其它操作');
    expect(opKindLabel('some-future-kind')).not.toContain('some-future-kind');
  });

  it('undo:<kind> 递归一层，未登记的同样是兜底中文', () => {
    expect(opKindLabel('undo:deploy')).toBe('撤销 · 部署包到游戏目录');
    expect(opKindLabel('undo:some-future-kind')).toBe('撤销 · 其它操作');
  });
});
