'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

for (const total of [2, 50]) {
  test('customer PDF preview disables generated evaluation and preserves page rendering: ' + total, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../public/chat.js'), 'utf8');
    const match = source.match(/  async function renderPdfInto\(container, bytes\) \{([\s\S]*?)\n  \}/);
    assert.ok(match, 'actual application PDF renderer must be present');
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49]);
    const pageNumbers = [], canvases = [], renders = [];
    let documentOptions;
    const loadPdfjs = async () => ({
      getDocument(options) {
        documentOptions = options;
        return {promise: Promise.resolve({
          numPages: total,
          async getPage(number) {
            pageNumbers.push(number);
            return {
              getViewport({scale}) { return {width: 200 * scale, height: 300 * scale}; },
              render(args) { renders.push(args); return {promise: Promise.resolve()}; },
            };
          },
        })};
      },
    });
    const context = vm.createContext({
      loadPdfjs, Uint8Array, Math,
      document: {createElement(tag) {
        assert.equal(tag, 'canvas');
        const canvas = {getContext(kind) {assert.equal(kind, '2d'); return {canvas};}};
        canvases.push(canvas);
        return canvas;
      }},
    });
    const render = vm.runInContext('(async function renderPdfInto(container, bytes) {' + match[1] + '\n})', context);
    const inserted = [];
    const container = {textContent: 'loading', clientWidth: 400, appendChild(canvas) {inserted.push(canvas);}};
    const count = await render(container, bytes);
    assert.equal(documentOptions.isEvalSupported, false, 'untrusted PDF must not enable generated JavaScript');
    assert.deepEqual(Array.from(documentOptions.data), Array.from(bytes));
    assert.equal(count, Math.min(total, 40));
    assert.deepEqual(pageNumbers, Array.from({length: count}, (_, i) => i + 1));
    assert.equal(inserted.length, count);
    assert.equal(renders.length, count);
    assert.equal(container.textContent, '');
    assert.ok(canvases.every(canvas => canvas.width > 0 && canvas.height > 0));
  });
}
