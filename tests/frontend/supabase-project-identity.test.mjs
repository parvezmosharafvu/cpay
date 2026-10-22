import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fromRepo = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const expectedCpayRef = 'riumaeihemgznvgattoc';

export function projectRefs(cliConfig, publicConfig) {
  const cli = cliConfig.match(/^project_id\s*=\s*["']([a-z0-9]+)["']\s*$/m);
  const web = publicConfig.match(/^window\.SUPABASE_URL\s*=\s*["'](https:\/\/[a-z0-9]+\.supabase\.co)["']\s*;/m);
  if (!cli || !web) return null;
  const url = new URL(web[1]);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  return { cli: cli[1], browser: url.hostname.split('.')[0] };
}

test('public client and Supabase CLI config point at the reviewed CPAY project', () => {
  const refs = projectRefs(fromRepo('supabase/config.toml'), fromRepo('public/config.js'));
  assert.ok(refs, 'both project references must be present and valid');
  assert.equal(refs.cli, expectedCpayRef);
  assert.equal(refs.browser, expectedCpayRef);
});

test('project reference drift is detectable without connecting to production', () => {
  const cli = 'project_id = "riumaeihemgznvgattoc"';
  const browser = "window.SUPABASE_URL = 'https://differentproject.supabase.co';";
  const refs = projectRefs(cli, browser);
  assert.ok(refs);
  assert.notEqual(refs.cli, refs.browser);
  assert.equal(projectRefs(cli, "window.SUPABASE_URL = 'http://differentproject.supabase.co';"), null);
});
