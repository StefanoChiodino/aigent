import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchDestructive, detectDestructiveSteps, validateBrowserUrls } from './browser-safety.js';

describe('matchDestructive', () => {
  it('matches destructive keywords', () => {
    assert.equal(matchDestructive('Submit Order'), 'submit');
    assert.equal(matchDestructive('Delete Account'), 'delete');
    assert.equal(matchDestructive('Purchase Now'), 'purchase');
    assert.equal(matchDestructive('Click to Pay'), 'pay');
    assert.equal(matchDestructive('Deploy to Production'), 'deploy');
  });

  it('is case-insensitive', () => {
    assert.equal(matchDestructive('SUBMIT'), 'submit');
    assert.equal(matchDestructive('Delete'), 'delete');
    assert.equal(matchDestructive('BUY'), 'buy');
  });

  it('matches word boundaries only', () => {
    assert.equal(matchDestructive('Submitted'), null); // "submit" + "ted" — \b fails
    // "post" inside "postpone" should not match — but \bpost\b does match "post" as a word
    assert.equal(matchDestructive('postpone'), null);
    assert.equal(matchDestructive('repost'), null);
  });

  it('returns null for safe text', () => {
    assert.equal(matchDestructive('Read more'), null);
    assert.equal(matchDestructive('Save draft'), null);
    assert.equal(matchDestructive('Cancel'), null);
    assert.equal(matchDestructive('Edit profile'), null);
  });
});

describe('detectDestructiveSteps', () => {
  it('detects click by text with destructive label', () => {
    const matches = detectDestructiveSteps('run_script', [
      { click: 'Submit Order', by: 'text' },
    ]);
    assert.ok(matches.length > 0);
    assert.ok(matches[0]!.includes('submit'));
  });

  it('detects click by aria with destructive label', () => {
    const matches = detectDestructiveSteps('run_script', [
      { click: 'Delete Account', by: 'aria' },
    ]);
    assert.ok(matches.length > 0);
    assert.ok(matches[0]!.includes('delete'));
  });

  it('detects css selector with embedded label', () => {
    const matches = detectDestructiveSteps('run_script', [
      { click: '[aria-label="Delete"]' },
    ]);
    assert.ok(matches.length > 0);
    assert.ok(matches[0]!.includes('delete'));
  });

  it('detects [type=submit] in css selectors', () => {
    const matches = detectDestructiveSteps('run_script', [
      { click: 'button[type=submit]' },
    ]);
    assert.ok(matches.length > 0);
    assert.ok(matches.some(m => m.includes('submit')));
  });

  it('detects destructive navigate URL', () => {
    const matches = detectDestructiveSteps('navigate', undefined, 'https://example.com/account/delete');
    assert.ok(matches.length > 0);
    assert.ok(matches[0]!.includes('delete'));
  });

  it('detects destructive navigate step within run_script', () => {
    const matches = detectDestructiveSteps('run_script', [
      { navigate: 'https://example.com/api/remove-user' },
    ]);
    assert.ok(matches.length > 0);
    assert.ok(matches[0]!.includes('remove'));
  });

  it('returns empty for safe steps', () => {
    const matches = detectDestructiveSteps('run_script', [
      { click: '#search-btn', by: 'css' },
      { fill: '#email', value: 'test@test.com' },
      { click: 'Read More', by: 'text' },
    ]);
    assert.equal(matches.length, 0);
  });

  it('returns empty for non-write actions', () => {
    const matches = detectDestructiveSteps('extract_a11y');
    assert.equal(matches.length, 0);
  });

  it('handles missing steps gracefully', () => {
    const matches = detectDestructiveSteps('run_script');
    assert.equal(matches.length, 0);
  });

  it('finds multiple destructive steps in one script', () => {
    const matches = detectDestructiveSteps('run_script', [
      { click: 'Delete', by: 'text' },
      { click: 'Confirm', by: 'text' },
    ]);
    assert.equal(matches.length, 2);
  });
});

describe('validateBrowserUrls', () => {
  it('blocks navigate to localhost', () => {
    const err = validateBrowserUrls('navigate', undefined, 'http://localhost:3141/admin');
    assert.ok(err !== null);
    assert.ok(err.includes('localhost'));
  });

  it('blocks navigate to private IP', () => {
    const err = validateBrowserUrls('navigate', undefined, 'http://192.168.1.1/router');
    assert.ok(err !== null);
  });

  it('blocks open_tab to metadata endpoint', () => {
    const err = validateBrowserUrls('open_tab', undefined, 'http://169.254.169.254/latest/meta-data/');
    assert.ok(err !== null);
  });

  it('blocks navigate step within run_script', () => {
    const err = validateBrowserUrls('run_script', [
      { navigate: 'http://127.0.0.1:8080/admin' },
    ]);
    assert.ok(err !== null);
    assert.ok(err.includes('Step navigate blocked'));
  });

  it('allows navigate to public URLs', () => {
    const err = validateBrowserUrls('navigate', undefined, 'https://example.com/page');
    assert.equal(err, null);
  });

  it('allows open_tab to public URLs', () => {
    const err = validateBrowserUrls('open_tab', undefined, 'https://github.com');
    assert.equal(err, null);
  });

  it('allows run_script with no navigate steps', () => {
    const err = validateBrowserUrls('run_script', [
      { click: '#btn' },
      { fill: '#input', value: 'test' },
    ]);
    assert.equal(err, null);
  });

  it('allows run_script with safe navigate steps', () => {
    const err = validateBrowserUrls('run_script', [
      { navigate: 'https://example.com/checkout' },
    ]);
    assert.equal(err, null);
  });

  it('does not check URLs for non-navigate actions', () => {
    const err = validateBrowserUrls('close_tab', undefined, 'http://localhost:3141');
    assert.equal(err, null);
  });

  it('handles missing steps and url', () => {
    const err = validateBrowserUrls('run_script');
    assert.equal(err, null);
  });
});
