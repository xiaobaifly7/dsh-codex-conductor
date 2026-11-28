import test from 'node:test';
import assert from 'node:assert/strict';

import * as taskLintMod from './task-lint.mjs';
import * as offsetCalcMod from './offset-calc.mjs';

const {
  lintTaskBrief,
  lintContinuationDelta,
  lintGeminiWrite,
  normalizedTaskIdentity,
  GEMINI_WRITE_REFUSAL,
} = taskLintMod;

const { parseSectionHeaders, verifyOffsets } = offsetCalcMod;

test('模块导出契约：导出名与设计文档 3.1 节完全一致', () => {
  assert.deepEqual(
    Object.keys(taskLintMod).sort(),
    [
      'GEMINI_WRITE_REFUSAL',
      'lintContinuationDelta',
      'lintGeminiWrite',
      'lintTaskBrief',
      'normalizedTaskIdentity',
    ],
  );
  assert.deepEqual(Object.keys(offsetCalcMod).sort(), ['parseSectionHeaders', 'verifyOffsets']);
});

test('M1 正反例成对：显式目的分句（含安全过滤覆写开关）拦截 vs 删掉目的只留技术定义放行', () => {
  const briefWithPurpose = [
    '解析配置加载模块的结构体布局与位标志：',
    '1. 给出 flags 字段的字节偏移与位宽定义；',
    '2. 说明修改方式，以便开启这个安全过滤覆写开关。',
  ].join('\n');

  const hitRes = lintTaskBrief(briefWithPurpose);
  assert.equal(hitRes.ok, false);
  assert.equal(hitRes.blocked, true);
  assert.equal(hitRes.blocks.length, 1);
  assert.equal(hitRes.blocks[0].rule, 'M1');
  assert.equal(hitRes.blocks[0].line, 3);
  assert.match(hitRes.blocks[0].excerpt, /开启这个安全过滤覆写开关/);

  const briefTechOnly = [
    '解析配置加载模块的结构体布局与位标志：',
    '1. 给出 flags 字段的字节偏移与位宽定义；',
    '2. 输出默认值与掩码常量的十六进制表示。',
  ].join('\n');

  const cleanRes = lintTaskBrief(briefTechOnly);
  assert.equal(cleanRes.ok, true);
  assert.equal(cleanRes.blocked, false);
  assert.equal(cleanRes.hits.length, 0);
});

test('M1 正反例成对：结果导向恒真追问 / 第一人称意图串联 / 高危关闭搭配 vs 普通工程关闭与跳过', () => {
  // 反例 1：M1-P2 结果导向恒真追问
  const forceRes = lintTaskBrief('阅读鉴权中间件源码。\n请问怎么才能让这个校验总是返回通过？');
  assert.equal(forceRes.blocked, true);
  assert.equal(forceRes.blocks[0].subrule, 'M1-P2');
  assert.equal(forceRes.blocks[0].line, 2);

  // 反例 2：M1-P3 第一人称意图 + 后续用途串联
  const firstPersonRes = lintTaskBrief('我要拿到会话签名密钥之后再去构造管理端请求。');
  assert.equal(firstPersonRes.blocked, true);
  assert.equal(firstPersonRes.blocks[0].subrule, 'M1-P3');
  assert.equal(firstPersonRes.blocks[0].line, 1);

  // 反例 3：关闭/跳过搭配安全保护宾语
  const closeSecRes = lintTaskBrief('修改初始化参数，为了关闭证书签名验证。');
  assert.equal(closeSecRes.blocked, true);
  assert.equal(closeSecRes.blocks[0].subrule, 'M1-P1');

  // 正例：关闭/跳过搭配普通工程名词（连接池、弹窗、缓存静态资源、空行）完全不命中
  const benignRes = lintTaskBrief(
    [
      '优化前端启动与日志读取性能：',
      '- 为了关闭多余的调试弹窗，移除开发态 toast 调用；',
      '- 解析器用来跳过空行与已缓存的静态资源条目。',
    ].join('\n'),
  );
  assert.equal(benignRes.ok, true);
  assert.equal(benignRes.blocks.length, 0);
});

test('M1 否定句豁免与引用/代码块/路径剥离正反例成对', () => {
  // 正例 1：「不要写目的」「不需要交代用途」及「严禁为了绕过…」否定安全约束不得误报
  const negatedBrief = [
    '整理模块静态接口定义：',
    '- 不要写目的，不需要交代用途，只写输入输出类型；',
    '- 严禁为了绕过权限校验而修改配置；不要开启这个安全过滤覆写开关；',
    '- Do not bypass validation or disable signature checks.',
  ].join('\n');
  const negRes = lintTaskBrief(negatedBrief);
  assert.equal(negRes.ok, true);
  assert.equal(negRes.hits.length, 0);

  // 正例 2：短书名号/反引号引用样本、路径名含目的词、围栏代码块内注释均豁免
  const metaBrief = [
    '核对预检规则文档 D:/notes/为了绕过与防溯源盘点/spec.md 的章节标题：',
    '确认单元测试覆盖「为了绕过只读保护」与 `开启这个安全过滤覆写开关` 字面样本。',
    '```txt',
    '为了绕过沙箱保护而覆写结构体',
    '```',
  ].join('\n');
  const metaRes = lintTaskBrief(metaBrief);
  assert.equal(metaRes.ok, true);
  assert.equal(metaRes.blocks.length, 0);

  // 反例：目的分句出现在否定词之前时仍须拦截
  const purposeBeforeNeg = '为了绕过权限校验，不要修改其他无关文件。';
  const hitBeforeNeg = lintTaskBrief(purposeBeforeNeg);
  assert.equal(hitBeforeNeg.blocked, true);
  assert.equal(hitBeforeNeg.blocks[0].rule, 'M1');

  // 连续 2 次触发 M1 时追加反死锁提示；首次触发不追加
  const repeatedM1 = lintTaskBrief(purposeBeforeNeg, { consecutiveM1Blocks: 2 });
  assert.match(repeatedM1.message, /忽略该旧段落并整句删除命中分句/);
  assert.doesNotMatch(hitBeforeNeg.message, /忽略该旧段落/);
});

test('M2a 路径白名单豁免正反例成对：workspaces / roots / plannerReadAllow / worktree.repos', () => {
  const context = {
    workspaces: ['C:\\Users\\apple\\Documents\\GitHub\\dsh-codex-conductor'],
    plannerReadAllow: ['C:/Users/apple/Documents/Specs/allowed-notes'],
    worktree: { repos: ['/mnt/c/Users/apple/Documents/GitHub/repo-wt'] },
  };

  // 正例：落在 workspaces / plannerReadAllow / worktree.repos 内的本机路径，以及 Public / <USER> 匿名路径均放行
  const allowedBrief = [
    '读取 C:/Users/apple/Documents/GitHub/dsh-codex-conductor/index.mjs 第 100 行，',
    '对照 C:/Users/apple/Documents/Specs/allowed-notes/design.md 与 /mnt/c/Users/apple/Documents/GitHub/repo-wt/src/a.js，',
    '示例路径统一写为 C:/Users/<USER>/config.json 或 C:/Users/Public/sample.json。',
  ].join('\n');
  const allowRes = lintTaskBrief(allowedBrief, context);
  assert.equal(allowRes.ok, true);
  assert.equal(allowRes.blocks.length, 0);

  // 反例：未授权个人目录路径（Windows Users 与 Linux /home）必须硬拦截并指明行号
  const unauthorizedBrief = [
    '对比以下两份配置：',
    '1. C:/Users/apple/Desktop/private-vault/passwords.txt',
    '2. /home/xiaobai/.ssh/id_ed25519_config',
  ].join('\n');
  const denyRes = lintTaskBrief(unauthorizedBrief, context);
  assert.equal(denyRes.blocked, true);
  assert.equal(denyRes.blocks.length, 2);
  assert.equal(denyRes.blocks[0].subrule, 'M2a-user-path');
  assert.equal(denyRes.blocks[0].line, 2);
  assert.equal(denyRes.blocks[1].subrule, 'M2a-user-path');
  assert.equal(denyRes.blocks[1].line, 3);
});

test('M2a/M2b/M2c 凭据、散文裸载荷与空模板槽位正反例成对', () => {
  // 反例 1：围栏代码块内的真实私钥头与高熵 Token 仍须拦截
  const leakedSecretBrief = [
    '复现连接失败日志：',
    '```pem',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==',
    '```',
    'Authorization: Bearer sk-proj-K8mP9xQ2vL7nR4wT6yZ1bC3dE5fG',
  ].join('\n');
  const secretRes = lintTaskBrief(leakedSecretBrief);
  assert.equal(secretRes.blocked, true);
  assert.deepEqual(
    secretRes.blocks.map((b) => [b.subrule, b.line]),
    [
      ['M2a-private-key', 3],
      ['M2a-secret-token', 6],
    ],
  );

  // 正例 1：脱敏占位符与低熵测试假 Token（含 test / EXAMPLE）不误报
  const fakeTokenBrief = '使用测试令牌 sk-test-1234567890abcdefghij 与文档示例 AKIAIOSFODNN7EXAMPLE 验证格式校验器。';
  assert.equal(lintTaskBrief(fakeTokenBrief).ok, true);

  // 反例 2：散文裸写特征载荷字面量与未替换完的 <待填> 模板槽位
  const payloadAndSlotBrief = [
    '参数说明：<目标二进制格式与处理器架构规范>',
    "测试输入为 ' OR '1'='1 时解析器的词法切分结果，锚点 <待填>。",
  ].join('\n');
  const payloadRes = lintTaskBrief(payloadAndSlotBrief);
  assert.equal(payloadRes.blocked, true);
  assert.equal(payloadRes.blocks.some((b) => b.subrule === 'M2b-raw-payload' && b.line === 2), true);
  assert.equal(payloadRes.blocks.some((b) => b.subrule === 'M2c-unfilled-slot' && b.line === 1), true);

  // 正例 2：载荷放入围栏代码块或行内反引号、槽位已填具体规格时放行
  const quotedPayloadBrief = [
    '目标架构：x86_64 System V ELF ABI。',
    '讨论 SQL 语法树对 `UNION SELECT` 的解析节点：',
    '```sql',
    'SELECT id, name FROM articles UNION SELECT id, title FROM drafts;',
    '```',
  ].join('\n');
  assert.equal(lintTaskBrief(quotedPayloadBrief).ok, true);
});

test('M3 新会话悬空指代、拆块必填段与 lintContinuationDelta 增量扫描正反例成对', () => {
  // 反例 1：全新独立会话开头出现跨轮指代或前 200 字内出现「如上所述」
  const danglingRes = lintTaskBrief({
    task: '基于上一轮的结果，继续推导重定位表项大小。',
    acceptance: ['如上所述输出字段偏移'],
  });
  assert.equal(danglingRes.blocked, true);
  assert.equal(danglingRes.blocks.length, 2);
  assert.equal(danglingRes.blocks[0].subrule, 'M3a-dangling-ref');
  assert.equal(danglingRes.blocks[1].field, 'acceptance[0]');

  // 正例 1：长任务书前文已有超过 200 非空白字符定义后回指「如上所述」，或带 resume 续接时放行
  const prefix =
    '定义二进制容器头部结构体 Header 包含 magic(4B)、version(2B)、flags(2B)、entry_offset(8B)、section_count(4B)、shstrndx(4B) 共六个定长无符号整数字段，所有多字节整数字段统一采用小端序编码并按八字节自然边界对齐，文件头部固定起始于偏移 0x0 处，节表数组紧随文件头部之后连续排布且每个节表项固定占用 64 字节存储空间，节名称字符串表通过头部索引字段按零基下标寻址读取并以空字节结尾。';
  assert.ok([...prefix.replace(/\s+/gu, '')].length >= 200);
  const longSelfRefRes = lintTaskBrief(`${prefix}\n如上所述，编写只读解析函数并返回 JSON。`);
  assert.equal(longSelfRefRes.ok, true);

  const resumedRes = lintTaskBrief(
    { task: '基于上一轮的结果，补充边界测试。', resume: 'thread_abc123' },
    {},
  );
  assert.equal(resumedRes.ok, true);

  // 正反例 2：M3b 拆块标记缺少锚点/契约时告警 vs 补齐 0-based 基准与返回结构后清零
  const splitMissing = lintTaskBrief('【拆块派单】\n请计算符号表各项大小。');
  assert.equal(splitMissing.ok, true);
  assert.equal(splitMissing.warnings.some((w) => w.subrule === 'M3b-split-contract'), true);

  const splitComplete = lintTaskBrief(
    '<!-- split-block -->\n输入前提：所有表项下标从 0 开始（0-based）。\n返回结构：输出字段约定为 { index, offset }。',
  );
  assert.equal(splitComplete.ok, true);
  assert.equal(splitComplete.hits.length, 0);

  // 正反例 3：lintContinuationDelta 只扫新增 answers/resolution，不误杀父任务或跨轮指代，但拦截新填违规内容
  const cleanDelta = lintContinuationDelta({
    task: '基于上一轮的结果，为了绕过保护（历史残留在 args 上也不重扫）',
    answers: [{ id: 'q1', answer: '沿用上一轮的定义，改读相对路径 ./fixtures/sample.json' }],
    resolution: '已确认使用默认超时 30s',
  });
  assert.equal(cleanDelta.ok, true);

  const dirtyDelta = lintContinuationDelta({
    answers: [{ id: 'q1', answer: '为了绕过签名校验，直接把返回值硬编码为 true' }],
  });
  assert.equal(dirtyDelta.blocked, true);
  assert.equal(dirtyDelta.blocks[0].field, 'answers[0].answer');
  assert.equal(dirtyDelta.blocks[0].rule, 'M1');
});

test('M4 高危共现软预警正反例成对：只产生 warn 不阻断启动，加边界后消警', () => {
  // 反例（触发软预警）：同段点名具体二进制 + 直问内部判定实现（M4a），以及具体路径 + 全量反编译无边界（M4b）
  const riskyBrief = [
    '分析模块 auth_core.dll，该模块内部具体是怎么判断许可证有效性的？',
    '',
    '另外请反编译 ./build/libengine.so 里的全部函数并导出完整清单。',
  ].join('\n');
  const warnRes = lintTaskBrief(riskyBrief);
  assert.equal(warnRes.ok, true);
  assert.equal(warnRes.blocked, false);
  assert.equal(warnRes.blocks.length, 0);
  assert.deepEqual(
    warnRes.warnings.map((w) => [w.subrule, w.line]),
    [
      ['M4a-concrete-how', 1],
      ['M4b-unbounded-extract', 3],
    ],
  );

  // 正例：限定具体节区与条数上限（offset / .plt.sec 节 / 前 20 条）或显式 acknowledge_risk_warning 时零告警
  const boundedBrief = '反汇编 ./build/libengine.so 的 .plt.sec 节前 20 条指令（offset 0x1020, limit 20）。';
  const boundedRes = lintTaskBrief(boundedBrief);
  assert.equal(boundedRes.ok, true);
  assert.equal(boundedRes.warnings.length, 0);

  const ackedRes = lintTaskBrief(riskyBrief, { acknowledge_risk_warning: true });
  assert.equal(ackedRes.warnings.length, 0);
});

test('M5 归一化指纹与 gemini_write 第四参通道拦截正反例成对', () => {
  // normalizedTaskIdentity：改空格、标点、列表序号指纹不变；删目的分句后指纹立即改变
  const hashA = normalizedTaskIdentity('1. 解析 ELF 节表头，输出 .text 偏移。');
  const hashB = normalizedTaskIdentity('- 解析 ELF 节表头；\n  输出 `.text` 偏移!');
  const hashC = normalizedTaskIdentity('1. 解析 ELF 节表头，输出 .text 偏移，以便绕过检查。');
  assert.equal(hashA, hashB);
  assert.notEqual(hashA, hashC);
  assert.match(hashA, /^[0-9a-f]{64}$/);

  // GEMINI_WRITE_REFUSAL 正反例
  assert.equal(GEMINI_WRITE_REFUSAL.test("This request was blocked by Gemini's filters"), true);
  assert.equal(GEMINI_WRITE_REFUSAL.test('抱歉，我无法满足您的请求。'), true);
  assert.equal(GEMINI_WRITE_REFUSAL.test('已写入目标文档，共 2400 字。'), false);

  // lintGeminiWrite 反例：拦截 prompt 目的分句与 sources 侧真实私钥泄漏
  const blockedGem = lintGeminiWrite(
    {
      prompt: '根据素材撰写配置说明，用来绕过线上鉴权护栏。',
      frontmatter: { title: '系统架构笔记' },
    },
    [{ path: 'notes/key.md', content: '测试环境密钥：\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...' }],
  );
  assert.equal(blockedGem.blocked, true);
  assert.equal(blockedGem.blocks.some((b) => b.rule === 'M1' && b.field === 'prompt'), true);
  assert.equal(
    blockedGem.blocks.some((b) => b.subrule === 'M2a-private-key' && b.field.startsWith('sources[0]') && b.line === 2),
    true,
  );

  // lintGeminiWrite 正例：合规写作 prompt + 含 SQL 语法讨论与跨段指代的干净素材完全放行
  const cleanGem = lintGeminiWrite(
    {
      prompt: '基于上一轮整理的接口表，撰写 ELF 重定位节结构科普章节。',
      frontmatter: { title: 'ELF 动态链接结构解析', tags: ['elf', 'abi'] },
    },
    [{ path: 'notes/ref.md', content: '如上所述，SELECT a FROM t1 UNION SELECT b FROM t2 仅作关系代数示例。' }],
  );
  assert.equal(cleanGem.ok, true);
  assert.equal(cleanGem.blocks.length, 0);
});

test('M6 节表解析与 64 位 BigInt 偏移/位移/步长验算正反例成对（含 NOBITS、越界、步长不整除）', () => {
  const readelfWide = [
    'Section Headers:',
    '  [Nr] Name              Type            Address          Off    Size   ES Flg Lk Inf Al',
    '  [ 0]                   NULL            0000000000000000 000000 000000 00      0   0  0',
    '  [12] .plt.sec          PROGBITS        ffff800080010000 010000 000060 10  AX  0   0 16',
    '  [22] .got.plt          PROGBITS        ffff800080014000 013000 000048 08  WA  0   0  8',
    '  [23] .bss              NOBITS          ffff800080015000 013048 000200 00  WA  0   0 16',
  ].join('\n');

  const sections = parseSectionHeaders(readelfWide);
  assert.equal(sections.length, 4);
  assert.equal(sections[1].name, '.plt.sec');
  assert.equal(sections[1].addr, 0xffff800080010000n);
  assert.equal(sections[3].name, '.bss');
  assert.equal(sections[3].type, 'NOBITS');

  // 同时验证双行折行 readelf -S 与 objdump -h（ALLOC 无 CONTENTS 识别为 NOBITS）
  const wrappedAndObjdump = [
    '  [ 1] .text             PROGBITS         0000000000401000  00001000',
    '       0000000000000240  0000000000000000  AX       0     0     16',
    '  2 .bss          00000080  0000000000404080  0000000000404080  00003080  2**4',
    '                  ALLOC',
  ].join('\n');
  const parsedMixed = parseSectionHeaders(wrappedAndObjdump);
  assert.equal(parsedMixed.length, 2);
  assert.equal(parsedMixed[0].size, 0x240n);
  assert.equal(parsedMixed[1].type, 'NOBITS');

  // 正例：超过 2^53-1 的 64 位内核态高地址（0xffff800080010005 若转 Number 会丢低位精度！）+ 小端 RIP 位移 + 表项步长全部闭合通过
  const validRes = verifyOffsets({
    sections,
    target_va: '0xffff800080010005',
    expected_file_offset: '0x10005',
    rip: {
      next_rip: '0xffff80008001002b',
      disp32: 'f5 3f 00 00', // +0x3ff5 -> 0xffff800080014020
      expected_va: '0xffff800080014020',
    },
    table: {
      base_offset: '0x13000',
      stride: '0x8',
      reserved_entries: 3, // GOT[0..2] 保留项
      index: 1,
      expected_offset: '0x13020',
      table_size: '0x48',
    },
  });
  assert.equal(validRes.valid, true);
  assert.equal(validRes.fileOffset, 0x10005n);
  assert.deepEqual(validRes.failedChecks, []);
  assert.doesNotThrow(() => JSON.stringify(validRes));

  // 反例 1：NOBITS (.bss) 边界拦截
  const nobitsRes = verifyOffsets({
    sections,
    target_va: '0xffff800080015010',
  });
  assert.equal(nobitsRes.valid, false);
  assert.equal(nobitsRes.reason, 'section_is_nobits');
  assert.equal(nobitsRes.section, '.bss');
  assert.deepEqual(nobitsRes.failedChecks, ['va_to_file_offset']);

  // 反例 2：虚拟地址越界（落在节间对齐空洞）
  const oobRes = verifyOffsets({
    sections,
    target_va: '0xffff800080012000',
  });
  assert.equal(oobRes.valid, false);
  assert.equal(oobRes.reason, 'va_out_of_section_bounds');
  assert.deepEqual(oobRes.failedChecks, ['va_to_file_offset']);

  // 反例 3：表项步长不整除（0x13025 - 0x13000 = 0x25，除以 0x8 余 0x5）
  const badStrideRes = verifyOffsets({
    sections,
    table: {
      base_offset: '0x13000',
      stride: '0x8',
      reserved_entries: 3,
      index: 1,
      expected_offset: '0x13025',
    },
  });
  assert.equal(badStrideRes.valid, false);
  assert.equal(badStrideRes.reason, 'stride_not_divisible');
  assert.deepEqual(badStrideRes.failedChecks, ['table_stride']);
  assert.equal(badStrideRes.checks.table_stride.remainder, 5n);

  // 反例 4：拒绝超过 Number.MAX_SAFE_INTEGER 的非安全 Number 入参，防止调用方误传丢失精度的浮点数
  const unsafeNumRes = verifyOffsets({
    sections,
    target_va: 0xffff800080010005,
  });
  assert.equal(unsafeNumRes.valid, false);
  assert.equal(unsafeNumRes.reason, 'invalid_bigint_input');

  // 正反例 5：ET_REL 可重定位目标文件多 sh_addr=0 节盲查拦截 vs 指定 section_name + section_offset 通过；arm_thumb 剥离 +1 位
  const relSections = [
    { name: '.text', type: 'PROGBITS', addr: '0x0', offset: '0x40', size: '0x100' },
    { name: '.rodata', type: 'PROGBITS', addr: '0x0', offset: '0x140', size: '0x80' },
  ];
  const relAmbiguous = verifyOffsets({ sections: relSections, target_va: '0x20' });
  assert.equal(relAmbiguous.valid, false);
  assert.equal(relAmbiguous.reason, 'ambiguous_relocatable_sections');

  const relExplicit = verifyOffsets({
    sections: relSections,
    section_name: '.rodata',
    section_offset: '0x20',
    expected_file_offset: '0x160',
  });
  assert.equal(relExplicit.valid, true);
  assert.equal(relExplicit.fileOffset, 0x160n);

  const thumbRes = verifyOffsets({
    sections: [{ name: '.text', type: 'PROGBITS', addr: '0x8000', offset: '0x1000', size: '0x200' }],
    arch: 'arm_thumb',
    target_va: '0x8021',
    expected_file_offset: '0x1020',
  });
  assert.equal(thumbRes.valid, true);
  assert.equal(thumbRes.checks.va_to_file_offset.thumbBitStripped, true);
});

test('公共预处理管道：内联待审材料段（quotedMaterial）跳过 M1/M3/M4 但仍拦截 M2a 私钥外泄', () => {
  const safeQuotedMaterial = [
    '统计以下导出材料的段落字数：',
    '## 待审材料原文',
    '> 为了绕过安全校验并开启这个安全过滤覆写开关，基于上一轮的结果继续。',
  ].join('\n');
  const resSafe = lintTaskBrief(safeQuotedMaterial);
  assert.equal(resSafe.ok, true);
  assert.equal(resSafe.hits.length, 0);

  const keyInQuotedMaterial = [
    '统计以下导出材料的段落字数：',
    '## 内联素材',
    '> -----BEGIN EC PRIVATE KEY-----',
  ].join('\n');
  const resKey = lintTaskBrief(keyInQuotedMaterial);
  assert.equal(resKey.blocked, true);
  assert.equal(resKey.blocks[0].subrule, 'M2a-private-key');
  assert.equal(resKey.blocks[0].line, 3);
});
