/**
 * Unit tests for browser permission functions in src/safety.ts.
 * Tests classifyBrowserAction, checkBrowserPermission, and browserTierSufficient.
 * Run with: node --import tsx/esm --test src/browser-perms.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBrowserAction,
  checkBrowserPermission,
  browserTierSufficient,
  type BrowserPermissions,
} from './safety.js';

// ---------------------------------------------------------------------------
// classifyBrowserAction
// ---------------------------------------------------------------------------

describe('classifyBrowserAction', () => {
  // -- Read actions --

  it('classifies extract_a11y as read', () => {
    assert.equal(classifyBrowserAction('extract_a11y'), 'read');
  });

  it('classifies screenshot as read', () => {
    assert.equal(classifyBrowserAction('screenshot'), 'read');
  });

  it('classifies list_tabs as read', () => {
    assert.equal(classifyBrowserAction('list_tabs'), 'read');
  });

  it('classifies activate_tab as read', () => {
    assert.equal(classifyBrowserAction('activate_tab'), 'read');
  });

  // -- Write actions --

  it('classifies navigate as write', () => {
    assert.equal(classifyBrowserAction('navigate'), 'write');
  });

  it('classifies open_tab as write', () => {
    assert.equal(classifyBrowserAction('open_tab'), 'write');
  });

  it('classifies close_tab as write', () => {
    assert.equal(classifyBrowserAction('close_tab'), 'write');
  });

  // -- run_script with structured steps (should be 'write') --

  it('classifies run_script with structured steps as write', () => {
    const steps = [
      { click: '#btn', by: 'css' },
      { fill: '#input', value: 'hello' },
    ];
    assert.equal(classifyBrowserAction('run_script', steps), 'write');
  });

  it('classifies run_script with navigate step as write', () => {
    const steps = [{ navigate: 'https://example.com' }];
    assert.equal(classifyBrowserAction('run_script', steps), 'write');
  });

  it('classifies run_script with scroll step as write', () => {
    const steps = [{ scroll: 'down', amount: 500 }];
    assert.equal(classifyBrowserAction('run_script', steps), 'write');
  });

  it('classifies run_script with hover and pressKey steps as write', () => {
    const steps = [
      { hover: '#menu' },
      { pressKey: 'Enter', key: 'Enter' },
    ];
    assert.equal(classifyBrowserAction('run_script', steps), 'write');
  });

  it('classifies run_script with wait/waitFor as write', () => {
    const steps = [
      { wait: 1000, timeout: 5000 },
      { waitFor: '#loaded' },
    ];
    assert.equal(classifyBrowserAction('run_script', steps), 'write');
  });

  it('classifies run_script with select/check/clear as write', () => {
    const steps = [
      { select: '#dropdown', value: 'option1' },
      { check: '#checkbox' },
      { clear: '#input' },
    ];
    assert.equal(classifyBrowserAction('run_script', steps), 'write');
  });

  it('classifies run_script with extractA11y/screenshot steps as write', () => {
    const steps = [
      { extractA11y: true },
      { screenshot: true },
    ];
    assert.equal(classifyBrowserAction('run_script', steps), 'write');
  });

  // -- run_script with unrecognized step keys (should be 'script') --

  it('classifies run_script with unrecognized step key as script', () => {
    const steps = [{ executeJS: 'document.title' }];
    assert.equal(classifyBrowserAction('run_script', steps), 'script');
  });

  it('classifies run_script with mix of recognized and unrecognized keys as script', () => {
    const steps = [
      { click: '#btn', by: 'css' },
      { customAction: 'something' },
    ];
    assert.equal(classifyBrowserAction('run_script', steps), 'script');
  });

  it('classifies run_script with non-object step as script', () => {
    const steps = ['click #btn'];
    assert.equal(classifyBrowserAction('run_script', steps), 'script');
  });

  it('classifies run_script with null step as script', () => {
    const steps = [null];
    assert.equal(classifyBrowserAction('run_script', steps), 'script');
  });

  it('classifies run_script with step having only param keys as script', () => {
    // A step with only parameter keys (by, value, timeout) but no action key
    const steps = [{ by: 'css', value: 'test' }];
    assert.equal(classifyBrowserAction('run_script', steps), 'script');
  });

  // -- run_script with no steps (should be 'script') --

  it('classifies run_script with no steps as script', () => {
    assert.equal(classifyBrowserAction('run_script'), 'script');
  });

  it('classifies run_script with undefined steps as script', () => {
    assert.equal(classifyBrowserAction('run_script', undefined), 'script');
  });

  it('classifies run_script with empty array as script', () => {
    assert.equal(classifyBrowserAction('run_script', []), 'script');
  });

  // -- Unknown action --

  it('classifies unknown action as script', () => {
    assert.equal(classifyBrowserAction('unknown_action'), 'script');
  });
});

// ---------------------------------------------------------------------------
// checkBrowserPermission
// ---------------------------------------------------------------------------

describe('checkBrowserPermission', () => {
  it('deny wins over everything', () => {
    const perms: BrowserPermissions = {
      read: ['example.com'],
      write: ['example.com'],
      script: ['example.com'],
      deny: ['example.com'],
    };
    assert.equal(checkBrowserPermission('https://example.com/page', perms), 'deny');
  });

  it('script tier matches when domain is in script list', () => {
    const perms: BrowserPermissions = {
      read: [],
      write: [],
      script: ['example.com'],
      deny: [],
    };
    assert.equal(checkBrowserPermission('https://example.com/page', perms), 'script');
  });

  it('write tier matches when domain is in write list', () => {
    const perms: BrowserPermissions = {
      read: [],
      write: ['example.com'],
      script: [],
      deny: [],
    };
    assert.equal(checkBrowserPermission('https://example.com/page', perms), 'write');
  });

  it('read tier matches when domain is in read list', () => {
    const perms: BrowserPermissions = {
      read: ['example.com'],
      write: [],
      script: [],
      deny: [],
    };
    assert.equal(checkBrowserPermission('https://example.com/page', perms), 'read');
  });

  it('hostname matching works correctly', () => {
    const perms: BrowserPermissions = {
      read: ['api.github.com'],
      write: [],
      script: [],
      deny: [],
    };
    assert.equal(checkBrowserPermission('https://api.github.com/repos', perms), 'read');
    // Different hostname should not match
    assert.equal(checkBrowserPermission('https://github.com/repos', perms), 'prompt');
  });

  it('wildcard matching works correctly', () => {
    const perms: BrowserPermissions = {
      read: [],
      write: ['*.example.com'],
      script: [],
      deny: [],
    };
    assert.equal(checkBrowserPermission('https://app.example.com/page', perms), 'write');
    assert.equal(checkBrowserPermission('https://api.example.com/data', perms), 'write');
    // Bare domain does not match *.example.com
    assert.equal(checkBrowserPermission('https://example.com/page', perms), 'prompt');
  });

  it('returns prompt for unknown domains', () => {
    const perms: BrowserPermissions = {
      read: ['known.com'],
      write: [],
      script: [],
      deny: [],
    };
    assert.equal(checkBrowserPermission('https://unknown.com/page', perms), 'prompt');
  });

  it('returns prompt for invalid URL', () => {
    const perms: BrowserPermissions = {
      read: ['example.com'],
      write: [],
      script: [],
      deny: [],
    };
    assert.equal(checkBrowserPermission('not-a-valid-url', perms), 'prompt');
  });

  it('script takes priority over write and read', () => {
    const perms: BrowserPermissions = {
      read: ['example.com'],
      write: ['example.com'],
      script: ['example.com'],
      deny: [],
    };
    assert.equal(checkBrowserPermission('https://example.com/', perms), 'script');
  });

  it('write takes priority over read', () => {
    const perms: BrowserPermissions = {
      read: ['example.com'],
      write: ['example.com'],
      script: [],
      deny: [],
    };
    assert.equal(checkBrowserPermission('https://example.com/', perms), 'write');
  });

  it('returns prompt for empty permissions', () => {
    const perms: BrowserPermissions = {
      read: [],
      write: [],
      script: [],
      deny: [],
    };
    assert.equal(checkBrowserPermission('https://example.com/', perms), 'prompt');
  });
});

// ---------------------------------------------------------------------------
// browserTierSufficient
// ---------------------------------------------------------------------------

describe('browserTierSufficient', () => {
  // -- script tier covers everything --

  it('script >= script', () => {
    assert.equal(browserTierSufficient('script', 'script'), true);
  });

  it('script >= write', () => {
    assert.equal(browserTierSufficient('script', 'write'), true);
  });

  it('script >= read', () => {
    assert.equal(browserTierSufficient('script', 'read'), true);
  });

  // -- write tier covers write and read --

  it('write >= write', () => {
    assert.equal(browserTierSufficient('write', 'write'), true);
  });

  it('write >= read', () => {
    assert.equal(browserTierSufficient('write', 'read'), true);
  });

  // -- read tier covers only read --

  it('read >= read', () => {
    assert.equal(browserTierSufficient('read', 'read'), true);
  });

  // -- insufficient tiers --

  it('write < script', () => {
    assert.equal(browserTierSufficient('write', 'script'), false);
  });

  it('read < write', () => {
    assert.equal(browserTierSufficient('read', 'write'), false);
  });

  it('read < script', () => {
    assert.equal(browserTierSufficient('read', 'script'), false);
  });

  // -- deny is insufficient for everything --

  it('deny < read', () => {
    assert.equal(browserTierSufficient('deny', 'read'), false);
  });

  it('deny < write', () => {
    assert.equal(browserTierSufficient('deny', 'write'), false);
  });

  it('deny < script', () => {
    assert.equal(browserTierSufficient('deny', 'script'), false);
  });

  // -- prompt is insufficient for everything --

  it('prompt < read', () => {
    assert.equal(browserTierSufficient('prompt', 'read'), false);
  });

  it('prompt < write', () => {
    assert.equal(browserTierSufficient('prompt', 'write'), false);
  });

  it('prompt < script', () => {
    assert.equal(browserTierSufficient('prompt', 'script'), false);
  });
});
