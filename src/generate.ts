/**
 * Static HTML generator.
 *
 * Bakes a complete React 18 bundle (react + react-dom UMD) plus a small
 * React app and the labeled claim data into a single self-contained
 * HTML file that opens with no network access.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ParsedSegment } from './parse837';
import { LabelStats } from './rag';
import { VENDOR_DIR } from './paths';

const REACT_FILE = path.join(VENDOR_DIR, 'react.production.min.js');
const REACT_DOM_FILE = path.join(VENDOR_DIR, 'react-dom.production.min.js');

export interface BuildHtmlOptions {
  claimId: string;
  generatedAt: string;
  segments: ParsedSegment[];
  stats: LabelStats;
}

/** Page styles for the exported static claim view. */
const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: #eef1f6;
  color: #1d2433;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.page { max-width: 1200px; margin: 0 auto; padding: 24px 16px 56px; }
.page-header { margin-bottom: 18px; }
.page-header h1 { font-size: 22px; margin: 0 0 4px; font-weight: 700; }
.page-meta { color: #5c6780; font-size: 13px; }
.columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 920px) {
  .columns { grid-template-columns: 1fr; }
}
.card {
  background: #fff;
  border: 1px solid #d9e0ea;
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05);
  overflow: hidden;
}
.card-title {
  margin: 0;
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border-bottom: 1px solid #e6ebf3;
  color: #313b4d;
  background: #f8fafc;
}
.card-body { padding: 10px 14px; }
.claim-scroll, .fields-scroll { max-height: 68vh; overflow: auto; }
.claim-line { display: flex; gap: 8px; padding: 1px 0; }
.claim-gutter {
  flex: 0 0 58px;
  text-align: right;
  font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #8a93a6;
  padding-top: 3px;
}
.claim-raw {
  font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  color: #243043;
}
.el { border-radius: 3px; }
.el-hl { background: #ffe066; box-shadow: 0 0 0 2px #f5b301; color: #17202e; }
.sep { color: #9aa4b5; }
.field-group { margin: 12px 0; }
.field-group:first-child { margin-top: 4px; }
.field-group-head {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #66718a;
  margin-bottom: 6px;
}
.field-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 3px 4px;
  border-radius: 6px;
}
.field-row:hover, .row-hl { background: #fff8d6; }
.field-label {
  flex: 0 0 44%;
  font-size: 12.5px;
  color: #39435a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.field-value {
  flex: 1;
  min-width: 0;
  font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding: 6px 8px;
  border: 1px solid #d9e0ea;
  border-radius: 6px;
  background: #fbfcfe;
  color: #1d2433;
}
.row-hl .field-value { border-color: #f5b301; box-shadow: 0 0 0 2px #ffe066; }
.page-footer { margin-top: 18px; color: #6a7488; font-size: 12.5px; }
`;

/** The React application, inlined into every exported HTML file. */
const APP_JS = `(function () {
  'use strict';

  var h = React.createElement;
  var D = window.__CLAIM__;

  function App() {
    var hoverState = React.useState(null);
    var hoveredKey = hoverState[0];
    var setHoveredKey = hoverState[1];

    function handleHover(key) {
      if (key === null) {
        setHoveredKey(null);
        return;
      }
      setHoveredKey(key);
      window.requestAnimationFrame(function () {
        var el = document.querySelector('.el[data-key="' + key + '"]');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      });
    }

    // ----- Section 1: the electronic claim (raw EDI, element-highlightable) -----
    var claimLines = D.segments.map(function (seg, si) {
      var parts = [];
      seg.elements.forEach(function (el, ei) {
        var title = el.name ? el.name + (el.description ? ' \\u2014 ' + el.description : '') : seg.id + (ei + 1);
        parts.push(h('span', {
          key: el.key,
          'data-key': el.key,
          className: 'el' + (hoveredKey === el.key ? ' el-hl' : ''),
          onMouseEnter: function () { handleHover(el.key); },
          onMouseLeave: function () { handleHover(null); },
          title: title
        }, el.value));
        if (ei < seg.elements.length - 1) {
          parts.push(h('span', { key: el.key + '|', className: 'sep' }, '*'));
        }
      });
      return h('div', { key: 'seg-' + si, className: 'claim-line' },
        h('span', { className: 'claim-gutter' }, String(si + 1) + '. ' + seg.id),
        h('span', { className: 'claim-raw' }, parts)
      );
    });

    // ----- Section 2: parsed fields as form fields (label = data type, input = data) -----
    var fieldGroups = [];
    D.segments.forEach(function (seg, si) {
      var rows = [];
      seg.elements.forEach(function (el) {
        if (el.display === '') return;
        rows.push(h('div', {
          key: el.key,
          className: 'field-row' + (hoveredKey === el.key ? ' row-hl' : ''),
          onMouseEnter: function () { handleHover(el.key); },
          onMouseLeave: function () { handleHover(null); }
        },
          h('label', { className: 'field-label', title: el.name }, el.name),
          h('input', {
            className: 'field-value',
            readOnly: true,
            value: el.display,
            'aria-label': el.name
          })
        ));
      });
      if (rows.length === 0) return;
      fieldGroups.push(h('div', { key: 'group-' + si, className: 'field-group' },
        h('div', { className: 'field-group-head' }, seg.id + (seg.name ? ' \\u2014 ' + seg.name : '')),
        rows
      ));
    });

    return h('div', { className: 'page' },
      h('header', { className: 'page-header' },
        h('h1', null, 'EDI 837 Claim'),
        h('div', { className: 'page-meta' },
          'Claim ID: ' + D.claimId + '  \\u00b7  ' + D.segmentCount + ' segments  \\u00b7  ' +
          D.elementCount + ' fields  \\u00b7  generated ' + D.generatedAt
        )
      ),
      h('div', { className: 'columns' },
        h('section', { className: 'card' },
          h('h2', { className: 'card-title' }, 'Electronic Claim'),
          h('div', { className: 'card-body claim-scroll' }, claimLines)
        ),
        h('section', { className: 'card' },
          h('h2', { className: 'card-title' }, 'Parsed Fields'),
          h('div', { className: 'card-body fields-scroll' }, fieldGroups)
        )
      ),
      h('footer', { className: 'page-footer' },
        'Hover a field name or value to highlight where it appears in the electronic claim (and vice versa). ' +
        'Field labels were retrieved from the local vector database (837 X222 knowledge base).'
      )
    );
  }

  var root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(h(App));
})();`;

/** Guard against a literal `</script>` sequence inside inlined bundles. */
function safeJs(src: string): string {
  return src.replace(/<\/script/gi, '<\\/script');
}

export function buildHtml({ claimId, generatedAt, segments, stats }: BuildHtmlOptions): string {
  const react = safeJs(fs.readFileSync(REACT_FILE, 'utf8'));
  const reactDom = safeJs(fs.readFileSync(REACT_DOM_FILE, 'utf8'));

  const payload = {
    claimId,
    generatedAt,
    segmentCount: segments.length,
    elementCount: segments.reduce((n, s) => n + s.elements.length, 0),
    rag: stats,
    segments: segments.map((s) => ({
      index: s.index,
      id: s.id,
      name: s.name ?? null,
      elements: s.elements.map((e) => ({
        key: e.key,
        value: e.value,
        display: e.display,
        name: e.name ?? '',
        description: e.description ?? '',
      })),
    })),
  };

  // Escape characters that would break out of the inline <script> or JSON.
  const payloadJson = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>EDI 837 Claim ' + claimId + '</title>',
    '<style>' + CSS + '</style>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    '<noscript><p style="padding:24px;font-family:sans-serif">This claim viewer requires JavaScript (the claim is rendered by React baked into this file).</p></noscript>',
    '<script>' + react + '</script>',
    '<script>' + reactDom + '</script>',
    '<script>',
    'window.__CLAIM__ = ' + payloadJson + ';',
    APP_JS,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

export { REACT_FILE, REACT_DOM_FILE };
