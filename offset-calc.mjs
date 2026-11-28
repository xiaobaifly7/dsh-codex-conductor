// M6：ELF 节表头文本解析与 64 位 BigInt 偏移/位移/表项步长确定性验算（全链路纯 BigInt 运算）

const READELF_WIDE_LINE =
  /^\s*\[\s*(\d+)\]\s+(?:(\S+)\s+)?([A-Z0-9_+.-]+)\s+([0-9a-fA-F]{6,16})\s+([0-9a-fA-F]{4,16})\s+([0-9a-fA-F]{4,16})(?:\s+([0-9a-fA-F]{2,16}))?(?:\s|$)/;

const READELF_WRAP_HEAD =
  /^\s*\[\s*(\d+)\]\s+(?:(\S+)\s+)?([A-Z0-9_+.-]+)\s+([0-9a-fA-F]{6,16})\s+([0-9a-fA-F]{4,16})\s*$/;

const READELF_WRAP_CONT =
  /^\s+([0-9a-fA-F]{4,16})\s+([0-9a-fA-F]{2,16})(?:\s|$)/;

const OBJDUMP_HEADER_LINE =
  /^\s*(\d+)\s+(\S+)\s+([0-9a-fA-F]{6,16})\s+([0-9a-fA-F]{6,16})\s+([0-9a-fA-F]{6,16})\s+([0-9a-fA-F]{6,16})\s+2\*\*\d+/;

function formatHex(value) {
  if (typeof value !== 'bigint') return String(value);
  return value < 0n ? `-0x${(-value).toString(16)}` : `0x${value.toString(16)}`;
}

function attachBigIntSafeJson(obj) {
  Object.defineProperty(obj, 'toJSON', {
    enumerable: false,
    value() {
      const convert = (val) => {
        if (typeof val === 'bigint') return formatHex(val);
        if (Array.isArray(val)) return val.map(convert);
        if (val && typeof val === 'object') {
          const out = {};
          for (const [k, v] of Object.entries(val)) out[k] = convert(v);
          return out;
        }
        return val;
      };
      return convert({ ...this });
    },
  });
  return obj;
}

function parseBigIntStrict(value, fieldName, { allowNegative = false } = {}) {
  if (typeof value === 'bigint') {
    if (!allowNegative && value < 0n) {
      throw new TypeError(`${fieldName} 不能为负数：${formatHex(value)}`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${fieldName} 必须使用 BigInt 或十六进制/十进制整数字符串，拒绝非安全整数或浮点数：${value}`);
    }
    const bi = BigInt(value);
    if (!allowNegative && bi < 0n) {
      throw new TypeError(`${fieldName} 不能为负数：${value}`);
    }
    return bi;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/_/g, '');
    if (!trimmed) throw new TypeError(`${fieldName} 不能为空字符串`);
    const hexMatch = /^([+-])?0x([0-9a-fA-F]+)$/i.exec(trimmed);
    if (hexMatch) {
      const sign = hexMatch[1] === '-' ? -1n : 1n;
      const bi = sign * BigInt(`0x${hexMatch[2]}`);
      if (!allowNegative && bi < 0n) {
        throw new TypeError(`${fieldName} 不能为负数：${value}`);
      }
      return bi;
    }
    const decMatch = /^([+-])?(\d+)$/.exec(trimmed);
    if (decMatch) {
      const sign = decMatch[1] === '-' ? -1n : 1n;
      const bi = sign * BigInt(decMatch[2]);
      if (!allowNegative && bi < 0n) {
        throw new TypeError(`${fieldName} 不能为负数：${value}`);
      }
      return bi;
    }
  }
  throw new TypeError(`${fieldName} 不是合法的 64 位整数或十六进制字面量：${String(value)}`);
}

function parseDisp32BigInt(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // 支持小端 4 字节机器码（如 '25 2f 00 00' 或 'e0 ff ff ff'）
    const leBytes = /^([0-9a-fA-F]{2})(?:[\s,]+([0-9a-fA-F]{2})){3}$/.exec(trimmed);
    if (leBytes) {
      const parts = trimmed.split(/[\s,]+/).map((b) => BigInt(`0x${b}`));
      const u32 = parts[0] | (parts[1] << 8n) | (parts[2] << 16n) | (parts[3] << 24n);
      return u32 >= 0x80000000n ? u32 - 0x100000000n : u32;
    }
    // 支持无符号 32 位补码十六进制（如 '0xffffffe0'）自动做有符号扩展
    if (/^0x[0-9a-fA-F]{8}$/i.test(trimmed)) {
      const u32 = BigInt(trimmed);
      return u32 >= 0x80000000n ? u32 - 0x100000000n : u32;
    }
  }
  const signed = parseBigIntStrict(value, 'disp32', { allowNegative: true });
  if (signed < -0x80000000n || signed > 0x7fffffffn) {
    const err = new RangeError(`disp32 超出 32 位有符号位移范围 [-0x80000000, 0x7fffffff]：${formatHex(signed)}`);
    err.code = 'disp32_out_of_range';
    throw err;
  }
  return signed;
}

/**
 * 解析 GNU readelf -S -W（单行）、默认 readelf -S（双行折行）及 objdump -h 的节表头文本。
 * 所有地址、偏移、大小字段均返回 BigInt。
 */
export function parseSectionHeaders(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return [];
  const lines = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const sections = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1. GNU readelf -S -W 单行格式
    const wide = READELF_WIDE_LINE.exec(line);
    if (wide) {
      sections.push({
        index: BigInt(wide[1]),
        name: wide[2] ?? '',
        type: wide[3].toUpperCase(),
        addr: BigInt(`0x${wide[4]}`),
        offset: BigInt(`0x${wide[5]}`),
        size: BigInt(`0x${wide[6]}`),
        entSize: wide[7] ? BigInt(`0x${wide[7]}`) : 0n,
      });
      continue;
    }

    // 2. GNU readelf -S 默认双行折行格式
    const wrapHead = READELF_WRAP_HEAD.exec(line);
    if (wrapHead && i + 1 < lines.length) {
      const wrapCont = READELF_WRAP_CONT.exec(lines[i + 1]);
      if (wrapCont) {
        sections.push({
          index: BigInt(wrapHead[1]),
          name: wrapHead[2] ?? '',
          type: wrapHead[3].toUpperCase(),
          addr: BigInt(`0x${wrapHead[4]}`),
          offset: BigInt(`0x${wrapHead[5]}`),
          size: BigInt(`0x${wrapCont[1]}`),
          entSize: BigInt(`0x${wrapCont[2]}`),
        });
        i++;
        continue;
      }
    }

    // 3. objdump -h 格式（Idx Name Size VMA LMA File_off Algn + 下一行属性标志）
    const objdump = OBJDUMP_HEADER_LINE.exec(line);
    if (objdump) {
      let flagsLine = '';
      if (i + 1 < lines.length && /^\s+[A-Z_]+(?:\s*,\s*[A-Z_]+)*\s*$/.test(lines[i + 1])) {
        flagsLine = lines[i + 1].trim().toUpperCase();
        i++;
      }
      const hasContents = flagsLine.includes('CONTENTS');
      const hasAlloc = flagsLine.includes('ALLOC');
      const inferredType = !flagsLine
        ? 'PROGBITS'
        : !hasContents && hasAlloc
          ? 'NOBITS'
          : 'PROGBITS';
      sections.push({
        index: BigInt(objdump[1]),
        name: objdump[2],
        type: inferredType,
        addr: BigInt(`0x${objdump[4]}`),
        offset: BigInt(`0x${objdump[6]}`),
        size: BigInt(`0x${objdump[3]}`),
        entSize: 0n,
      });
    }
  }

  return sections;
}

function normalizeSectionList(input) {
  if (typeof input === 'string') return parseSectionHeaders(input);
  if (!Array.isArray(input)) return [];
  return input.map((sec, idx) => ({
    index: sec.index !== undefined ? parseBigIntStrict(sec.index, `sections[${idx}].index`) : BigInt(idx),
    name: String(sec.name ?? ''),
    type: String(sec.type ?? 'PROGBITS').toUpperCase(),
    addr: parseBigIntStrict(sec.addr, `sections[${idx}].addr`),
    offset: parseBigIntStrict(sec.offset, `sections[${idx}].offset`),
    size: parseBigIntStrict(sec.size, `sections[${idx}].size`),
    entSize: sec.entSize !== undefined ? parseBigIntStrict(sec.entSize, `sections[${idx}].entSize`) : 0n,
  }));
}

/**
 * M6 确定性 64 位 BigInt 偏移/位移/表项步长验算。
 * 支持：
 * 1) 虚拟地址 → 文件字节偏移换算与节边界校验（含 NOBITS 拦截、越界拦截、ET_REL 重叠节拦截、ARM Thumb 最低位剥离）
 * 2) RIP 相对 32 位有符号位移闭合验算（next_rip + disp32 === expected_va）
 * 3) 线性表项步长与下标验算（base_offset + (reserved_entries + index) * stride，含步长整除性与表边界检查）
 */
export function verifyOffsets(params = {}) {
  const failures = [];
  const checks = {};

  const recordFailure = (check, reason, message) => {
    failures.push({ check, reason, message });
  };

  try {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new TypeError('params 必须是对象');
    }

    const arch = params.arch ?? 'generic';
    if (!['x86_64', 'aarch64', 'arm_thumb', 'generic'].includes(arch)) {
      throw new TypeError(`不支持的 arch 参数：${String(arch)}`);
    }

    const rawSectionInput =
      params.sections ?? params.section_headers ?? params.sectionHeaders ?? params.rawText;
    const sections = rawSectionInput !== undefined ? normalizeSectionList(rawSectionInput) : [];

    const hasVaCheck =
      params.target_va !== undefined ||
      params.targetVa !== undefined ||
      params.section_name !== undefined ||
      params.sectionName !== undefined;

    const ripInput = params.rip && typeof params.rip === 'object' ? params.rip : params;
    const hasRipCheck =
      params.rip !== undefined ||
      params.next_rip !== undefined ||
      params.nextRip !== undefined ||
      params.disp32 !== undefined;

    const tableInput = params.table && typeof params.table === 'object' ? params.table : params;
    const hasTableCheck =
      params.table !== undefined ||
      params.stride !== undefined ||
      params.base_offset !== undefined ||
      params.baseOffset !== undefined;

    if (!hasVaCheck && !hasRipCheck && !hasTableCheck) {
      recordFailure('input', 'no_verification_target', '未提供待验算的 target_va、rip 位移或 table 步长参数');
    }

    // 1. 虚拟地址 / 指定节内偏移 → 文件字节偏移换算与边界校验
    let computedFileOffset;
    let computedStaticVa;
    if (hasVaCheck) {
      const sectionName = params.section_name ?? params.sectionName;
      const sectionOffsetRaw = params.section_offset ?? params.sectionOffset;
      const expectedFileOffsetRaw =
        params.expected_file_offset ??
        params.expectedFileOffset ??
        (!hasTableCheck ? params.expected_offset ?? params.expectedOffset : undefined);
      const expectedFileOffset =
        expectedFileOffsetRaw !== undefined
          ? parseBigIntStrict(expectedFileOffsetRaw, 'expected_file_offset')
          : undefined;

      if (!sections.length) {
        checks.va_to_file_offset = { valid: false, reason: 'empty_sections' };
        recordFailure('va_to_file_offset', 'empty_sections', '节表为空，无法执行节边界与文件偏移验算');
      } else if (sectionName !== undefined) {
        const sec = sections.find((s) => s.name === sectionName);
        if (!sec) {
          checks.va_to_file_offset = { valid: false, reason: 'section_not_found', section: sectionName };
          recordFailure('va_to_file_offset', 'section_not_found', `未在节表中找到指定节 ${sectionName}`);
        } else if (sec.type === 'NOBITS') {
          checks.va_to_file_offset = { valid: false, reason: 'section_is_nobits', section: sec.name };
          recordFailure(
            'va_to_file_offset',
            'section_is_nobits',
            `目标节 ${sec.name} 类型为 NOBITS（文件中不占实际磁盘字节），禁止换算为文件偏移读取`,
          );
        } else {
          const secOff =
            sectionOffsetRaw !== undefined ? parseBigIntStrict(sectionOffsetRaw, 'section_offset') : 0n;
          if (secOff < 0n || secOff >= sec.size) {
            checks.va_to_file_offset = {
              valid: false,
              reason: 'section_offset_out_of_bounds',
              section: sec.name,
              sectionOffset: secOff,
              sectionSize: sec.size,
            };
            recordFailure(
              'va_to_file_offset',
              'section_offset_out_of_bounds',
              `节内偏移 ${formatHex(secOff)} 超出节 ${sec.name} 大小范围 [0x0, ${formatHex(sec.size)})`,
            );
          } else {
            computedFileOffset = sec.offset + secOff;
            computedStaticVa = sec.addr + secOff;
            const matchesExpected =
              expectedFileOffset === undefined ? true : computedFileOffset === expectedFileOffset;
            const delta = expectedFileOffset === undefined ? 0n : computedFileOffset - expectedFileOffset;
            checks.va_to_file_offset = {
              valid: matchesExpected,
              reason: matchesExpected ? null : 'file_offset_mismatch',
              section: sec.name,
              staticVa: computedStaticVa,
              staticVaHex: formatHex(computedStaticVa),
              fileOffset: computedFileOffset,
              fileOffsetHex: formatHex(computedFileOffset),
              ...(expectedFileOffset !== undefined
                ? {
                    expectedFileOffset,
                    expectedFileOffsetHex: formatHex(expectedFileOffset),
                    matchesExpected,
                    delta,
                    deltaHex: formatHex(delta),
                  }
                : {}),
            };
            if (!matchesExpected) {
              recordFailure(
                'va_to_file_offset',
                'file_offset_mismatch',
                `文件偏移验算不一致：实算 ${formatHex(computedFileOffset)} !== 预期 ${formatHex(expectedFileOffset)}（差值 ${formatHex(delta)}）`,
              );
            }
          }
        }
      } else {
        // 检查是否为 ET_REL（多个非空非 NOBITS 节 sh_addr === 0n）
        const zeroAddrProgSections = sections.filter(
          (s) => s.type !== 'NULL' && s.type !== 'NOBITS' && s.size > 0n && s.addr === 0n,
        );
        if (zeroAddrProgSections.length > 1) {
          checks.va_to_file_offset = {
            valid: false,
            reason: 'ambiguous_relocatable_sections',
            overlappingSections: zeroAddrProgSections.map((s) => s.name),
          };
          recordFailure(
            'va_to_file_offset',
            'ambiguous_relocatable_sections',
            `检测到多个 sh_addr=0x0 的可重定位节（${zeroAddrProgSections.map((s) => s.name).join(', ')}），请改传 section_name + section_offset`,
          );
        } else {
          const rawTargetVa = parseBigIntStrict(params.target_va ?? params.targetVa, 'target_va');
          const bias =
            params.load_bias !== undefined || params.loadBias !== undefined || params.bias !== undefined
              ? parseBigIntStrict(params.load_bias ?? params.loadBias ?? params.bias, 'load_bias', {
                  allowNegative: true,
                })
              : 0n;
          const thumbBitStripped = arch === 'arm_thumb' && (rawTargetVa & 1n) === 1n;
          const effectiveVa = thumbBitStripped ? rawTargetVa & ~1n : rawTargetVa;
          const staticVa = effectiveVa - bias;

          const matchedSec = sections.find(
            (sec) => sec.type !== 'NULL' && sec.size > 0n && sec.addr <= staticVa && staticVa < sec.addr + sec.size,
          );

          if (!matchedSec) {
            checks.va_to_file_offset = {
              valid: false,
              reason: 'va_out_of_section_bounds',
              staticVa,
              staticVaHex: formatHex(staticVa),
            };
            recordFailure(
              'va_to_file_offset',
              'va_out_of_section_bounds',
              `静态虚拟地址 ${formatHex(staticVa)} 越界：未落在任何有效节的 [addr, addr + size) 区间内`,
            );
          } else if (matchedSec.type === 'NOBITS') {
            checks.va_to_file_offset = {
              valid: false,
              reason: 'section_is_nobits',
              section: matchedSec.name,
              staticVa,
              staticVaHex: formatHex(staticVa),
            };
            recordFailure(
              'va_to_file_offset',
              'section_is_nobits',
              `静态虚拟地址 ${formatHex(staticVa)} 命中 ${matchedSec.name} 节，该节类型为 NOBITS，在磁盘文件中不占实际字节`,
            );
          } else {
            computedStaticVa = staticVa;
            computedFileOffset = matchedSec.offset + (staticVa - matchedSec.addr);
            const matchesExpected =
              expectedFileOffset === undefined ? true : computedFileOffset === expectedFileOffset;
            const delta = expectedFileOffset === undefined ? 0n : computedFileOffset - expectedFileOffset;
            checks.va_to_file_offset = {
              valid: matchesExpected,
              reason: matchesExpected ? null : 'file_offset_mismatch',
              section: matchedSec.name,
              staticVa,
              staticVaHex: formatHex(staticVa),
              fileOffset: computedFileOffset,
              fileOffsetHex: formatHex(computedFileOffset),
              thumbBitStripped,
              ...(thumbBitStripped
                ? { note: '已按 arm_thumb 模式剥离入口地址最低位 Thumb 状态标志位 (+1)' }
                : {}),
              ...(expectedFileOffset !== undefined
                ? {
                    expectedFileOffset,
                    expectedFileOffsetHex: formatHex(expectedFileOffset),
                    matchesExpected,
                    delta,
                    deltaHex: formatHex(delta),
                  }
                : {}),
            };
            if (!matchesExpected) {
              recordFailure(
                'va_to_file_offset',
                'file_offset_mismatch',
                `虚拟地址换算文件偏移不匹配：实算 ${formatHex(computedFileOffset)} !== 预期 ${formatHex(expectedFileOffset)}（差值 ${formatHex(delta)}）`,
              );
            }
          }
        }
      }
    }

    // 2. RIP 相对 32 位有符号位移闭合验算：next_rip + disp32 === expected_va
    if (hasRipCheck) {
      const nextRip = parseBigIntStrict(ripInput.next_rip ?? ripInput.nextRip, 'next_rip');
      let disp32;
      try {
        disp32 = parseDisp32BigInt(ripInput.disp32);
      } catch (err) {
        if (err?.code === 'disp32_out_of_range') {
          checks.rip_relative = { valid: false, reason: 'disp32_out_of_range' };
          recordFailure('rip_relative', 'disp32_out_of_range', err.message);
          disp32 = null;
        } else {
          throw err;
        }
      }
      if (disp32 !== null) {
        const computedVa = nextRip + disp32;
        const expectedVaRaw =
          ripInput.expected_va ??
          ripInput.expectedVa ??
          ripInput.expected_slot_va ??
          ripInput.expectedSlotVa;
        const expectedVa =
          expectedVaRaw !== undefined ? parseBigIntStrict(expectedVaRaw, 'expected_va') : computedStaticVa;
        const matchesExpected = expectedVa === undefined ? true : computedVa === expectedVa;
        const delta = expectedVa === undefined ? 0n : computedVa - expectedVa;
        checks.rip_relative = {
          valid: matchesExpected,
          reason: matchesExpected ? null : 'rip_target_mismatch',
          nextRip,
          nextRipHex: formatHex(nextRip),
          disp32,
          disp32Hex: formatHex(disp32),
          computedVa,
          computedVaHex: formatHex(computedVa),
          ...(expectedVa !== undefined
            ? {
                expectedVa,
                expectedVaHex: formatHex(expectedVa),
                matchesExpected,
                delta,
                deltaHex: formatHex(delta),
              }
            : {}),
        };
        if (!matchesExpected) {
          recordFailure(
            'rip_relative',
            'rip_target_mismatch',
            `RIP 相对寻址闭合失败：next_rip (${formatHex(nextRip)}) + disp32 (${formatHex(disp32)}) = ${formatHex(computedVa)} !== 预期 ${formatHex(expectedVa)}（差值 ${formatHex(delta)}）`,
          );
        }
      }
    }

    // 3. 线性表项步长与下标验算：base_offset + (reserved_entries + index) * stride === expected_offset
    if (hasTableCheck) {
      const baseOffset = parseBigIntStrict(
        tableInput.base_offset ?? tableInput.baseOffset,
        'base_offset',
      );
      const stride = parseBigIntStrict(tableInput.stride, 'stride', { allowNegative: true });
      const reservedEntries =
        tableInput.reserved_entries !== undefined || tableInput.reservedEntries !== undefined
          ? parseBigIntStrict(
              tableInput.reserved_entries ?? tableInput.reservedEntries,
              'reserved_entries',
              { allowNegative: true },
            )
          : 0n;
      const hasIndex = tableInput.index !== undefined;
      const index = hasIndex
        ? parseBigIntStrict(tableInput.index, 'index', { allowNegative: true })
        : undefined;
      const expectedOffsetRaw = tableInput.expected_offset ?? tableInput.expectedOffset;
      const expectedOffset =
        expectedOffsetRaw !== undefined
          ? parseBigIntStrict(expectedOffsetRaw, 'expected_offset')
          : undefined;
      const tableSizeRaw = tableInput.table_size ?? tableInput.tableSize;
      const tableSize =
        tableSizeRaw !== undefined ? parseBigIntStrict(tableSizeRaw, 'table_size') : undefined;

      if (stride <= 0n) {
        checks.table_stride = { valid: false, reason: 'invalid_stride', stride };
        recordFailure('table_stride', 'invalid_stride', `表项步长 stride 必须为正整数，当前为 ${formatHex(stride)}`);
      } else if (reservedEntries < 0n || (hasIndex && index < 0n)) {
        checks.table_stride = { valid: false, reason: 'negative_table_index', index, reservedEntries };
        recordFailure('table_stride', 'negative_table_index', '表项 index 与 reserved_entries 不能为负数');
      } else {
        let tableValid = true;
        let tableReason = null;
        let computedOffset;
        let remainder = 0n;
        let impliedTotalIndex;

        if (hasIndex) {
          const totalEntries = reservedEntries + index;
          computedOffset = baseOffset + totalEntries * stride;
          if (tableSize !== undefined && totalEntries * stride >= tableSize) {
            tableValid = false;
            tableReason = 'table_offset_out_of_bounds';
            recordFailure(
              'table_stride',
              'table_offset_out_of_bounds',
              `表项偏移越界：计算偏移 ${formatHex(computedOffset)} 超出表区间 [${formatHex(baseOffset)}, ${formatHex(baseOffset + tableSize)})`,
            );
          }
        }

        if (expectedOffset !== undefined) {
          const span = expectedOffset - baseOffset;
          if (span < 0n) {
            tableValid = false;
            tableReason ??= 'offset_before_table_base';
            recordFailure(
              'table_stride',
              'offset_before_table_base',
              `目标偏移 ${formatHex(expectedOffset)} 小于表起始偏移 base_offset ${formatHex(baseOffset)}（越界）`,
            );
          } else {
            if (tableSize !== undefined && span >= tableSize) {
              tableValid = false;
              tableReason ??= 'table_offset_out_of_bounds';
              recordFailure(
                'table_stride',
                'table_offset_out_of_bounds',
                `目标偏移 ${formatHex(expectedOffset)} 超出表大小边界 [${formatHex(baseOffset)}, ${formatHex(baseOffset + tableSize)})`,
              );
            }
            remainder = span % stride;
            if (remainder !== 0n) {
              tableValid = false;
              tableReason ??= 'stride_not_divisible';
              recordFailure(
                'table_stride',
                'stride_not_divisible',
                `表项步长不整除：(expected_offset ${formatHex(expectedOffset)} - base_offset ${formatHex(baseOffset)}) = ${formatHex(span)}，除以步长 ${formatHex(stride)} 余数为 ${formatHex(remainder)}`,
              );
            } else {
              impliedTotalIndex = span / stride;
              if (computedOffset !== undefined && computedOffset !== expectedOffset) {
                tableValid = false;
                tableReason ??= 'table_offset_mismatch';
                const delta = computedOffset - expectedOffset;
                recordFailure(
                  'table_stride',
                  'table_offset_mismatch',
                  `表项偏移算式不成立：base_offset (${formatHex(baseOffset)}) + (${reservedEntries} + ${index}) * ${formatHex(stride)} = ${formatHex(computedOffset)} !== 预期 ${formatHex(expectedOffset)}（差值 ${formatHex(delta)}）`,
                );
              }
            }
          }
        }

        checks.table_stride = {
          valid: tableValid,
          reason: tableReason,
          baseOffset,
          baseOffsetHex: formatHex(baseOffset),
          stride,
          strideHex: formatHex(stride),
          reservedEntries,
          ...(hasIndex ? { index } : {}),
          ...(computedOffset !== undefined
            ? { computedOffset, computedOffsetHex: formatHex(computedOffset) }
            : {}),
          ...(expectedOffset !== undefined
            ? {
                expectedOffset,
                expectedOffsetHex: formatHex(expectedOffset),
                remainder,
                remainderHex: formatHex(remainder),
                ...(computedOffset !== undefined ? { matchesExpected: computedOffset === expectedOffset } : {}),
                ...(impliedTotalIndex !== undefined ? { impliedTotalIndex } : {}),
              }
            : {}),
        };
      }
    }
  } catch (err) {
    recordFailure('input', 'invalid_bigint_input', err?.message ?? String(err));
  }

  const failedChecks = [...new Set(failures.map((f) => f.check))];
  const firstFailure = failures[0] ?? null;
  const vaCheck = checks.va_to_file_offset;

  return attachBigIntSafeJson({
    valid: failures.length === 0,
    ok: failures.length === 0,
    reason: firstFailure ? firstFailure.reason : null,
    ...(vaCheck?.section !== undefined ? { section: vaCheck.section } : {}),
    ...(vaCheck?.fileOffset !== undefined
      ? { fileOffset: vaCheck.fileOffset, fileOffsetHex: vaCheck.fileOffsetHex }
      : {}),
    ...(vaCheck?.matchesExpected !== undefined ? { matchesExpected: vaCheck.matchesExpected } : {}),
    ...(vaCheck?.delta !== undefined ? { delta: vaCheck.delta, deltaHex: vaCheck.deltaHex } : {}),
    failedChecks,
    failures,
    checks,
  });
}
