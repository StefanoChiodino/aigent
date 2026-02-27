/**
 * Unit tests for src/tools.ts — fetch response parsing.
 * Run with: node --import tsx/esm --test src/tools.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCurlResponse } from './tools.js';

// ---------------------------------------------------------------------------
// parseCurlResponse
// ---------------------------------------------------------------------------

describe('parseCurlResponse', () => {
  const SINGLE_RESPONSE =
    'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n<html><body><h1>Hello</h1></body></html>';

  const REDIRECT_RESPONSE =
    'HTTP/2 308\r\nlocation: https://www.example.com/\r\n\r\n' +
    'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' +
    '<html><body><p>Final page</p></body></html>';

  const DOUBLE_REDIRECT =
    'HTTP/2 301\r\nlocation: https://example.com/a\r\n\r\n' +
    'HTTP/2 302\r\nlocation: https://example.com/b\r\n\r\n' +
    'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' +
    '<html><body>Done</body></html>';

  it('extracts body from single response', () => {
    const result = parseCurlResponse(SINGLE_RESPONSE, false);
    assert.equal(result, '<html><body><h1>Hello</h1></body></html>');
  });

  it('extracts body from redirect response (skips intermediate headers)', () => {
    const result = parseCurlResponse(REDIRECT_RESPONSE, false);
    assert.equal(result, '<html><body><p>Final page</p></body></html>');
  });

  it('extracts body from double redirect', () => {
    const result = parseCurlResponse(DOUBLE_REDIRECT, false);
    assert.equal(result, '<html><body>Done</body></html>');
  });

  it('strips HTML in text_only mode', () => {
    const result = parseCurlResponse(SINGLE_RESPONSE, true);
    assert.equal(result, 'Hello');
  });

  it('strips HTML in text_only mode after redirect', () => {
    const result = parseCurlResponse(REDIRECT_RESPONSE, true);
    assert.equal(result, 'Final page');
    // Must NOT contain HTTP headers in the text output
    assert.ok(!result.includes('HTTP/2'), 'should not contain HTTP headers');
    assert.ok(!result.includes('content-type'), 'should not contain header fields');
  });

  it('strips scripts and styles in text_only mode', () => {
    const raw =
      'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' +
      '<html><head><script>var x=1;</script><style>body{color:red}</style></head>' +
      '<body><p>Content here</p></body></html>';
    const result = parseCurlResponse(raw, true);
    assert.equal(result, 'Content here');
    assert.ok(!result.includes('var x'), 'should strip script content');
    assert.ok(!result.includes('color:red'), 'should strip style content');
  });

  it('decodes HTML entities in text_only mode', () => {
    const raw =
      'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' +
      '<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39; &nbsp;G</p>';
    const result = parseCurlResponse(raw, true);
    assert.equal(result, 'A & B < C > D "E" \'F\' G');
  });

  it('returns raw body when no headers present', () => {
    const result = parseCurlResponse('just plain text', false);
    assert.equal(result, 'just plain text');
  });

  it('returns (empty response) for empty body after headers', () => {
    const raw = 'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n';
    const result = parseCurlResponse(raw, false);
    assert.equal(result, '(empty response)');
  });

  it('returns (empty response) for whitespace-only body in text_only mode', () => {
    const raw = 'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n   \n  \t  ';
    const result = parseCurlResponse(raw, true);
    assert.equal(result, '(empty response)');
  });
});
