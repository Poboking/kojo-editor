/**
 * 新建口上项目时可选的**许可条款文本**（2026-10-12 用户反馈 4）。
 *
 * ## 为什么住在 adapter 而不是内核
 *
 * `LTOL` 是 era 社区的圈内约定，不是通用软件许可 —— 按"游戏知识只住在 adapter"的
 * 定调，它连同这份选择表都不能往内核或 `plugin-api` 里放。
 *
 * ## 一条不可让渡的纪律：**条款文本必须是有据可查的原文**
 *
 * 许可证不是文案。作者据此发布，工具替他**编造**或**意译**一份条款，就是把他推进
 * 一个他以为已经规避了的合规风险里。所以本模块只有三种合法来源：
 *
 * 1. OSI / SPDX 标准条款，逐字内置（MIT / BSD-2-Clause / ISC）；
 * 2. 用户提供的权威原文，逐字内置（LTOL —— 由项目负责人 2026-10-12 提供日文原文
 *    与中文译文，本文一字未改，含其小节编号的原有形态）；
 * 3. 明确标注为"要点速览 + 官方链接"的**指引**，不冒充法律文本（CC BY-NC 4.0：
 *    其完整条款长达数千词，此处按用户决定只给要点与权威链接，并在文件里写清
 *    "具有法律效力的条款以官方链接为准"）。
 *
 * 第四种是 `template`：不替作者选定任何协议，只落署名与待填框架（P-C 批的既有行为）。
 */

/** 可选许可（`none` = 不生成 LICENSE 文件） */
export type LicenseKind = 'none' | 'template' | 'mit' | 'bsd-2-clause' | 'isc' | 'cc-by-nc-4.0' | 'ltol';

/**
 * 向导下拉框的选项（顺序即呈现顺序）。
 *
 * `hint` 是给**不懂法律术语的口上作者**看的一句话，不是条款摘要：
 * 说清"选了它，别人能干什么、不能干什么"，而不是复述协议名。
 */
export const LICENSE_CHOICES: readonly { kind: LicenseKind; label: string; hint: string }[] = [
  { kind: 'none', label: '不生成 LICENSE 文件', hint: '默认保留所有权利；别人能不能用你的口上，全凭私下沟通' },
  { kind: 'template', label: '占位模板（创建后自填条款）', hint: '只落署名与年份，条款留给你自己写' },
  { kind: 'ltol', label: 'LTOL · 时限开放许可（era 社区）', hint: '标注之日起一年有效，续版自动延长；到期或作者失联半年后转为免费许可' },
  { kind: 'cc-by-nc-4.0', label: 'CC BY-NC 4.0 · 署名-非商业性使用', hint: '别人可转载和改编，但必须署名、且不得用于商业目的' },
  { kind: 'mit', label: 'MIT', hint: '几乎不设限：随便用、随便改，保留你的版权声明即可' },
  { kind: 'bsd-2-clause', label: 'BSD-2-Clause', hint: '与 MIT 接近：再分发时要保留版权声明和这份免责条款' },
  { kind: 'isc', label: 'ISC', hint: '与 MIT 实质等价的更短写法' },
];

/** 生成 LICENSE 所需的填充值 */
export interface LicenseFields {
  /** 版权人（一般 = 作者名） */
  author: string;
  /** 年份 */
  year: number;
  /** 作品名（指引性文本里用得上） */
  workName: string;
}

/** 该选项是否需要生成文件（`none` 不需要） */
export function licenseProducesFile(kind: LicenseKind): boolean {
  return kind !== 'none';
}

/** LICENSE 文件的规范名（大写，与社区习惯一致） */
export const LICENSE_FILE_NAME = 'LICENSE';

function header(f: LicenseFields, title: string): string[] {
  return [`${title}`, ``, `作品：${f.workName}`, `版权人：${f.author}`, `年份：${f.year}`, ``, `---`, ``];
}

/** 占位模板：不替作者下任何许可判断（P-C 批既有行为，原样保留） */
function templateText(f: LicenseFields): string {
  return [
    `Copyright (c) ${f.year} ${f.author}`,
    '',
    '（占位模板：请在此填写所选开源协议的完整条款，',
    '例如 MIT、CC BY-NC-SA 等；删除本行说明。）',
  ].join('\n') + '\n';
}

/**
 * LTOL 全文。
 *
 * **一字未改**：日文原文在前（LTOL 的源头语言），中文译文随后，均照项目负责人
 * 2026-10-12 提供的版本录入，含其原有小节编号形态（日文版第 3 节下的两个子项
 * 编号为 1./2.，中文版为 3-a/3-b —— 这是原文本身的差异，不做"顺手统一"，
 * 免得改动被当成对条款的重新解释）。
 */
const LTOL_BODY = `■ライセンス本文

1. このライセンスについて

このライセンスは口上に含まれる台詞等を保護するために明記されています。
以下の項目の場合においては禁止とします。

1-a. 他ライセンスに組み込む場合。
このライセンスで書かれた台詞などを他のライセンスの口上へ移植し
移植先のライセンスでそのライセンスを制定すること。
ただし、派生物に対してライセンスが効力を持つものに対してのみとする。
ライセンス汚染の防止。

1-b. ライセンスの変更を行う場合。
このライセンスが表記されている口上を他のライセンスへ置き換え使用する場合。
このライセンスで制定された口上はライセンスのVerUp以外のライセンスの変更が出来ません。
このライセンスを表記した時点で効力を持ち、他のライセンスへ切り替えは出来ません。

1-c. 他ライセンスを侵す行為
このライセンスで書かれた口上は他のライセンスの権利を侵す形での
コードを追加することが出来ません。
移植元ライセンスが移植等を許可している場合のみとなります。

2. 改変等について

作者は改変等について許可・拒否が出来ます。
ただし、特に表記されていない場合は許可とします。

3. ライセンス期間

このライセンスの有効期限と失効についての条件を表記します。

1. 有効期限
このライセンスはライセンスが明記されてから一年を有効期限とします。
ただし、口上の更新等でVerUPした場合においては、それからさらに一年延長されます。

2. ライセンスの失効
有効期限が切れる、もしくはこのライセンスを採用した作者と連絡が取れなくなって
半年でこのライセンスは失効し、フリーライセンスとなります。
ただし、失効後に作者が戻ってきた場合は、最後に表記された口上のVerが作者の著作物とします。
その後の派生物に対してはライセンスの主張が出来ません。

■ 许可证正文（中文译文）

1. 关于此许可证

此许可证明确用于保护口上中包含的台词等。
以下情况禁止。

1-a. 组入其他许可证的情况。
将此许可证写成的台词等移植到其他许可证的口上中，
在移植目的地的许可证中制定该许可证。
但仅限于对派生物具有许可证效力的。
防止许可证污染。

1-b. 修改许可证的情况。
将标注此许可证的口上替换使用到其他许可证。
此许可证制定的口上不能修改许可证，除非是许可证版本升级。
此许可证一旦标注即生效，不能切换到其他许可证。

1-c. 侵犯其他许可证的行为
此许可证写成的口上不能以侵犯其他许可证权利的形式
添加代码。
仅限于原许可证允许移植等的情况。

2. 关于修改等

作者可以允许或拒绝修改等。
但若未特别标注，则视为允许。

3. 许可证期间

标注此许可证的有效期和失效条件。

3-a. 有效期
此许可证自标注之日起一年为有效期。
但当口上更新等进行版本升级时，再延长一年。

3-b. 许可证失效
有效期截止，或采用此许可证的作者失联
半年后此许可证失效，成为免费许可证。
但失效后作者回归的情况下，以最后标注的口上版本作为作者的著作物。
之后的派生物不能主张许可证。`;

function mitText(f: LicenseFields): string {
  return `MIT License

Copyright (c) ${f.year} ${f.author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function bsd2Text(f: LicenseFields): string {
  return `BSD 2-Clause License

Copyright (c) ${f.year} ${f.author}
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;
}

function iscText(f: LicenseFields): string {
  return `ISC License

Copyright (c) ${f.year} ${f.author}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
`;
}

/**
 * CC BY-NC 4.0 —— **要点速览 + 权威链接**，不是条款全文。
 *
 * 按项目负责人 2026-10-12 的决定：CC 全文长达数千词，内置一份可能转录出错的长文本
 * 反而更危险，故只给要点与官方链接，并在文件里明说"具有法律效力的条款以官方链接为准"。
 */
function ccByNcText(f: LicenseFields): string {
  return [
    ...header(f, '知识共享 署名-非商业性使用 4.0 国际许可协议（CC BY-NC 4.0）'),
    '本作品采用「署名-非商业性使用 4.0 国际」许可协议（CC BY-NC 4.0）授权。',
    '',
    'Copyright (c) ' + f.year + ' ' + f.author,
    'This work is licensed under CC BY-NC 4.0:',
    '  https://creativecommons.org/licenses/by-nc/4.0/',
    '',
    '== 要点速览（不是法律文本，仅为方便阅读的摘要）==',
    '',
    '- 署名：转载、分发或改编本作品时，必须注明原作者与出处，并说明是否做过修改。',
    '- 非商业性使用：不得将本作品用于主要为商业目的或私人获利的用途。',
    '- 改编作品同样受本协议约束：基于本作品再混合、改写后的产物，仍须按 CC BY-NC 4.0 发布。',
    '- 上述不得减少或限制本作品的合法使用者（如各法域的合理使用）所享有的权利。',
    '',
    '== 请注意 ==',
    '',
    '本文件只是摘要，**具有法律效力的完整条款以上述官方链接的正式文本为准**。',
    '需要逐条条款时请阅读：https://creativecommons.org/licenses/by-nc/4.0/legalcode',
    '',
  ].join('\n');
}

/**
 * 生成 LICENSE 文件内容。
 *
 * @throws Error `kind === 'none'` 时不该被调用（调用方应先判 `licenseProducesFile`）；
 *         这里抛错而不是返回空串，是为了让"配错表"在开发期就炸出来。
 */
export function buildLicenseText(kind: LicenseKind, fields: LicenseFields): string {
  const f = {
    author: fields.author.trim(),
    year: fields.year,
    workName: fields.workName.trim(),
  };
  switch (kind) {
    case 'template':
      return templateText(f);
    case 'mit':
      return mitText(f);
    case 'bsd-2-clause':
      return bsd2Text(f);
    case 'isc':
      return iscText(f);
    case 'cc-by-nc-4.0':
      return ccByNcText(f);
    case 'ltol':
      return [...header(f, 'LTOL ─ 时限开放许可（Limited Term Open License）'), LTOL_BODY, ''].join('\n');
    case 'none':
      throw new Error('kind=none 不应生成 LICENSE 文件（调用方应先过 licenseProducesFile）');
  }
}
