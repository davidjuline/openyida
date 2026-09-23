'use strict';

/**
 * fix-theme.js - Canvas 主题迁移 codemod（纯函数）
 *
 * 把写死在 antd `ConfigProvider` 里的品牌交互色覆盖（如 `colorPrimary: '#1677ff'`）
 * 从源码中移除，交由外层应用主题（CanvasThemeProvider / 平台主题）解析。这是
 * "un-pin" 迁移：移除硬编码覆盖后，品牌色由应用主题接管，正好满足主题守卫
 * `OPENYIDA_CANVAS_THEME_FIXED_BRAND` 的要求。
 *
 * 本模块不做任何 IO，只接收源码字符串、返回改写后的源码，便于单测与复用。
 */

const { collectFixedBrandViolations } = require('./canvas-theme-guard');

/**
 * 计算某个对象属性的删除区间：优先连同其后的逗号一起删；若是最后一个属性，
 * 则回退删除其前的逗号。属性独占一行时顺带清理该行缩进与换行，避免留下空行。
 * @param {string} source
 * @param {number} start - 属性节点起始偏移
 * @param {number} end - 属性节点结束偏移
 * @returns {{ start: number, end: number }}
 */
function expandRemovalSpan(source, start, end) {
  let removeStart = start;
  let removeEnd = end;
  const trailing = source.slice(removeEnd).match(/^[ \t]*,/);
  if (trailing) {
    removeEnd += trailing[0].length;
    const lineStart = source.lastIndexOf('\n', removeStart - 1) + 1;
    const indent = source.slice(lineStart, removeStart);
    if (/^[ \t]*$/.test(indent)) {
      removeStart = lineStart;
      const newline = source.slice(removeEnd).match(/^[ \t]*\r?\n/);
      if (newline) { removeEnd += newline[0].length; }
    }
    return { start: removeStart, end: removeEnd };
  }
  // Last property in its object: drop the preceding comma instead.
  const leading = source.slice(0, removeStart).match(/,[ \t\r\n]*$/);
  if (leading) { removeStart -= leading[0].length; }
  return { start: removeStart, end: removeEnd };
}

/**
 * 移除源码中写死的品牌色覆盖。改写按偏移从后往前应用，避免前面的偏移失效。
 * @param {string} source - canvas 源码
 * @returns {{ changed: boolean, output: string, violations: Array<{field:string,color:string,line:number}> }}
 */
function transformFixedBrandTheme(source) {
  const violations = collectFixedBrandViolations(source)
    .filter(item => Number.isInteger(item.start) && Number.isInteger(item.end) && item.end > item.start);
  if (!violations.length) {
    return { changed: false, output: source, violations: [] };
  }
  const spans = violations
    .map(item => expandRemovalSpan(source, item.start, item.end))
    .sort((a, b) => a.start - b.start);

  // Adjacent overrides can claim the same separating comma (one as trailing,
  // the next as leading), so merge overlapping spans instead of dropping one.
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) { last.end = Math.max(last.end, span.end); }
    else { merged.push({ ...span }); }
  }

  let output = source;
  // Apply from the back so earlier offsets stay valid.
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    output = output.slice(0, merged[i].start) + output.slice(merged[i].end);
  }

  return {
    changed: output !== source,
    output,
    violations: violations.map(({ field, color, line }) => ({ field, color, line })),
  };
}

module.exports = { transformFixedBrandTheme, expandRemovalSpan };
