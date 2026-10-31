/**
 * 裸 `font-size: Npx` 刻度闸（视觉批十一 · 收尾路 R2 · 债四）。
 *
 * 为什么要有这一道：`--fs-*` 那 6 档整数（tokens.css）不只是为了统一观感——
 * `editor-display-prefs.ts` 的界面字号缩放是**现读 `--fs-*` 的基线值再乘倍率**写到根元素行内的
 * （`UI_FONT_SCALE_TOKENS`），所以一条裸 px 就等于"这一格不参与作者的字号档"。
 * 改前静态量测：非 token 的 CSS 文件里还剩 12 处裸 `font-size: Npx`（同批其它裸值都降了，这项一动没动）。
 *
 * 本批做的：`.cmfill-code` 那一处**本来就是 11px = `--fs-0` 的档位值**（逐字等价、零视觉变化），
 * 收进刻度 ⇒ 12 降到 11。
 * 本批**不做**的：其余 11 处是条件矩阵（`cm-*`）一族的**亚 11px 微字面**（10px × 10、9px × 1）。
 * 刻度表当前最低档就是 11px（表体基线 `.cm-table` 吃 `--fs-0`），把它们折上来会
 * ① 改实测过的几何（14/15px 药丸、22px 方格里的 ✓、行视口化的实测行高），
 * ② 抹掉"微字面比表体基线小"这一层唯一的字号层次，
 * 而这两条都不是值重命名，是**改渲染**——本路没有真壳量测手段，不该由静态批自判。
 * 每一处都留了行尾注释指名理由，本闸把"剩余 11 处且各处都带说明"钉成回归线：
 * 新加裸字号 ⇒ 红；要收这一族 ⇒ 先在 tokens.css 开一档并在 `UI_FONT_SCALE_TOKENS` 登记同名，
 * 然后从这里划掉一行。
 *
 * 组长判（R2 把"要不要为这一族开一档亚 11px 的 `--fs-*`"上抛给我）：**不开**。
 * 这批花了一整波把"每面板自造尺度"收进 6 档，为条件矩阵一格微字再开一档，等于把刚关上的
 * 门重新推开——而且 `--fs-*` 一旦多一档，界面字号缩放那套"现读基线乘倍率"的口径就要跟着重标。
 * 这一族真要收，走的是**设计**那条路（药丸与方格重测尺寸），不是往刻度表里塞一档。
 * 判据保持现状：账本只许缩不许涨。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectLedger } from './helpers/debt-ledger';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (e.endsWith('.css')) acc.push(p);
  }
  return acc;
}

/** token 定义点与主题覆写档不在此闸射程：它们**就是**数值真源（裸 px 是它们的工作） */
const TOKEN_FILES = new Set(['tokens.css', 'light.css', 'mint-dark.css']);
const relOf = (p: string): string => path.relative(SRC, p).split(path.sep).join('/');

const sites: { file: string; line: number; decl: string; bare: string }[] = [];
const unmarked: string[] = [];
for (const p of walk(SRC)) {
  const base = path.basename(p);
  if (TOKEN_FILES.has(base)) continue;
  const lines = readFileSync(p, 'utf8').split('\n');
  lines.forEach((text, idx) => {
    const m = /^\s*font-size:\s*(\d+(?:\.\d+)?)px\s*;(.*)$/.exec(text);
    if (!m) return;
    sites.push({
      file: base,
      line: idx + 1,
      decl: text.trim(),
      // 行号会随别人往文件上游加行而漂，所以账本记的是「文件 + 声明本身」这条不变量
      bare: `${base} font-size: ${m[1]}px;`,
    });
    const value = Number(m[1]);
    // 11px 恰是 --fs-0 的档位值 ⇒ 允许直接换成 token；留在裸值上就必须带说明注释
    if (value > 11) return; // 高于最低档的：本闸只登记，交刻度闸那条"必须吃 --fs-*"处理
    if (!/亚\s*11px\s*档/.test(m[2] ?? '')) unmarked.push(`${base}:${idx + 1} → ${text.trim()}`);
  });
}

/**
 * 账本：现存的亚档位（转正一枚就划一行；新增必须来说清为什么）。
 * 记「文件 + 声明」而不是行号——styles-project.css 是并行批次共同追加的热文件，
 * 行号闸会在别人往上游加行时假红。
 */
const SUB_RUNG_LEDGER: readonly string[] = [
  ...Array.from({ length: 10 }, () => 'styles-project.css font-size: 10px;'),
  'styles-project.css font-size: 9px;',
];

describe('裸 font-size: Npx 现状（非 token 文件）', () => {
  it('扫到了样式文件（防"零文件假账"）', () => {
    expect(walk(SRC).length).toBeGreaterThanOrEqual(20);
    expect(sites.length).toBeGreaterThan(0);
  });

  // @debt-ledger LOCAL:sub-rung-11px
  it(`亚 11px 欠账逐枚在册：现 ${sites.length} 处 == 账上 ${SUB_RUNG_LEDGER.length} 处，且每处都带理由注释`, () => {
    expectLedger(
      sites.map((s) => s.bare),
      SUB_RUNG_LEDGER,
      {
        ledgerName: 'SUB_RUNG_LEDGER',
        marker: 'LOCAL:sub-rung-11px',
        how: '转正一枚就划掉一行（先在 tokens.css 开档并在 UI_FONT_SCALE_TOKENS 登记同名）；新增必须带行尾"亚 11px 档"理由注释，并在提交信息里说清为什么新增',
      },
    );
    expect(unmarked, `这些裸字号没有说明注释：${unmarked.join(' / ')}`).toEqual([]);
    console.log(
      `[fs-scale] 裸 font-size: Npx（非 token 文件）本批 12 → ${sites.length}；` +
        `剩余读数：${sites.map((s) => s.line).join(',')}（全部 ≤11px 且带行尾理由）`,
    );
  });

  it('轻档（styles.css）零裸字号；本批收掉的那处（.cmfill-code）已是 --fs-0', () => {
    const light = readFileSync(path.join(SRC, 'styles.css'), 'utf8');
    expect(light.match(/font-size:\s*\d+(\.\d+)?px/g) ?? [], 'styles.css 里冒出裸字号').toHaveLength(0);
    const heavy = readFileSync(path.join(SRC, 'styles-project.css'), 'utf8');
    const i = heavy.indexOf('.cmfill-code {');
    expect(i).toBeGreaterThan(-1);
    const block = heavy.slice(i, heavy.indexOf('}', i));
    expect(block).toMatch(/font-size:\s*var\(--fs-0\);/);
    expect(block).not.toMatch(/font-size:\s*11px/);
  });

  it('刻度表就是那 6 档整数 + display：亚档要新增先来这张表上登记（本闸不放宽）', () => {
    const tokens = readFileSync(path.join(SRC, 'tokens.css'), 'utf8');
    const rungs = [...tokens.matchAll(/(--fs-[a-z0-9-]+):\s*(\d+(?:\.\d+)?)px/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(rungs).toEqual([
      '--fs-0=11',
      '--fs-1=12',
      '--fs-2=13',
      '--fs-3=14',
      '--fs-4=16',
      '--fs-5=18',
      '--fs-display=26',
    ]);
  });
});
