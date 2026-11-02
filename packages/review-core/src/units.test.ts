import { parseUnifiedDiff } from '@reviewlens/github';
import { describe, expect, it } from 'vitest';
import { configHash, PRESETS } from './config.js';
import { buildContext, isReviewable } from './context.js';
import { findDuplicates, jaccard } from './dedupe.js';
import { CART_TS_HEAD, comment, SAMPLE_DIFF } from './fixtures.js';
import { loadPrompt, renderTemplate } from './prompts.js';
import { scrubSecrets } from './scrub.js';
import { TokenBudget } from './tokens.js';
import { DiffIndex, normalizeEvidence } from './validate.js';

const files = parseUnifiedDiff(SAMPLE_DIFF).filter(isReviewable);
const heads = new Map([['src/cart.ts', CART_TS_HEAD]]);

describe('config', () => {
  it('hashes configs by value and changes with any field', () => {
    expect(configHash(PRESETS.S0)).toBe(configHash({ ...PRESETS.S0 }));
    expect(configHash(PRESETS.S0)).not.toBe(configHash(PRESETS.S1));
    expect(configHash(PRESETS.S0)).not.toBe(configHash({ ...PRESETS.S0, maxComments: 3 }));
  });
});

describe('TokenBudget', () => {
  it('takes whole pieces only', () => {
    const b = new TokenBudget(10);
    expect(b.tryTake(6)).toBe(true);
    expect(b.tryTake(5)).toBe(false);
    expect(b.tryTake(4)).toBe(true);
    expect(b.remaining).toBe(0);
  });
});

describe('buildContext', () => {
  it('drops ignored files and keeps diff order', () => {
    expect(files.map((f) => f.newPath)).toEqual(['src/cart.ts']);
  });

  it('S1 adds full files only from budget the diff left over', () => {
    const roomy = buildContext('S1', { files, headContents: heads }, 100_000);
    expect(roomy.sections.map((s) => s.kind)).toEqual(['diff', 'file']);

    const diffTokens = roomy.sections[0]!.tokens;
    const tight = buildContext('S1', { files, headContents: heads }, diffTokens);
    expect(tight.sections.map((s) => s.kind)).toEqual(['diff']);
    expect(tight.stats.fullFiles.omitted).toEqual(['src/cart.ts']);
    expect(tight.stats.estimatedTokens).toBeLessThanOrEqual(diffTokens);
  });

  it('records files whose head content is unavailable', () => {
    const ctx = buildContext('S1', { files, headContents: new Map() }, 100_000);
    expect(ctx.stats.fullFiles).toEqual({ included: [], omitted: ['src/cart.ts'] });
  });
});

describe('DiffIndex.validate', () => {
  const index = new DiffIndex(files, heads);

  it('accepts added and context lines with real evidence', () => {
    expect(index.validate(comment())).toBeNull();
    expect(index.validate(comment({ line: 7, evidence: 'let sum = 0;' }))).toBeNull();
  });

  it('accepts evidence the model decorated with labels, markers or backticks', () => {
    expect(
      index.validate(comment({ evidence: '     R8 +  for (let i = 0; i <= items.length; i++) {' })),
    ).toBeNull();
    expect(index.validate(comment({ evidence: '`i <= items.length`' }))).toBeNull();
    expect(
      index.validate(
        comment({ evidence: '```ts\nfor (let i = 0;\n  i <= items.length; i++) {\n```' }),
      ),
    ).toBeNull();
  });

  it('accepts evidence quoting removed code', () => {
    expect(
      index.validate(comment({ line: 15, evidence: 'return sum - (sum * pct) / 100;' })),
    ).toBeNull();
  });

  it('rejects lines outside hunks and unknown evidence', () => {
    expect(index.validate(comment({ line: 2 }))).toBe('line_not_in_diff');
    expect(index.validate(comment({ evidence: 'items.forEach(' }))).toBe('evidence_not_found');
    expect(index.validate(comment({ evidence: ' ' }))).toBe('evidence_not_found');
    expect(index.validate(comment({ confidence: 1.5 }))).toBe('confidence_out_of_range');
    expect(index.validate(comment({ claim: '  ' }))).toBe('empty_claim');
  });

  it('normalizes ./ and a/ b/ path prefixes', () => {
    expect(index.validate(comment({ file: './src/cart.ts' }))).toBeNull();
    expect(index.validate(comment({ file: 'b/src/cart.ts' }))).toBeNull();
  });

  it('normalizeEvidence strips file-line prefixes too', () => {
    expect(normalizeEvidence(' 8| for (x) {')).toBe('for (x) {');
  });
});

describe('findDuplicates', () => {
  it('keeps the higher-priority comment of a near-duplicate pair', () => {
    const dups = findDuplicates([
      comment({ severity: 'low', claim: 'off by one in loop bound' }),
      comment({ severity: 'high', line: 9, claim: 'loop bound off by one' }),
      comment({ line: 20, claim: 'off by one in loop bound' }), // too far away
      comment({ file: 'x.ts', claim: 'off by one in loop bound' }), // other file
    ]);
    expect(dups).toEqual([1, null, null, null]);
  });

  it('treats same line and category as duplicates regardless of wording', () => {
    expect(findDuplicates([comment({ claim: 'a b c' }), comment({ claim: 'x y z' })])).toEqual([
      null,
      0,
    ]);
  });

  it('jaccard handles empty sets', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

describe('scrubSecrets', () => {
  it.each([
    ['ghp_' + 'a'.repeat(36), 'github-token'],
    ['sk-ant-api03-' + 'x'.repeat(30), 'anthropic-key'],
    ['xoxb-1234567890-abcdef', 'slack-token'], // gitleaks:allow: synthetic fixture
    ['AIza' + 'b'.repeat(35), 'google-api-key'],
  ])('redacts %s', (secret, name) => {
    const out = scrubSecrets(`const t = "${secret}";`);
    expect(out.text).toBe(`const t = "[REDACTED:${name}]";`);
  });

  it('redacts assigned secrets but keeps the key name', () => {
    expect(scrubSecrets(`DB_PASSWORD = "hunter2hunter2"`).text).toBe(
      'DB_PASSWORD = "[REDACTED:assigned-secret]"',
    );
    expect(scrubSecrets(`apiKey: 'abcdefgh12345'`).text).toBe(
      "apiKey: '[REDACTED:assigned-secret]'",
    );
  });

  it('redacts URL passwords', () => {
    expect(scrubSecrets('postgres://admin:' + 's3cretpw' + '@db:5432/x').text).toBe(
      'postgres://admin:[REDACTED:url-credentials]@db:5432/x', // gitleaks:allow: synthetic fixture
    );
  });

  it('blanks private keys without changing the line count', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nDEFghi\n-----END RSA PRIVATE KEY-----'; // gitleaks:allow: synthetic fixture
    const out = scrubSecrets(`a\n${pem}\nb`);
    expect(out.text.split('\n')).toHaveLength(`a\n${pem}\nb`.split('\n').length);
    expect(out.text).not.toContain('MIIabc');
    expect(out.redactions).toEqual({ 'private-key': 1 });
  });

  it('leaves ordinary code alone', () => {
    const code = 'const password = getPassword();\nconst token = req.headers.authorization;';
    expect(scrubSecrets(code)).toEqual({ text: code, redactions: {} });
  });
});

describe('prompts', () => {
  it('loads a versioned prompt with a content hash', async () => {
    const p = await loadPrompt('review/v1');
    expect(p.system).toContain('R<number>');
    expect(p.user).toContain('{{context}}');
    expect(p.contentHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('rejects malformed versions', () => {
    expect(() => loadPrompt('../secrets')).toThrow('invalid prompt version');
  });

  it('renders templates strictly and does not expand placeholders inside values', () => {
    expect(renderTemplate('a {{x}} b', { x: '{{y}}' })).toBe('a {{y}} b');
    expect(() => renderTemplate('{{x}}', {})).toThrow('not provided');
    expect(() => renderTemplate('x', { y: '1' })).toThrow('not used');
  });
});
