'use strict';

const fs = require('fs');
const path = require('path');
const {
  REQUIRED_APPLICATION_BRAND_TOKENS,
  validateThemeCssContent,
  normalizeThemeColor,
  normalizeCssColorToHex,
  extractThemeColor,
  unwrapUploadResponse,
  buildCustomThemeStyle,
} = require('../lib/app/custom-theme');

function buildBrandScale(overrides = {}) {
  return REQUIRED_APPLICATION_BRAND_TOKENS
    .map((token, index) => `    ${token}: ${overrides[token] || `rgb(${index + 1}, ${index + 2}, ${index + 3})`};`)
    .join('\n');
}

describe('custom app theme helpers', () => {
  test.each(REQUIRED_APPLICATION_BRAND_TOKENS)('requires %s in an unconditional application root', token => {
    const partial = buildBrandScale().replace(new RegExp(`\\s*${token}: [^;]+;`), '');
    for (const local of [`.page { ${token}: #123456; }`, `@media (min-width: 1px) { :root { ${token}: #123456; } }`]) {
      expect(() => validateThemeCssContent(`:root {${partial}} ${local}`))
        .toThrow(expect.objectContaining({ code: 'THEME_BRAND_SCALE_INCOMPLETE', details: { missingTokens: [token], scope: ':root' } }));
    }
  });

  test.each(['', 'initial', 'unset', 'inherit', '16px', '#xyz', 'rgb(300, 0, 0)', 'var(--missing)'])('rejects an unusable root brand value: %s', value => {
    const css = `:root {${buildBrandScale()}} :root { --color-brand1-1: ${value}; }`;
    expect(() => validateThemeCssContent(css)).toThrow(expect.objectContaining({ code: 'THEME_BRAND_SCALE_INVALID' }));
  });

  test.each([1, 2, 3, 4])('validates mobile brand-%s aliases and rejects unresolved or cyclic values', slot => {
    const token = `--color-brand-${slot}`;
    expect(() => validateThemeCssContent(`:root {${buildBrandScale({ [token]: 'var(--color-brand1-6)' })}}`)).not.toThrow();
    for (const value of ['16px', 'var(--missing)', `var(${token})`]) {
      expect(() => validateThemeCssContent(`:root {${buildBrandScale({ [token]: value })}}`))
        .toThrow(expect.objectContaining({
          code: 'THEME_BRAND_SCALE_INVALID',
          details: expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ token })]) }),
        }));
    }
  });

  test('checks variable cycles including unused fallbacks, and follows valid root aliases', () => {
    for (const value of ['var(--color-brand1-1)', 'var(--alias)', 'var(--color-brand1-6, var(--color-brand1-1))']) {
      const css = `:root {${buildBrandScale({ '--color-brand1-1': value })} --alias: var(--color-brand1-1);}`;
      expect(() => validateThemeCssContent(css)).toThrow(expect.objectContaining({
        code: 'THEME_BRAND_SCALE_INVALID', details: expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ token: '--color-brand1-1', reason: 'TOKEN_REFERENCE_CYCLE' })]),
        }),
      }));
    }
    expect(() => validateThemeCssContent(`:root {${buildBrandScale({ '--color-brand1-1': 'var(--alias)' })}}
      :root { --alias: var(--missing, #123456); }
    `)).not.toThrow();
  });

  test('uses the effective root primary for persistence, respecting order and importance', () => {
    const css = `:root {${buildBrandScale({ '--color-brand1-6': '#123456 !important' })}}
      .page { --color-brand1-6: #999999; }
      :root { --color-brand1-6: #654321; }
    `;
    expect(() => validateThemeCssContent(css)).not.toThrow();
    expect(extractThemeColor(css)).toBe('#123456');
    expect(extractThemeColor(css.replace(' !important', ''))).toBe('#654321');
    expect(() => validateThemeCssContent(css + ':root { --color-brand1-6: 12px !important; }'))
      .toThrow(expect.objectContaining({ code: 'THEME_BRAND_SCALE_INVALID' }));
  });

  test('does not treat CSS strings, local rules, or differently cased names as global brand declarations', () => {
    const partial = buildBrandScale().replace(/\s*--color-brand1-1: [^;]+;/, '');
    expect(() => validateThemeCssContent(`:root {${partial} --COLOR-brand1-1: #123456;}
      .page::before { content: ':root { --color-brand1-1: #123456; }'; }
    `)).toThrow(expect.objectContaining({ code: 'THEME_BRAND_SCALE_INCOMPLETE' }));
  });

  test.each([
    '{{PRIMARY_COLOR}}',
    '<生成实际色值：--color-brand1-6 88% + #FFFFFF 12%，sRGB 逐通道混合>',
  ])('rejects unresolved color %s even when all brand tokens exist', value => {
    expect(() => validateThemeCssContent(`:root {${buildBrandScale({ '--color-brand1-1': value })}}`))
      .toThrow(expect.objectContaining({
        code: 'THEME_CSS_UNRESOLVED_TOKEN',
        details: { token: '--color-brand1-1', value },
      }));
  });

  test('allows resolved CSS colors and authoring guidance in comments', () => {
    expect(() => validateThemeCssContent(`/* {{PRIMARY_COLOR}} <生成实际色值：...> */
      :root {${buildBrandScale({ '--color-brand1-1': 'color-mix(in srgb, var(--color-brand1-6) 88%, white)' })}}
    `)).not.toThrow();
  });

  test.each([
    ['unclosed root', css => css.slice(0, -1)],
    ['extra closing brace', css => css + '}'],
    ['unclosed function', css => css + '\n.panel { color: var(--color-brand1-6; }'],
    ['unclosed comment', css => css + '\n/* comment'],
    ['unclosed string', css => css + '\n.panel { content: "open; }'],
  ])('rejects %s before theme generation or upload', (_label, mutate) => {
    const css = mutate(`:root {\n${buildBrandScale()}\n}`);
    expect(() => validateThemeCssContent(css)).toThrow(expect.objectContaining({
      code: 'THEME_CSS_STRUCTURE_INVALID',
      details: expect.objectContaining({ line: expect.any(Number) }),
    }));
  });

  test('allows literal braces, escapes and nested media rules', () => {
    const css = `:root {\n${buildBrandScale()}\n}
      /* unmatched literal { in a closed comment */
      .panel::before { content: "}"; }
      .escaped\\{ { color: var(--color-brand1-6, #123456); }
      @media (max-width: 768px) { .panel { padding: calc(4px + 1vw); } }
    `;
    expect(() => validateThemeCssContent(css)).not.toThrow();
  });

  test('accepts the modern theme template token patterns', () => {
    expect(() => validateThemeCssContent(`
      :root {
${buildBrandScale({ '--color-brand1-6': '#1677FF' })}
        --pod-shell-bg-color-light: var(--color-brand1-2, #F2F7FF);
      }
      .hero { background-image: url(https://cdn.example.com/theme.png); }
    `)).not.toThrow();
  });

  test('accepts the shipped coffee theme template without URL placeholders', () => {
    const templatePath = path.join(
      __dirname,
      '../yida-skills/skills/yida-design/references/theme/app-custom-theme-template.css'
    );
    const css = fs.readFileSync(templatePath, 'utf8');

    expect(() => validateThemeCssContent(css)).not.toThrow();
    expect(extractThemeColor(css)).toBe('rgba(155, 136, 121, 1)');
    expect(css).not.toContain('文字模板资源');
    expect(css).not.toMatch(/url\s*\(/i);
  });

  test('requires the complete platform --color-brand1 scale', () => {
    expect(() => validateThemeCssContent(`
      :root {
        ${buildBrandScale().replace('    --color-brand1-5: rgb(4, 5, 6);', '')}
      }
    `)).toThrow('缺少: --color-brand1-5');

    expect(() => validateThemeCssContent(`
      /* --color-brand1-5: #123456; */
      :root {
        ${buildBrandScale().replace('    --color-brand1-5: rgb(4, 5, 6);', '')}
      }
    `)).toThrow('缺少: --color-brand1-5');
  });

  test('extracts the app theme color from --color-brand1-6', () => {
    expect(extractThemeColor(`
      /* --color-brand1-6: #000000; */
      :root { --color-brand1-6: #8f66ff; }
    `)).toBe('#8F66FF');
    expect(extractThemeColor(':root { --color-brand1-6: rgb(12, 34, 56); }'))
      .toBe('rgb(12, 34, 56)');
    expect(normalizeThemeColor('hsl(220, 80%, 50%)')).toBe('hsl(220, 80%, 50%)');
  });

  test('requires --color-brand1-6 to be a literal supported color', () => {
    expect(() => extractThemeColor(':root { --color-brand1-5: #1677FF; }'))
      .toThrow('--color-brand1-6');
    expect(() => extractThemeColor(':root { --color-brand1-6: var(--brand); }'))
      .toThrow('可直接保存的颜色值');
    expect(() => normalizeThemeColor('rgb(300, 0, 0)')).toThrow('Unsupported theme color');
  });

  test('normalizes the custom brand color to the appIcon hex contract', () => {
    expect(normalizeCssColorToHex('#abc')).toBe('#AABBCC');
    expect(normalizeCssColorToHex('rgb(22, 119, 255)')).toBe('#1677FF');
    expect(normalizeCssColorToHex('rgba(0, 0, 0, 0.5)')).toBe('#808080');
    expect(normalizeCssColorToHex('hsl(0, 100%, 50%)')).toBe('#FF0000');
    expect(normalizeCssColorToHex('hsla(120, 100%, 25%, 50%)')).toBe('#80BF80');
  });

  test('rejects CSS constructs rejected by the custom theme endpoint', () => {
    expect(() => validateThemeCssContent(`
      /* @import "https://example.com/base.css"; .x { background: url(文字模板资源); } */
      :root { ${buildBrandScale()} }
    `)).not.toThrow();
    expect(() => validateThemeCssContent('@import "https://example.com/base.css";')).toThrow('@import');
    expect(() => validateThemeCssContent('.x { background: url(javascript:alert(1)); }')).toThrow('危险资源协议');
    expect(() => validateThemeCssContent('.x { background: url(//evil.example.com/theme.png); }')).toThrow('不安全');
    expect(() => validateThemeCssContent('.x { width: expression(alert(1)); }')).toThrow('expression');
  });

  test('normalizes wrapped upload results into the updateApp contract', () => {
    const response = {
      content: {
        success: true,
        content: {
          name: 'app-theme.css',
          url: '/download/app-theme.css',
          downloadUrl: 'https://cdn.example.com/app-theme.css',
        },
      },
    };
    expect(unwrapUploadResponse(response)).toMatchObject({ name: 'app-theme.css' });
    expect(JSON.parse(buildCustomThemeStyle(response))).toEqual({
      enabled: true,
      iframePropagation: false,
      cssUrl: 'https://cdn.example.com/app-theme.css',
      cssFileName: 'app-theme.css',
    });
  });
});
