import { useState, type ReactElement } from 'react';
import {
  getGlobFilterText,
  loadCasePreservePref,
  parseFileFilter,
  saveCasePreservePref,
  setGlobFilterText,
} from './search-query';

/**
 * 检索面板的「glob 过滤 + 保留大小写」条（P2-15 体验差距批）。
 *
 * 为什么收进**一个新组件**而不是摊进 `SearchPanel.tsx`：SearchPanel 是共享分区
 * （P2-11 同批改输入框防抖 / 即搜 / 排序下拉），本组件自带状态与 props，
 * 面板只追加一行渲染——双方各占自己那一小段，互不重排。
 *
 * 两件控件：
 * ① **glob 过滤框**——按路径形态过滤（`*.kojo` / `**`/`x/*.erb` / `src/**`/`*.erb` / `?`），
 *    分隔符与「类型」框同款；与扩展名是**且**的关系（两者都满足才扫，理由见
 *    `search-query.parseFileFilter`）。文本住模块级（`get/setGlobFilterText`，
 *    与 `extensionText` 住 store 同理由：面板切走卸载后条件不丢），发请求那一行
 *    接线归 P2-11（`request.options.globs`，契约位在 `bridge/search.ts`）。
 *    （注释里 `**` 与 `/` 刻意分写：块注释中 `*` 紧跟 `/` 会提前终止注释）
 * ② **保留大小写开关**——替换时把命中处的大小写形态借给替换词（`FOO`+`bar`⇒`BAR`、
 *    `Foo`⇒`Bar`、`fOo`⇒`bAr`；回落判据在 `search-replace.preserveReplacementCase`）。
 *    偏好住 localStorage、缺省**开**（常见编辑器一致；理由见 `search-query.ts`
 *    偏好注释），执行器每次替换动作现读——本组件只写值 + 持有渲染用的镜像。
 */
export interface SearchFilterBarProps {
  /** 回车 = 立即检索（与「类型」框同键位；缺省 = 只解析不检索） */
  onRequestSearch?: () => void;
}

export function SearchFilterBar({ onRequestSearch }: SearchFilterBarProps): ReactElement {
  // glob 文本的真源是模块级（跨挂载存活）；本地 tick 只为在 onChange 后触发一次重渲染
  const [, setTick] = useState(0);
  const globText = getGlobFilterText();
  const parts = parseFileFilter(globText);

  // 偏好镜像：真源在 localStorage（`loadCasePreservePref` 每次替换动作现读）
  const [casePreserve, setCasePreserve] = useState<boolean>(() => loadCasePreservePref());

  /** glob 框里混进了非 glob 形态的词（没有 `*` `?` `/`）⇒ 说出来，不静默忽略 */
  const notGlobNote =
    parts.extensions.length > 0
      ? `「${parts.extensions.join('、')}」不是 glob 形态（不含 * ? /），glob 过滤用不上——扩展名请写在「类型」框。`
      : null;

  return (
    <>
      <label className="search-ext-row ksp-opt-row sfb-row">
        <span className="ksp-opt-label sfb-label">glob</span>
        <input
          className="search-ext ksp-opt-input sfb-input"
          title="按路径形态过滤：*.kojo、**/x/*.erb、src/**/*.erb、? 单字符；与「类型」是且的关系（两者都满足才扫）；分隔符（逗号/分号/空白）与类型框相同"
          placeholder="*.kojo, src/**/*.erb"
          aria-label="glob 路径过滤"
          autoComplete="off"
          spellCheck={false}
          value={globText}
          onChange={(e) => {
            setGlobFilterText(e.target.value);
            setTick((t) => t + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onRequestSearch?.();
            }
          }}
        />
      </label>

      {parts.globs.length > 0 || notGlobNote !== null ? (
        <p className="dim sfb-note">
          {parts.globs.length > 0 ? `glob 生效：${parts.globs.join(' , ')}（与「类型」且的关系）` : null}
          {notGlobNote !== null ? (
            <>
              {parts.globs.length > 0 ? ' ' : null}
              {notGlobNote}
            </>
          ) : null}
        </p>
      ) : null}

      <div className="ksp-opt-row sfb-row sfb-case-row">
        <button
          type="button"
          className={`search-toggle ksp-toggle sfb-case${casePreserve ? ' on' : ''}`}
          title="替换时把命中处的大小写形态借给替换词（FOO→BAR、Foo→Bar、fOo→bAr；形态映射不了时原样使用替换词）。默认开，与常见编辑器一致。"
          aria-label="替换时保留大小写"
          aria-pressed={casePreserve}
          onClick={() => {
            const next = !casePreserve;
            saveCasePreservePref(next); // 真源：localStorage（执行器每次替换动作现读）
            setCasePreserve(next);
          }}
        >
          保留大小写
        </button>
        <span className="dim sfb-case-note">命中 FOO、替换词 bar ⇒ BAR（可关）</span>
      </div>
    </>
  );
}
