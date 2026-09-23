'use strict';

const Babel = require('@babel/standalone');
const { transformFixedBrandTheme, expandRemovalSpan } = require('../lib/app/fix-theme');
const { assertCanvasThemeStructure } = require('../lib/app/canvas-theme-guard');

// Reparse the migrated output; a codemod that emits broken syntax is a bug.
function parses(source) {
  Babel.packages.parser.parse(source, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  return true;
}

const wrap = theme =>
  `import {ConfigProvider} from 'antd'; function YidaComp(){return <ConfigProvider theme={${theme}}><div/></ConfigProvider>}`;

test('removes a fixed brand token so the guard stops rejecting it', () => {
  const source = wrap("{token:{colorPrimary:'#1677ff'}}");
  const result = transformFixedBrandTheme(source);
  expect(result.changed).toBe(true);
  expect(result.output).not.toContain('#1677ff');
  expect(parses(result.output)).toBe(true);
  expect(() => assertCanvasThemeStructure(result.output)).not.toThrow();
});

test('reports the violations it migrated without leaking char offsets', () => {
  const result = transformFixedBrandTheme(wrap("{token:{colorPrimary:'#1677ff'}}"));
  expect(result.violations).toEqual([
    { field: 'colorPrimary', color: '#1677ff', line: expect.any(Number) },
  ]);
});

test('removes every fixed override across token and nested components', () => {
  const source = wrap("{token:{colorPrimary:'#1677ff'},components:{Tabs:{itemSelectedColor:'#1677ff',inkBarColor:'#1677ff'}}}");
  const result = transformFixedBrandTheme(source);
  expect(result.changed).toBe(true);
  expect(result.output).not.toContain('#1677ff');
  expect(result.violations).toHaveLength(3);
  expect(parses(result.output)).toBe(true);
  expect(() => assertCanvasThemeStructure(result.output)).not.toThrow();
});

test('strips a fixed override but keeps sibling semantic and layout tokens', () => {
  const source = wrap("{token:{colorPrimary:'#1677ff',colorError:'#ff0000',borderRadius:12}}");
  const result = transformFixedBrandTheme(source);
  expect(result.changed).toBe(true);
  expect(result.output).not.toContain('#1677ff');
  expect(result.output).toContain("colorError:'#ff0000'");
  expect(result.output).toContain('borderRadius:12');
  expect(parses(result.output)).toBe(true);
});

test.each([
  "{token:{colorError:'#ff0000',borderRadius:12}}",
  '{token:window.resolvedTheme}',
  '{components:{Tabs:{itemSelectedColor:window.resolvedTheme.colorPrimary}}}',
])('leaves semantic and dynamic themes untouched: %s', theme => {
  const source = wrap(theme);
  const result = transformFixedBrandTheme(source);
  expect(result.changed).toBe(false);
  expect(result.output).toBe(source);
  expect(result.violations).toEqual([]);
});

test('is a no-op on sources without antd theme markers', () => {
  const source = 'function YidaComp(){ return <div>官网</div>; }';
  expect(transformFixedBrandTheme(source)).toEqual({ changed: false, output: source, violations: [] });
});

test('drops a preceding comma when the fixed override is the last property', () => {
  const source = wrap("{token:{borderRadius:12,colorPrimary:'#1677ff'}}");
  const result = transformFixedBrandTheme(source);
  expect(result.changed).toBe(true);
  expect(result.output).toContain('borderRadius:12');
  expect(result.output).not.toContain('#1677ff');
  expect(parses(result.output)).toBe(true);
});

test('expandRemovalSpan clears the whole line when a property stands alone', () => {
  const source = 'const theme = {\n  colorPrimary: "#1677ff",\n  borderRadius: 12,\n};\n';
  const start = source.indexOf('colorPrimary');
  const end = source.indexOf('"#1677ff"') + '"#1677ff"'.length;
  const span = expandRemovalSpan(source, start, end);
  const output = source.slice(0, span.start) + source.slice(span.end);
  expect(output).toBe('const theme = {\n  borderRadius: 12,\n};\n');
});
