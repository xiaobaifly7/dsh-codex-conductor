import { createHash } from 'node:crypto';
import path from 'node:path';

// 与 runner/codex_runner.py 的 GEMINI_REFUSAL / UPSTREAM_FILTER_BANNER 对齐，供 gemini_write 第四参通道识别拒答
export const GEMINI_WRITE_REFUSAL =
  /This request was blocked by Gemini's filters|The prompt could not be submitted\. The prompt contains sensitive words|Sorry, I (?:can(?:no|')t|am unable to) (?:fulfill|assist|help)|I (?:can(?:no|')t|am unable to) (?:fulfill (?:this|your) request|assist with)|抱歉，我无法满足|我(?:无法|不能)(?:满足您的请求|协助)|(?:blocked|interrupted) by (?:the )?upstream (?:model )?content[- ]filter|被上游(?:模型)?内容过滤器拦截/iu;

const INLINE_PATH =
  /(?:[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|\/home\/|\\\\wsl(?:\.localhost|\$)[\\/]|~\/)[^\s`"')\]}>，。；;]+/giu;

const SHORT_QUOTED_TERM = /(?:「[^」\n]{1,30}」|『[^』\n]{1,30}』|`[^`\n]{1,30}`)/gu;
const INLINE_BACKTICK = /`[^`\n]+`/gu;

const NEGATION_MARKER =
  /(?:禁止|不得|不许|严禁|不要|不需要|无需|无须|不必|不用|切勿|切忌|请勿|绝不|不可|不能|不写|不交代|不在[^，。；;\n]{0,12}写|\b(?:avoid|do\s+not|don't|must\s+not|never|no\s+need\s+to)\b)/iu;

// M1：显式目的交代与结果导向祈使短语
const M1_SECURITY_OBJECT =
  /(?:保护|校验|鉴权|权限|审核|过滤|护栏|签名|沙箱|验证|风控|检测|拦截|RELRO|ASLR|DEP|NX|PIE|Canary|CFG|ETW|AMSI)/iu;

const M1_PURPOSE_DIRECT =
  /(?:为了|目的是|以便|好让|用来|用于|借此|从而|打算用它来|我想用它|意图是|用途是)[^。；;\n]{0,28}(?:绕过|避开|规避|覆写|篡改|破解|免杀|隐匿|防溯源|越权|脱壳|注入|欺骗|过检)/u;

const M1_PURPOSE_CONDITIONAL =
  /(?:为了|目的是|以便|好让|用来|用于|借此|从而|打算用它来|我想用它|意图是|用途是)[^。；;\n]{0,28}(?:关闭|关掉|禁用|跳过)/u;

const M1_PURPOSE_OVERRIDE_SWITCH =
  /(?:为了|目的是|以便|好让|用来|用于|借此|从而|打算用它来|我想用它|意图是|用途是)[^。；;\n]{0,24}(?:开启|打开|启用)[^。；;\n]{0,20}(?:安全|审核|内容|权限)?(?:过滤|护栏|校验|鉴权|检查)[^。；;\n]{0,12}(?:覆写|绕过|旁路|豁免)/u;

const M1_FORCE_OUTCOME =
  /(?:怎么|如何)(?:才能|能|去)?(?:让|使)(?:它|(?:这个|该|此|上述|目标)?[^。；;\n]{0,10}?(?:程序|函数|校验|检查|鉴权|验证|过滤|护栏|开关))[^。；;\n]{0,20}(?:总(?:是)?(?:返回|判为)|恒为|一律(?:放行|通过)|不再(?:拦截|报错|检查)|判为(?:有效|通过|合法))|(?:开启|打开|启用)(?:这个|该|此)?(?:安全|审核|内容|权限)?(?:过滤|护栏|校验|鉴权)(?:的)?(?:覆写|绕过|旁路|豁免)(?:开关|模式|标志)/u;

const M1_FIRST_PERSON_INTENT =
  /(?:我要|我想|我们需要|接下来我要)(?:拿到|开启|绕过|破解|关掉|改掉)[^。；;\n]{0,20}(?:之后|然后|以便|再去)|拿到[^。；;\n]{0,18}之后(?:就可以|就能|用来|再去)/u;

// M2：未脱敏凭据/个人路径、散文裸载荷字面量与未填模板槽位
const M2_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY-----/g;

const M2_SECRET_TOKEN =
  /\b(?:sk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g;

const FAKE_TOKEN_HINT = /(?:test|example|dummy|mock|sample|xxxx|0000|123456|fake|placeholder)/i;

const M2_QUOTED_HOME_PATH =
  /([`"'])((?:[A-Za-z]:[\\/]Users[\\/](?!Public\b|Default\b|<USER>)[A-Za-z0-9._-]+|\/mnt\/[a-z]\/Users\/(?!Public\b|Default\b|<USER>)[A-Za-z0-9._-]+|\/home\/(?!<user>)[a-z_][a-z0-9_-]{1,30}|\\\\(?:wsl\.localhost|wsl\$)[\\/][^\\/\s]+[\\/]home[\\/](?!<user>)[a-z_][a-z0-9_-]{1,30})(?:[\\/][^`"\r\n*?|<>]*)?)\1/giu;

const M2_BARE_HOME_PATH =
  /(?:[A-Za-z]:[\\/]Users[\\/](?!Public\b|Default\b|<USER>)[A-Za-z0-9._-]+|\/mnt\/[a-z]\/Users\/(?!Public\b|Default\b|<USER>)[A-Za-z0-9._-]+|\/home\/(?!<user>)[a-z_][a-z0-9_-]{1,30}|\\\\(?:wsl\.localhost|wsl\$)[\\/][^\\/\s]+[\\/]home[\\/](?!<user>)[a-z_][a-z0-9_-]{1,30})(?:[\\/][^\s`"')\]}>，。；;：:*?|<>]*)?/giu;

const M2_RAW_PAYLOAD =
  /(?:'\s*(?:OR|AND)\s*'1'\s*=\s*'1|\bUNION\s+ALL\s+SELECT\b|\bUNION\s+SELECT\b[^。\n]{0,40}\bFROM\b|<script\b[^>]*>[\s\S]{0,80}?<\/script>|powershell(?:\.exe)?\s+(?:-[A-Za-z]+\s+)*-(?:enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,})/giu;

const M2_UNFILLED_SLOT =
  /<(?:待填|TODO|TBD|目标二进制格式与处理器架构规范|目标机制名称|目标技术规范或通用子系统类别|目标系统架构或形式化校验模型|目标通信协议或接口调用规范)>|\bTODO_ANCHOR\b/gu;

// M3：新会话跨轮悬空指代与拆块必填段
const M3_CROSS_SESSION_REF =
  /(?:见上一(?:问|轮|单|节对话)|基于上一(?:问|轮|单)(?:的结果|结论)?|按刚才(?:说的|提到的|讨论的)|同上一(?:问|轮|单)|沿用上一(?:问|轮|单)的(?:设定|定义|符号)|继续刚才的)/u;

const M3_ANAPHORA_REF = /(?:如上文?所述)/u;
const M3_PREV_ITEM_REF = /(?:上一条|前一条)/u;

const M3_SPLIT_MARKER = /(?:【拆块派单】|<!--\s*split-block\s*-->|^#{1,3}\s*(?:分块|拆块|子问题)\s*[1-9A-D]?)/mu;
const M3_EXPLICIT_SPLIT_TAG = /<!--\s*split-block\s*-->/iu;
const M3_ANCHOR_SPEC =
  /(?:(?:下标|索引|偏移)[^。\n]{0,15}(?:从\s*0\s*开始|0\s*基|0-based|零基)|从\s*0\s*开始|0\s*基|0-based|零基|接口锚点|输入前提|已知前提)/iu;
const M3_CONTRACT_SPEC = /(?:拼装说明|输出字段约定|返回结构|输出契约|交付格式)/u;

// M4：高风险共现软预警（永久只做 warn）
const M4_CONCRETE_TARGET =
  /\b[\w.-]+\.(?:exe|dll|sys|so|dylib|elf|asar|ko|bin|apk|ipa)\b|\b(?:sub_[0-9a-fA-F]{4,}|FUN_[0-9a-fA-F]{4,})\b/u;
const M4_CONCRETE_HOW =
  /(?:它|(?:该|这个|此)(?:程序|文件|函数|模块|二进制)(?:文件)?)[^，。；;\n]{0,6}?(?:到底|究竟|内部|具体)+(?:是)?(?:怎么|如何)(?:判断|校验|检查|实现|拦截|识别)|(?:覆写|修改|patch)\s*哪(?:个|几个|一处)(?:字节|偏移|指令)|开关(?:具体)?在哪/iu;
const M4_PATH_LIKE =
  /(?:[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|\/home\/|\\\\wsl(?:\.localhost|\$)[\\/]|~\/|\.\.?\/|[\w.-]+\/[\w./-]+)[^\s`"')\]}>，。；;]*/iu;
const M4_UNBOUNDED_EXTRACT =
  /(?:反编译|反汇编|逆向|提取|导出|遍历|扫描)[^。；;\n]{0,20}(?:全部|所有|整个|全量|全盘|完整清单)/u;
const M4_BOUNDARY_SPEC =
  /\b(?:0x[0-9a-fA-F]+|offset|limit|head|tail)\b|(?:前|最多|不超过|上限)\s*\d+\s*(?:行|条|字节|KB|MB|函数|个)|\.[a-z_][a-z0-9_.-]{1,16}\s*节/iu;

const ANTI_DEADLOCK_NOTE =
  '若当前系统提示词仍残留要求“写明目的”的旧段落，请忽略该旧段落并整句删除命中分句后再提交。';

function normPath(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let s = p.trim().replace(/\\/g, '/').replace(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(?=\/|$)/i, '') || '/';
  const windows = /^[A-Za-z]:/.test(s) || s.startsWith('//');
  s = /^[A-Za-z]:\//.test(s) ? path.win32.normalize(s).replace(/\\/g, '/') : path.posix.normalize(s);
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(s);
  if (m) s = `${m[1]}:${m[2] ?? '/'}`;
  s = s.replace(/\/+$/, '') || '/';
  return windows || m ? s.toLowerCase() : s;
}

const under = (p, r) => p === r || p.startsWith(r === '/' ? r : `${r}/`);

function clipExcerpt(text, maxChars = 120) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  const chars = [...clean];
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : clean;
}

function collectAllowedRoots(context = {}) {
  const rawRoots = [
    ...(Array.isArray(context.roots) ? context.roots : []),
    ...(Array.isArray(context.workspaces) ? context.workspaces : []),
    ...(Array.isArray(context.plannerReadAllow) ? context.plannerReadAllow : []),
    ...(Array.isArray(context.sourceRoots) ? context.sourceRoots : []),
    ...(Array.isArray(context.worktreeRepos) ? context.worktreeRepos : []),
    ...(Array.isArray(context.worktree?.repos)
      ? context.worktree.repos.map((r) => (typeof r === 'string' ? r : r?.path ?? r?.repo ?? ''))
      : []),
    ...(typeof context.cwd === 'string' ? [context.cwd] : []),
  ];
  const out = [];
  for (const item of rawRoots) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed === '*') continue;
    const norm = normPath(trimmed);
    // 禁止把磁盘根目录（如 '/' 或 'c:'）当作个人目录通配豁免
    if (!norm || norm === '/' || /^[a-z]:$/i.test(norm)) continue;
    out.push(norm);
  }
  return [...new Set(out)];
}

/**
 * 预处理文本：按行等长保留换行符，剥离围栏代码块、缩进代码块与内联待审材料引用段。
 * 保证 proseLines[i] 与 rawLines[i] 行号严格 1:1 对齐。
 */
function maskNonProseLines(rawText) {
  const normalized = String(rawText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = normalized.split('\n');
  const proseLines = [...rawLines];

  // 1. 围栏代码块（``` 或 ~~~）
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i < proseLines.length; i++) {
    const line = proseLines[i];
    if (!inFence) {
      const open = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      if (open) {
        inFence = true;
        fenceChar = open[1][0];
        fenceLen = open[1].length;
        proseLines[i] = '[[CODE_BLOCK]]';
      }
    } else {
      const closeRe = new RegExp(`^[ \\t]*${fenceChar}{${fenceLen},}[ \\t]*$`);
      if (closeRe.test(line)) {
        inFence = false;
      }
      proseLines[i] = '[[CODE_BLOCK]]';
    }
  }

  // 2. 缩进代码块（空行之后连续以 4 空格或 Tab 开头的非列表段落）
  for (let i = 0; i < proseLines.length; i++) {
    if (proseLines[i] === '[[CODE_BLOCK]]') continue;
    const prevBlank = i === 0 || proseLines[i - 1].trim() === '';
    if (prevBlank && /^(?:    |\t)\S/.test(proseLines[i]) && !/^[ \t]*(?:[-*+]|\d+[.)、])\s/.test(proseLines[i])) {
      let j = i;
      while (j < proseLines.length && proseLines[j] !== '[[CODE_BLOCK]]' && (/^(?:    |\t)/.test(proseLines[j]) || proseLines[j].trim() === '')) {
        if (proseLines[j].trim() !== '') proseLines[j] = '[[CODE_BLOCK]]';
        j++;
      }
      i = j - 1;
    }
  }

  // 3. 显式内联待审材料引用段（quotedMaterial）
  let awaitingQuoteBlock = false;
  let inQuotedMaterial = false;
  for (let i = 0; i < proseLines.length; i++) {
    const line = rawLines[i];
    if (proseLines[i] === '[[CODE_BLOCK]]') continue;
    const trimmed = line.trim();
    if (/^#{1,6}\s*(?:内联素材|待审材料原文)\s*$/u.test(trimmed) ||
        trimmed.includes('这是部署方从自己的文件里导出并贴在这里的材料')) {
      awaitingQuoteBlock = true;
      inQuotedMaterial = false;
      continue;
    }
    if (awaitingQuoteBlock) {
      if (trimmed === '') continue;
      if (/^>\s?/.test(trimmed)) {
        inQuotedMaterial = true;
        awaitingQuoteBlock = false;
        proseLines[i] = '';
        continue;
      }
      awaitingQuoteBlock = false;
    }
    if (inQuotedMaterial) {
      if (/^>\s?/.test(trimmed)) {
        proseLines[i] = '';
      } else {
        inQuotedMaterial = false;
      }
    }
  }

  return { normalized, rawLines, proseLines };
}

function splitNaturalSentencesWithOffsets(lineText) {
  const out = [];
  const re = /[^。！？!?]+[。！？!?]?/gu;
  for (let m; (m = re.exec(lineText)) !== null;) {
    if (m[0].trim()) {
      out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/**
 * 复用 workflow.mjs 同款否定分句剥离算法：
 * 按 [；;] 切分句；遇到否定/禁止约束词时，将该词及其同句后续分句剔除。
 */
function stripNegatedClauses(sentence) {
  const parts = sentence.split(/[；;]/u);
  const kept = [];
  for (const part of parts) {
    const negMatch = NEGATION_MARKER.exec(part);
    if (negMatch) {
      const prefix = part.slice(0, negMatch.index).trim();
      if (prefix) kept.push(prefix);
      break;
    }
    kept.push(part);
  }
  return kept.join('；');
}

function sanitizeClauseForIntent(text) {
  return text
    .replace(SHORT_QUOTED_TERM, '<QUOTED_TERM>')
    .replace(INLINE_PATH, '<PATH>');
}

function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineNumberAt(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= index) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1;
}

function sentenceExcerptOnLine(rawLine, hintSubstring = '') {
  const sentences = splitNaturalSentencesWithOffsets(rawLine);
  if (hintSubstring) {
    const found = sentences.find((s) => s.text.includes(hintSubstring));
    if (found) return clipExcerpt(found.text);
  }
  return clipExcerpt(rawLine);
}

function scanM1OnField(field, rawText, toolName) {
  const hits = [];
  if (typeof rawText !== 'string' || !rawText.trim()) return hits;
  const { rawLines, proseLines } = maskNonProseLines(rawText);

  for (let i = 0; i < proseLines.length; i++) {
    const proseLine = proseLines[i];
    if (!proseLine || proseLine === '[[CODE_BLOCK]]') continue;
    const lineNo = i + 1;
    const rawLine = rawLines[i];
    const sentences = splitNaturalSentencesWithOffsets(proseLine);

    for (const sentObj of sentences) {
      // 先替换短引号样本和路径，再做否定分句剥离
      const sanitizedSentence = sanitizeClauseForIntent(sentObj.text);
      const positiveText = stripNegatedClauses(sanitizedSentence);
      if (!positiveText.trim()) continue;

      let subrule = null;
      let matched = '';

      const mDirect = M1_PURPOSE_DIRECT.exec(positiveText) ?? M1_PURPOSE_OVERRIDE_SWITCH.exec(positiveText);
      if (mDirect) {
        subrule = 'M1-P1';
        matched = mDirect[0];
      } else {
        const mCond = M1_PURPOSE_CONDITIONAL.exec(positiveText);
        if (mCond && M1_SECURITY_OBJECT.test(positiveText)) {
          subrule = 'M1-P1';
          matched = mCond[0];
        }
      }

      if (!subrule) {
        const mForce = M1_FORCE_OUTCOME.exec(positiveText);
        if (mForce) {
          subrule = 'M1-P2';
          matched = mForce[0];
        }
      }

      if (!subrule) {
        const mFirst = M1_FIRST_PERSON_INTENT.exec(positiveText);
        if (mFirst) {
          subrule = 'M1-P3';
          matched = mFirst[0];
        }
      }

      if (subrule) {
        const rawSent = rawLine.slice(sentObj.start, sentObj.end).trim() || rawLine.trim();
        const excerpt = clipExcerpt(rawSent);
        hits.push({
          rule: 'M1',
          subrule,
          severity: 'block',
          field,
          line: lineNo,
          excerpt,
          matched,
          message:
            `${toolName}: [M1 显式目的交代拦截] ${field} 第 ${lineNo} 行命中目的/结果导向表述「${excerpt}」。` +
            '请整句删除主观目的与后续用途交代，只保留客观技术对象、输入输出与文件边界，未启动执行端。',
        });
      }
    }
  }
  return hits;
}

function isLikelyFakeToken(token) {
  if (FAKE_TOKEN_HINT.test(token)) return true;
  const body = token.replace(/^(?:sk-(?:proj-|live-)?|gh[pousr]_|AKIA)/, '');
  return new Set([...body]).size < 6;
}

function scanM2CredentialsAndPathsOnField(field, rawText, context, toolName, { checkPaths = true } = {}) {
  const hits = [];
  if (typeof rawText !== 'string' || !rawText) return hits;
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = normalized.split('\n');
  const lineStarts = buildLineStarts(normalized);
  const allowedRoots = checkPaths ? collectAllowedRoots(context) : [];
  const redactLiterals = Array.isArray(context?.redactLiterals)
    ? context.redactLiterals.filter((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 120)
    : [];

  // M2a-1: 私钥头（含代码块与内联引用段均必须拦）
  M2_PRIVATE_KEY.lastIndex = 0;
  for (let m; (m = M2_PRIVATE_KEY.exec(normalized)) !== null;) {
    const lineNo = lineNumberAt(lineStarts, m.index);
    const excerpt = clipExcerpt(rawLines[lineNo - 1]);
    hits.push({
      rule: 'M2',
      subrule: 'M2a-private-key',
      severity: 'block',
      field,
      line: lineNo,
      excerpt,
      matched: m[0],
      message:
        `${toolName}: [M2 未脱敏凭据拦截] ${field} 第 ${lineNo} 行检测到明文私钥头「${m[0]}」，请移除凭据或脱敏为 <REDACTED>；未启动执行端。`,
    });
  }

  // M2a-2: 高置信度 API / 云凭据 Token
  M2_SECRET_TOKEN.lastIndex = 0;
  for (let m; (m = M2_SECRET_TOKEN.exec(normalized)) !== null;) {
    if (isLikelyFakeToken(m[0])) continue;
    const lineNo = lineNumberAt(lineStarts, m.index);
    const excerpt = clipExcerpt(rawLines[lineNo - 1]);
    const preview = `${m[0].slice(0, 10)}...`;
    hits.push({
      rule: 'M2',
      subrule: 'M2a-secret-token',
      severity: 'block',
      field,
      line: lineNo,
      excerpt,
      matched: m[0],
      message:
        `${toolName}: [M2 未脱敏凭据拦截] ${field} 第 ${lineNo} 行检测到高置信度密钥/令牌「${preview}」，请移除或脱敏为 <REDACTED>；未启动执行端。`,
    });
  }

  // M2a-3: 自定义敏感主机名/别名列表
  for (const literal of redactLiterals) {
    let idx = normalized.indexOf(literal);
    while (idx !== -1) {
      const lineNo = lineNumberAt(lineStarts, idx);
      const excerpt = clipExcerpt(rawLines[lineNo - 1]);
      hits.push({
        rule: 'M2',
        subrule: 'M2a-redact-literal',
        severity: 'block',
        field,
        line: lineNo,
        excerpt,
        matched: literal,
        message:
          `${toolName}: [M2 未脱敏标识拦截] ${field} 第 ${lineNo} 行检测到配置脱敏词「${literal}」，请脱敏为 <HOST> 或 <REDACTED>；未启动执行端。`,
      });
      idx = normalized.indexOf(literal, idx + literal.length);
    }
  }

  // M2a-4: 非白名单本机个人目录路径
  if (checkPaths) {
    const coveredSpans = [];
    const checkCandidatePath = (candidateRaw, index) => {
      const cleaned = candidateRaw.replace(/[.,;:!?]+$/u, '');
      const normalizedCandidate = normPath(cleaned);
      if (!normalizedCandidate) return;
      const isAllowed = allowedRoots.some((root) => under(normalizedCandidate, root));
      if (isAllowed) return;
      const lineNo = lineNumberAt(lineStarts, index);
      const excerpt = clipExcerpt(rawLines[lineNo - 1]);
      hits.push({
        rule: 'M2',
        subrule: 'M2a-user-path',
        severity: 'block',
        field,
        line: lineNo,
        excerpt,
        matched: cleaned,
        message:
          `${toolName}: [M2 未脱敏或裸字面量拦截] ${field} 第 ${lineNo} 行检测到未授权个人目录路径「${cleaned}」（不在 workspaces / plannerReadAllow 白名单内），请改为工作区相对路径或脱敏为 <USER>；未启动执行端。`,
      });
    };

    M2_QUOTED_HOME_PATH.lastIndex = 0;
    for (let m; (m = M2_QUOTED_HOME_PATH.exec(normalized)) !== null;) {
      coveredSpans.push([m.index, m.index + m[0].length]);
      checkCandidatePath(m[2], m.index + 1);
    }

    M2_BARE_HOME_PATH.lastIndex = 0;
    for (let m; (m = M2_BARE_HOME_PATH.exec(normalized)) !== null;) {
      const pos = m.index;
      if (coveredSpans.some(([s, e]) => pos >= s && pos < e)) continue;
      checkCandidatePath(m[0], pos);
    }
  }

  return hits;
}

function scanM2ProsePayloadsAndSlotsOnField(field, rawText, toolName) {
  const hits = [];
  if (typeof rawText !== 'string' || !rawText.trim()) return hits;
  const { rawLines, proseLines } = maskNonProseLines(rawText);
  // 将行内反引号与短书名号引用替换为等行数占位符，保留换行位置不变
  const proseWithoutInlineCode = proseLines
    .map((line) =>
      line === '[[CODE_BLOCK]]'
        ? ''
        : line.replace(INLINE_BACKTICK, '<INLINE_CODE>').replace(SHORT_QUOTED_TERM, '<QUOTED_TERM>'),
    )
    .join('\n');
  const lineStarts = buildLineStarts(proseWithoutInlineCode);

  // M2b: 散文裸特征载荷字面量
  M2_RAW_PAYLOAD.lastIndex = 0;
  for (let m; (m = M2_RAW_PAYLOAD.exec(proseWithoutInlineCode)) !== null;) {
    const lineNo = lineNumberAt(lineStarts, m.index);
    const excerpt = clipExcerpt(rawLines[lineNo - 1]);
    hits.push({
      rule: 'M2',
      subrule: 'M2b-raw-payload',
      severity: 'block',
      field,
      line: lineNo,
      excerpt,
      matched: clipExcerpt(m[0], 60),
      message:
        `${toolName}: [M2 未脱敏或裸字面量拦截] ${field} 第 ${lineNo} 行散文区检测到裸特征载荷字面量「${clipExcerpt(m[0], 60)}」，请改用抽象特征描述或放入代码块/反引号内；未启动执行端。`,
    });
  }

  // M2c: 未填充完的拆块模板槽位
  M2_UNFILLED_SLOT.lastIndex = 0;
  for (let m; (m = M2_UNFILLED_SLOT.exec(proseWithoutInlineCode)) !== null;) {
    const lineNo = lineNumberAt(lineStarts, m.index);
    const excerpt = clipExcerpt(rawLines[lineNo - 1]);
    hits.push({
      rule: 'M2',
      subrule: 'M2c-unfilled-slot',
      severity: 'block',
      field,
      line: lineNo,
      excerpt,
      matched: m[0],
      message:
        `${toolName}: [M2 未替换模板槽位拦截] ${field} 第 ${lineNo} 行存在未填充占位符「${m[0]}」，请填写具体技术参数后再提交；未启动执行端。`,
    });
  }

  return hits;
}

function scanM3NewSession(taskText, acceptanceList, toolName) {
  const hits = [];
  const hasTask = typeof taskText === 'string' && taskText.trim().length > 0;
  const taskMasked = hasTask ? maskNonProseLines(taskText) : null;

  // M3a: 扫描 task 与 acceptance 中的悬空跨轮指代
  if (taskMasked) {
    const { rawLines, proseLines } = taskMasked;
    let nonWsBefore = 0;
    for (let i = 0; i < proseLines.length; i++) {
      const proseLine = proseLines[i];
      const lineNo = i + 1;
      if (proseLine && proseLine !== '[[CODE_BLOCK]]') {
        const sanitized = sanitizeClauseForIntent(proseLine);
        const positive = stripNegatedClauses(sanitized);

        const crossMatch = M3_CROSS_SESSION_REF.exec(positive);
        if (crossMatch) {
          const excerpt = sentenceExcerptOnLine(rawLines[i], crossMatch[0]);
          hits.push({
            rule: 'M3',
            subrule: 'M3a-dangling-ref',
            severity: 'block',
            field: 'task',
            line: lineNo,
            excerpt,
            matched: crossMatch[0],
            message:
              `${toolName}: [M3 新会话悬空指代拦截] 本单未传 resume（全新独立会话，执行端看不到本对话历史），但 task 第 ${lineNo} 行出现跨轮指代「${crossMatch[0]}」。请把前置定义、路径或已知数值直接内联写全后再派。`,
          });
        } else {
          const anaMatch = M3_ANAPHORA_REF.exec(positive);
          if (anaMatch) {
            const prefixNonWs = [...proseLine.slice(0, proseLine.indexOf(anaMatch[0])).replace(/\s+/gu, '')].length;
            const totalBefore = nonWsBefore + (proseLine.includes(anaMatch[0]) ? prefixNonWs : 0);
            if (totalBefore < 200) {
              const excerpt = sentenceExcerptOnLine(rawLines[i], anaMatch[0]);
              hits.push({
                rule: 'M3',
                subrule: 'M3a-dangling-ref',
                severity: 'block',
                field: 'task',
                line: lineNo,
                excerpt,
                matched: anaMatch[0],
                message:
                  `${toolName}: [M3 新会话悬空指代拦截] 本单未传 resume（全新独立会话），task 第 ${lineNo} 行开头（前 200 非空白字符内）出现无前文指代「${anaMatch[0]}」。请直接写明前置定义后再派。`,
              });
            }
          }
        }
      }
      if (proseLine !== '[[CODE_BLOCK]]') {
        nonWsBefore += [...proseLine.replace(/\s+/gu, '')].length;
      }
    }
  }

  if (Array.isArray(acceptanceList)) {
    for (let idx = 0; idx < acceptanceList.length; idx++) {
      const item = acceptanceList[idx];
      if (typeof item !== 'string' || !item.trim()) continue;
      const field = `acceptance[${idx}]`;
      const { rawLines, proseLines } = maskNonProseLines(item);
      for (let i = 0; i < proseLines.length; i++) {
        const proseLine = proseLines[i];
        if (!proseLine || proseLine === '[[CODE_BLOCK]]') continue;
        const lineNo = i + 1;
        const positive = stripNegatedClauses(sanitizeClauseForIntent(proseLine));
        const crossMatch = M3_CROSS_SESSION_REF.exec(positive);
        const firstItemAnaphora =
          idx === 0 ? M3_ANAPHORA_REF.exec(positive) ?? M3_PREV_ITEM_REF.exec(positive) : null;
        const hitMatch = crossMatch ?? firstItemAnaphora;
        if (hitMatch) {
          const excerpt = sentenceExcerptOnLine(rawLines[i], hitMatch[0]);
          hits.push({
            rule: 'M3',
            subrule: 'M3a-dangling-ref',
            severity: 'block',
            field,
            line: lineNo,
            excerpt,
            matched: hitMatch[0],
            message:
              `${toolName}: [M3 新会话悬空指代拦截] 本单未传 resume（全新独立会话），${field} 第 ${lineNo} 行出现无前文悬空指代「${hitMatch[0]}」。请将验收条件内联写全后再派。`,
          });
        }
      }
    }
  }

  // M3b: 显式拆块派单标记下的锚点/下标基准与输出契约检查
  if (taskMasked) {
    const { normalized, rawLines, proseLines } = taskMasked;
    const proseJoined = proseLines.map((l) => (l === '[[CODE_BLOCK]]' ? '' : l)).join('\n');
    const markerMatch = M3_SPLIT_MARKER.exec(proseJoined) ?? (M3_EXPLICIT_SPLIT_TAG.exec(normalized));
    if (markerMatch) {
      const combinedText = [
        proseJoined,
        ...(Array.isArray(acceptanceList) ? acceptanceList.filter((x) => typeof x === 'string') : []),
      ].join('\n');
      const hasAnchor = M3_ANCHOR_SPEC.test(combinedText);
      const hasContract = M3_CONTRACT_SPEC.test(combinedText);
      if (!hasAnchor || !hasContract) {
        const sourceText = proseJoined.includes(markerMatch[0]) ? proseJoined : normalized;
        const lineNo = lineNumberAt(buildLineStarts(sourceText), markerMatch.index);
        const excerpt = clipExcerpt(rawLines[lineNo - 1] ?? markerMatch[0]);
        const missingParts = [
          ...(!hasAnchor ? ['接口锚点/下标基准说明（如从 0 开始 / 0-based / 输入前提）'] : []),
          ...(!hasContract ? ['本地拼装/输出契约段（如拼装说明 / 输出字段约定 / 返回结构）'] : []),
        ].join('、');
        const explicitTag = M3_EXPLICIT_SPLIT_TAG.test(normalized);
        hits.push({
          rule: 'M3',
          subrule: 'M3b-split-contract',
          severity: explicitTag ? 'block' : 'warn',
          field: 'task',
          line: lineNo,
          excerpt,
          matched: markerMatch[0],
          message:
            `${toolName}: [M3b 拆块结构提示] task 第 ${lineNo} 行声明为拆块派单（「${clipExcerpt(markerMatch[0], 40)}」），但缺少${missingParts}。建议补齐从 0 开始的下标基准、输入前提与返回结构约定。`,
        });
      }
    }
  }

  return hits;
}

function scanM4SoftWarningsOnField(field, rawText) {
  const hits = [];
  if (typeof rawText !== 'string' || !rawText.trim()) return hits;
  const { rawLines, proseLines } = maskNonProseLines(rawText);

  // 按空行切分自然段，保留每段起始行号
  const paragraphs = [];
  let startLine = 1;
  let buf = [];
  for (let i = 0; i < proseLines.length; i++) {
    const line = proseLines[i] === '[[CODE_BLOCK]]' ? '' : proseLines[i];
    if (line.trim() === '') {
      if (buf.length > 0) {
        paragraphs.push({ startLine, lines: buf });
        buf = [];
      }
      startLine = i + 2;
    } else {
      if (buf.length === 0) startLine = i + 1;
      buf.push({ lineNo: i + 1, text: line, raw: rawLines[i] });
    }
  }
  if (buf.length > 0) paragraphs.push({ startLine, lines: buf });

  for (const para of paragraphs) {
    const paraClean = para.lines.map((l) => l.text.replace(SHORT_QUOTED_TERM, '<QUOTED_TERM>')).join('\n');
    const paraPositiveLines = para.lines.map((l) => ({
      ...l,
      positive: stripNegatedClauses(l.text.replace(SHORT_QUOTED_TERM, '<QUOTED_TERM>')),
    }));
    const paraPositive = paraPositiveLines.map((l) => l.positive).join('\n');

    // M4a: 具体二进制载体/私有符号 + 直问具体内部判定逻辑
    if (M4_CONCRETE_TARGET.test(paraClean) && M4_CONCRETE_HOW.test(paraPositive)) {
      const hitLineObj = paraPositiveLines.find((l) => M4_CONCRETE_HOW.test(l.positive)) ?? para.lines[0];
      const mHow = M4_CONCRETE_HOW.exec(hitLineObj.positive ?? paraPositive);
      hits.push({
        rule: 'M4',
        subrule: 'M4a-concrete-how',
        severity: 'warn',
        field,
        line: hitLineObj.lineNo,
        excerpt: clipExcerpt(hitLineObj.raw),
        matched: mHow ? mHow[0] : '',
        message:
          '[预检风险提示 M4a] 任务书在同一段内点名具体二进制/符号并直问其内部具体判定实现，实测此类句式易被模型拒答或仅返回空泛过场话。' +
          '若本单被拒，不要原样重派：请先由规划端用本地只读命令（readelf/objdump/strings/grep）提取静态结构，再改问通用机制的分层组织方式。',
      });
    }

    // M4b: 具体本地文件路径/二进制 + 无边界全量反编译/扫描/提取祈使动词 && 无显式边界
    if (
      (M4_PATH_LIKE.test(paraClean) || M4_CONCRETE_TARGET.test(paraClean)) &&
      M4_UNBOUNDED_EXTRACT.test(paraPositive) &&
      !M4_BOUNDARY_SPEC.test(paraClean)
    ) {
      const hitLineObj = paraPositiveLines.find((l) => M4_UNBOUNDED_EXTRACT.test(l.positive)) ?? para.lines[0];
      const mExt = M4_UNBOUNDED_EXTRACT.exec(hitLineObj.positive ?? paraPositive);
      hits.push({
        rule: 'M4',
        subrule: 'M4b-unbounded-extract',
        severity: 'warn',
        field,
        line: hitLineObj.lineNo,
        excerpt: clipExcerpt(hitLineObj.raw),
        matched: mExt ? mExt[0] : '',
        message:
          '[预检风险提示 M4b] 任务书对具体文件要求全量提取/反汇编但未声明偏移、节名或条数上限，易引发执行端工具空转超时（400s+）。建议后续单限定具体节区、字节区间或最大输出条数。',
      });
    }
  }

  return hits;
}

function finalizeLintResult(hits, context = {}) {
  const blocks = hits.filter((h) => h.severity === 'block');
  const warnings = hits.filter((h) => h.severity === 'warn');
  let message = blocks.map((b) => b.message).join('\n');
  const hasM1Block = blocks.some((b) => b.rule === 'M1');
  const repeatedM1 =
    (Number.isInteger(context?.consecutiveM1Blocks) && context.consecutiveM1Blocks >= 2) ||
    (Number.isInteger(context?.previousM1Blocks) && context.previousM1Blocks >= 1);
  if (hasM1Block && repeatedM1) {
    message = `${message} ${ANTI_DEADLOCK_NOTE}`;
  }
  return {
    ok: blocks.length === 0,
    blocked: blocks.length > 0,
    hits,
    blocks,
    warnings,
    message,
  };
}

/**
 * M5 归一化任务指纹：NFKC 归一，剔除行首列表序号、空白序列与标点符号后计算 SHA-256。
 */
export function normalizedTaskIdentity(text) {
  const normalized = String(text ?? '')
    .normalize('NFKC')
    .replace(/^[ \t]*(?:[-*+]|\(?\d+[.):、])[ \t]*/gmu, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * 主入口：收任务书文本（或含 task/acceptance/rerun_after_change 的参数对象）与上下文，执行 M1–M4 检查。
 */
export function lintTaskBrief(input, context = {}) {
  if (context?.taskBriefGuard === 'off' || Boolean(context?.verificationOf ?? input?.verificationOf)) {
    return finalizeLintResult([], context);
  }
  if (Boolean(context?.continuation)) {
    return lintContinuationDelta(typeof input === 'object' && input !== null ? input : {}, context);
  }

  const isObj = typeof input === 'object' && input !== null && !Array.isArray(input);
  const task = isObj ? String(input.task ?? '') : String(input ?? '');
  const acceptance = isObj && Array.isArray(input.acceptance)
    ? input.acceptance
    : Array.isArray(context?.acceptance)
      ? context.acceptance
      : [];
  const rerunAfterChange = isObj && typeof input.rerun_after_change === 'string'
    ? input.rerun_after_change
    : typeof context?.rerun_after_change === 'string'
      ? context.rerun_after_change
      : '';
  const acknowledgeWarning = Boolean(
    (isObj && input.acknowledge_risk_warning === true) || context?.acknowledge_risk_warning === true || context?.acknowledgeRiskWarning === true,
  );
  const isResumedOrFresh = Boolean(
    (isObj && (input.resume || input.conversation_id || input.fresh)) ||
    context?.resume ||
    context?.conversation_id ||
    context?.fresh,
  );
  const toolName = context?.tool ?? 'codex_run';

  const hits = [];

  // M2（未脱敏标识、裸载荷字面量、空模板槽位）
  hits.push(...scanM2CredentialsAndPathsOnField('task', task, context, toolName));
  hits.push(...scanM2ProsePayloadsAndSlotsOnField('task', task, toolName));
  for (let i = 0; i < acceptance.length; i++) {
    if (typeof acceptance[i] !== 'string') continue;
    const field = `acceptance[${i}]`;
    hits.push(...scanM2CredentialsAndPathsOnField(field, acceptance[i], context, toolName));
    hits.push(...scanM2ProsePayloadsAndSlotsOnField(field, acceptance[i], toolName));
  }
  if (rerunAfterChange) {
    hits.push(...scanM2CredentialsAndPathsOnField('rerun_after_change', rerunAfterChange, context, toolName));
    hits.push(...scanM2ProsePayloadsAndSlotsOnField('rerun_after_change', rerunAfterChange, toolName));
  }

  // M1（显式目的交代与结果导向祈使短语）
  hits.push(...scanM1OnField('task', task, toolName));
  for (let i = 0; i < acceptance.length; i++) {
    if (typeof acceptance[i] !== 'string') continue;
    hits.push(...scanM1OnField(`acceptance[${i}]`, acceptance[i], toolName));
  }
  if (rerunAfterChange) {
    hits.push(...scanM1OnField('rerun_after_change', rerunAfterChange, toolName));
  }

  // M3（仅全新独立会话检查悬空指代与拆块结构）
  if (!isResumedOrFresh) {
    hits.push(...scanM3NewSession(task, acceptance, toolName));
  }

  // M4（软预警，不阻断启动；acknowledge_risk_warning=true 时消音）
  if (!acknowledgeWarning) {
    hits.push(...scanM4SoftWarningsOnField('task', task));
  }

  return finalizeLintResult(hits, context);
}

/**
 * 续接场景增量预检：只扫本次新提交的 answers[].answer / resolution / rerun_after_change，不重扫历史父任务正文，跳过 M3。
 */
export function lintContinuationDelta(args = {}, context = {}) {
  if (context?.taskBriefGuard === 'off' || Boolean(context?.verificationOf)) {
    return finalizeLintResult([], context);
  }
  const toolName = context?.tool ?? 'codex_continue';
  const acknowledgeWarning = Boolean(
    args?.acknowledge_risk_warning === true || context?.acknowledge_risk_warning === true || context?.acknowledgeRiskWarning === true,
  );
  const fields = [];
  if (Array.isArray(args?.answers)) {
    for (let i = 0; i < args.answers.length; i++) {
      const ans = args.answers[i];
      const text = typeof ans === 'string' ? ans : ans?.answer;
      if (typeof text === 'string' && text.length > 0) {
        fields.push([`answers[${i}].answer`, text]);
      }
    }
  }
  if (typeof args?.resolution === 'string' && args.resolution.length > 0) {
    fields.push(['resolution', args.resolution]);
  }
  if (typeof args?.rerun_after_change === 'string' && args.rerun_after_change.length > 0) {
    fields.push(['rerun_after_change', args.rerun_after_change]);
  }

  const hits = [];
  for (const [field, text] of fields) {
    hits.push(...scanM2CredentialsAndPathsOnField(field, text, context, toolName));
    hits.push(...scanM2ProsePayloadsAndSlotsOnField(field, text, toolName));
    hits.push(...scanM1OnField(field, text, toolName));
    if (!acknowledgeWarning) {
      hits.push(...scanM4SoftWarningsOnField(field, text));
    }
  }

  return finalizeLintResult(hits, context);
}

/**
 * gemini_write 第四参通道专用检查：
 * - prompt 与 frontmatter.title 执行 M1 + M2 + M4（跳过 M3a）
 * - frontmatter 其余字符串字段执行 M2
 * - sources 侧素材内容仅执行 M2a 高置信度私钥/凭据防泄漏检查
 */
export function lintGeminiWrite(args = {}, sources = [], context = {}) {
  if (context?.taskBriefGuard === 'off') {
    return finalizeLintResult([], context);
  }
  const toolName = context?.tool ?? 'gemini_write';
  const acknowledgeWarning = Boolean(
    args?.acknowledge_risk_warning === true || context?.acknowledge_risk_warning === true || context?.acknowledgeRiskWarning === true,
  );
  const hits = [];

  const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
  if (prompt) {
    hits.push(...scanM2CredentialsAndPathsOnField('prompt', prompt, context, toolName));
    hits.push(...scanM2ProsePayloadsAndSlotsOnField('prompt', prompt, toolName));
    hits.push(...scanM1OnField('prompt', prompt, toolName));
    if (!acknowledgeWarning) {
      hits.push(...scanM4SoftWarningsOnField('prompt', prompt));
    }
  }

  if (args?.frontmatter && typeof args.frontmatter === 'object' && !Array.isArray(args.frontmatter)) {
    for (const [key, val] of Object.entries(args.frontmatter)) {
      const items = Array.isArray(val) ? val : [val];
      for (let i = 0; i < items.length; i++) {
        if (typeof items[i] !== 'string' || !items[i]) continue;
        const field = Array.isArray(val) ? `frontmatter.${key}[${i}]` : `frontmatter.${key}`;
        hits.push(...scanM2CredentialsAndPathsOnField(field, items[i], context, toolName));
        hits.push(...scanM2ProsePayloadsAndSlotsOnField(field, items[i], toolName));
        if (key === 'title') {
          hits.push(...scanM1OnField(field, items[i], toolName));
        }
      }
    }
  }

  const sourceList = Array.isArray(sources) && sources.length > 0
    ? sources
    : Array.isArray(args?.sources)
      ? args.sources.filter((s) => s && typeof s === 'object' && typeof s.content === 'string')
      : [];

  for (let i = 0; i < sourceList.length; i++) {
    const src = sourceList[i];
    const content = typeof src === 'string' ? src : src?.content;
    if (typeof content !== 'string' || !content) continue;
    const label = typeof src === 'object' && src?.path ? `sources[${i}](${src.path})` : `sources[${i}]`;
    // 素材文件仅执行 M2a 私钥/凭据头防泄漏检查，不扫 M1/M2b/M2c/M3/M4
    hits.push(...scanM2CredentialsAndPathsOnField(label, content, context, toolName, { checkPaths: false }));
  }

  return finalizeLintResult(hits, context);
}
