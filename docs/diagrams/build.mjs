// Draws the diagrams of the README: one light and one dark SVG file for each, in `docs/images/diagrams/`.
// The colors and the fonts are the theme of `@leads/ui` (`packages/ui/src/styles/globals.css`). Each file carries the
// subsets of its fonts as data, because GitHub shows an SVG as an image, and an image loads no web font.
// Usage: node docs/diagrams/build.mjs (it fetches the font subsets from Google Fonts)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const outputDirectory = path.resolve(import.meta.dirname, '../images/diagrams');

const themes = {
  light: {
    background: '#edf0f3',
    foreground: '#18212c',
    card: '#fafbfc',
    muted: '#5c6876',
    input: '#c7cfd8',
    live: '#2d5bd3',
    'live-soft': '#e0e8fb',
    ok: '#1e7a52',
    'ok-soft': '#dcefe5',
    crit: '#c2352b',
    'crit-soft': '#fae1de',
    warn: '#a35f00',
    'warn-soft': '#f8ebd4',
  },
  dark: {
    background: '#141a21',
    foreground: '#dde4eb',
    card: '#1b222b',
    muted: '#8e9aa8',
    input: '#343e4a',
    live: '#7fa2f5',
    'live-soft': '#1c2945',
    ok: '#5ccb92',
    'ok-soft': '#173326',
    crit: '#ff8b80',
    'crit-soft': '#41191a',
    warn: '#edb051',
    'warn-soft': '#382a12',
  },
};

const sans = "'Manrope', ui-sans-serif, system-ui, sans-serif";
const mono = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace";

const css = `
.paper, .mask { fill: var(--background); }
.box { fill: var(--card); stroke: var(--input); stroke-width: 1; stroke-linejoin: round; }
.name { font: 600 16px ${sans}; fill: var(--foreground); }
.name.small { font-size: 14px; }
.sub { font: 400 12px ${mono}; fill: var(--muted); }
.tag { font: 500 9px ${mono}; fill: var(--muted); text-anchor: middle; letter-spacing: 0.04em; }
.tagbox { fill: none; stroke: var(--input); stroke-width: 0.8; }
.eyebrow { font: 500 11px ${mono}; fill: var(--muted); letter-spacing: 0.12em; }
.code { font: 500 12px ${mono}; fill: var(--foreground); }
.note { font: 400 12px ${mono}; fill: var(--muted); }
.label { font: 500 10px ${mono}; letter-spacing: 0.08em; fill: var(--muted); }
.icon { fill: none; stroke: var(--muted); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.slots { fill: none; stroke: var(--live); stroke-width: 1; opacity: 0.6; }
.badge { font: 500 10px ${mono}; fill: var(--ok); text-anchor: middle; }
.badge-box { fill: none; stroke: var(--ok); stroke-width: 1; }
.container { fill: none; stroke: var(--ok); stroke-width: 1.5; stroke-linejoin: round; }
.core { fill: var(--card); stroke: var(--ok); stroke-width: 1.5; stroke-linejoin: round; }
.aws .box { stroke: var(--live); } .aws .name { fill: var(--live); } .aws .icon { stroke: var(--live); }
.fn .box { stroke: var(--ok); } .fn .name { fill: var(--ok); } .fn .icon { stroke: var(--ok); }
.port .box { stroke: var(--muted); }
.fail .box { fill: var(--crit-soft); stroke: var(--crit); }
.fail .name, .fail .sub, .fail .code { fill: var(--crit); } .fail .icon { stroke: var(--crit); }
.done .box { fill: var(--ok-soft); stroke: var(--ok); stroke-width: 1.5; } .done .name { fill: var(--ok); }
.warn .box { fill: var(--warn-soft); stroke: var(--warn); } .warn .code, .warn .sub { fill: var(--warn); }
.focal .box { fill: var(--live-soft); stroke: var(--live); stroke-width: 1.5; } .focal .name { fill: var(--live); }
.ext .box { stroke-dasharray: 6 4; }
.wire { fill: none; stroke-width: 1.5; stroke: var(--muted); }
.wire.live { stroke: var(--live); } .wire.crit { stroke: var(--crit); } .wire.ok { stroke: var(--ok); }
.wire.warn { stroke: var(--warn); } .wire.thin { stroke-width: 1; } .wire.dashed { stroke-dasharray: 5 4; }
.label.live { fill: var(--live); } .label.crit { fill: var(--crit); }
.note.warn { fill: var(--warn); }
.dot.crit { fill: var(--crit); }
.m-live { fill: var(--live); } .m-crit { fill: var(--crit); } .m-ok { fill: var(--ok); }
.m-warn { fill: var(--warn); } .m-muted { fill: var(--muted); }
`;

const markerKinds = ['live', 'crit', 'ok', 'warn', 'muted'];

// The glyphs of Tabler Icons (MIT), drawn in a 24 × 24 box.
const icons = {
  mail: '<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7l9 6 9-6"/>',
  bucket:
    '<path d="M4 7a8 4 0 1 0 16 0a8 4 0 1 0 -16 0"/><path d="M4 7c0 .664 .088 1.324 .263 1.965l2.737 10.035c.5 1.5 2.239 2 5 2s4.5 -.5 5 -2c.333 -1 1.246 -4.345 2.737 -10.035a7.45 7.45 0 0 0 .263 -1.965"/>',
  lambda: '<path d="M5 4h3.5L17 20h3"/><path d="M12.5 11.5 5.5 20"/>',
  warning:
    '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  table:
    '<path d="M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/>',
};

const escape = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** An orthogonal path through `points`, with a rounded corner of radius `r` at each bend. */
const elbow = (points, r = 8) => {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    if (i === points.length - 1) {
      d += ` L${x},${y}`;
      break;
    }
    const [px, py] = points[i - 1];
    const [nx, ny] = points[i + 1];
    const toward = (from, to) => Math.sign(to - from) * r;
    d += ` L${x - toward(px, x)},${y - toward(py, y)} Q${x},${y} ${x + toward(x, nx)},${y + toward(y, ny)}`;
  }
  return d;
};

const wire = (d, { kind = 'muted', marker = true, dashed = false, thin = false } = {}) => {
  const classes = ['wire', kind !== 'muted' && kind, dashed && 'dashed', thin && 'thin'].filter(Boolean).join(' ');
  const end = marker ? ` marker-end="url(#arrow-${kind})"` : '';
  return `<path class="${classes}" d="${typeof d === 'string' ? d : elbow(d)}"${end}/>`;
};

const tagWidth = (text) => Math.ceil(text.length * 5.8 + 10);

const tag = (text, right, top) => {
  const width = tagWidth(text);
  return `<rect class="tagbox" x="${right - width}" y="${top}" width="${width}" height="14" rx="2"/><text class="tag" x="${right - width / 2}" y="${top + 10}">${escape(text)}</text>`;
};

const outlineOf = (shape, x, y, w, h) => {
  const right = x + w;
  const bottom = y + h;
  const middle = y + h / 2;
  switch (shape) {
    case 'pill':
      return `M${x + h / 2},${y} H${right - h / 2} A${h / 2},${h / 2} 0 0 1 ${right - h / 2},${bottom} H${x + h / 2} A${h / 2},${h / 2} 0 0 1 ${x + h / 2},${y} Z`;
    case 'bucket':
      return `M${x},${y} H${right} L${right - 8},${bottom} H${x + 8} Z`;
    case 'octagon':
      return `M${x + 10},${y} H${right - 10} L${right},${y + 10} V${bottom - 10} L${right - 10},${bottom} H${x + 10} L${x},${bottom - 10} V${y + 10} Z`;
    case 'hexagon':
      return `M${x + 12},${y} H${right - 12} L${right},${middle} L${right - 12},${bottom} H${x + 12} L${x},${middle} Z`;
    default:
      return `M${x + 6},${y} H${right - 6} Q${right},${y} ${right},${y + 6} V${bottom - 6} Q${right},${bottom} ${right - 6},${bottom} H${x + 6} Q${x},${bottom} ${x},${bottom - 6} V${y + 6} Q${x},${y} ${x + 6},${y} Z`;
  }
};

/**
 * One node: a shape with a name, an optional sublabel in mono, an optional tag at its top right, and an optional icon
 * at its left. A queue is a box with the slots of a queue at its left.
 */
const node = ({
  x,
  y,
  w,
  h = 56,
  kind = '',
  shape = 'box',
  name,
  sub,
  tag: tagText,
  icon,
  iconRight,
  small,
  queue,
}) => {
  const outline = outlineOf(shape, x, y, w, h);
  const middle = y + h / 2;
  const textX = x + (icon ? 38 : queue ? 30 : shape === 'hexagon' || shape === 'bucket' ? 22 : 14);
  const parts = [`<path class="mask" d="${outline}"/>`, `<path class="box" d="${outline}"/>`];
  if (queue)
    parts.push(
      `<path class="slots" d="M${x + 8},${y} V${y + h} M${x + 14},${y} V${y + h} M${x + 20},${y} V${y + h}"/>`
    );
  if (icon) parts.push(`<g class="icon" transform="translate(${x + 14},${middle - 9}) scale(0.75)">${icons[icon]}</g>`);
  if (iconRight)
    parts.push(`<g class="icon" transform="translate(${x + w - 30},${y + 7}) scale(0.6667)">${icons[iconRight]}</g>`);
  const nameClass = small ? 'name small' : 'name';
  if (sub) {
    parts.push(`<text class="${nameClass}" x="${textX}" y="${middle - 4}">${escape(name)}</text>`);
    parts.push(`<text class="sub" x="${textX}" y="${middle + 14}">${escape(sub)}</text>`);
  } else {
    parts.push(`<text class="${nameClass}" x="${textX}" y="${middle + 5}">${escape(name)}</text>`);
  }
  if (tagText) {
    const inset = shape === 'hexagon' ? 14 : shape === 'bucket' ? 10 : 8;
    parts.push(tag(tagText, x + w - inset, y + 8));
  }
  return `<g class="node ${kind}">${parts.join('')}</g>`;
};

/** A label on an opaque mask, so a wire behind it does not show through. */
const label = (text, x, y, { anchor = 'start', kind = '' } = {}) => {
  const width = Math.ceil(text.length * 6.8 + 8);
  const left = anchor === 'start' ? x - 4 : anchor === 'end' ? x - width + 4 : x - width / 2;
  return `<rect class="mask" x="${left}" y="${y - 10}" width="${width}" height="14"/><text class="label ${kind}" x="${x}" y="${y}" text-anchor="${anchor}">${escape(text)}</text>`;
};

const eyebrow = (text, x, y, anchor = 'start') =>
  `<text class="eyebrow" x="${x}" y="${y}" text-anchor="${anchor}">${escape(text)}</text>`;

const badge = (text, x, y, kind = '') =>
  `<rect class="badge-box ${kind}" x="${x}" y="${y}" width="24" height="16" rx="3"/><text class="badge ${kind}" x="${x + 12}" y="${y + 12}">${escape(text)}</text>`;

const dot = (x, y) => `<circle class="dot crit" cx="${x}" cy="${y}" r="3"/>`;

// ─── The pipeline ────────────────────────────────────────────────────────────────────────────────────────────────

const overview = {
  slug: 'pipeline',
  title: 'The leads pipeline on AWS',
  desc: 'An email passes three stages, each with a queue, a dead-letter queue, and a Lambda handler, and ends as orders in DynamoDB; every handler writes the progress of the email into the request ledger.',
  width: 990,
  height: 564,
  body: () => {
    const stage = (x, y) => ({ x, y });
    const one = stage(24, 28);
    const two = stage(290, 256);
    const three = stage(556, 408);
    return [
      wire('M139,84 V104', { kind: 'live' }),
      wire('M139,160 V180', { kind: 'live' }),
      wire('M139,236 V256', { kind: 'live' }),
      wire('M254,208 H290', { kind: 'crit' }),
      wire('M254,284 H290', { kind: 'live' }),
      wire('M405,312 V332', { kind: 'live' }),
      wire('M405,388 V408', { kind: 'live' }),
      wire('M520,360 H556', { kind: 'crit' }),
      wire('M520,436 H556', { kind: 'live' }),
      wire('M671,464 V484', { kind: 'live' }),
      wire('M786,436 H822', { kind: 'crit' }),
      wire('M786,512 H822', { kind: 'ok' }),
      // Each handler writes the progress of its request into the ledger.
      wire('M139,312 V484', { dashed: true, thin: true }),
      wire(
        [
          [320, 464],
          [320, 512],
          [254, 512],
        ],
        { dashed: true, thin: true }
      ),
      wire('M563,528 H254', { dashed: true, thin: true }),
      label('PROGRESS', 147, 404),
      eyebrow('STAGE 1 · INBOX', one.x, 18),
      eyebrow('STAGE 2 · SOURCES', two.x, 249),
      eyebrow('STAGE 3 · LEADS', three.x, 401),
      node({ ...one, w: 230, kind: 'aws', shape: 'pill', icon: 'mail', name: 'SES', sub: 'inbound email' }),
      node({
        x: 24,
        y: 104,
        w: 230,
        kind: 'aws',
        shape: 'bucket',
        icon: 'bucket',
        name: 'Inbox bucket',
        sub: 'the raw email',
        tag: 'S3',
      }),
      node({
        x: 24,
        y: 180,
        w: 230,
        kind: 'aws',
        queue: true,
        name: 'Inbox queue',
        sub: 'cap 50 · batch 1',
        tag: 'SQS',
      }),
      node({
        x: 290,
        y: 180,
        w: 144,
        kind: 'fail',
        shape: 'octagon',
        iconRight: 'warning',
        name: 'DLQ',
        sub: '1 receive · 14 d',
      }),
      node({
        x: 24,
        y: 256,
        w: 230,
        kind: 'fn',
        shape: 'hexagon',
        icon: 'lambda',
        name: 'Inbox handler',
        sub: 'parse · guard · store',
        tag: 'LAMBDA',
      }),
      node({
        ...two,
        w: 230,
        kind: 'aws',
        shape: 'bucket',
        icon: 'bucket',
        name: 'Sources bucket',
        sub: 'the workbooks',
        tag: 'S3',
      }),
      node({
        x: 290,
        y: 332,
        w: 230,
        kind: 'aws',
        queue: true,
        name: 'Sources queue',
        sub: 'cap 50 · batch 1',
        tag: 'SQS',
      }),
      node({
        x: 556,
        y: 332,
        w: 144,
        kind: 'fail',
        shape: 'octagon',
        iconRight: 'warning',
        name: 'DLQ',
        sub: '1 receive · 14 d',
      }),
      node({
        x: 290,
        y: 408,
        w: 230,
        kind: 'fn',
        shape: 'hexagon',
        icon: 'lambda',
        name: 'Sources handler',
        sub: 'parse · push batches',
        tag: 'LAMBDA',
      }),
      node({
        ...three,
        w: 230,
        kind: 'aws',
        queue: true,
        name: 'Leads queue',
        sub: 'cap 200 · batch 10 · 10 s',
        tag: 'SQS',
      }),
      node({
        x: 822,
        y: 408,
        w: 144,
        kind: 'fail',
        shape: 'octagon',
        iconRight: 'warning',
        name: 'DLQ',
        sub: '1 receive · 14 d',
      }),
      node({
        x: 556,
        y: 484,
        w: 230,
        kind: 'fn',
        shape: 'hexagon',
        icon: 'lambda',
        name: 'Lead handler',
        sub: 'token · idempotency key',
        tag: 'LAMBDA',
      }),
      node({ x: 822, y: 484, w: 144, kind: 'done', name: 'Orders', sub: '≤2,000 writes/s', tag: 'DYNAMODB' }),
      node({
        x: 24,
        y: 484,
        w: 230,
        kind: 'aws',
        icon: 'table',
        name: 'Request ledger',
        sub: 'one entry per email',
        tag: 'DYNAMODB',
      }),
    ];
  },
};

// ─── One use case, two wirings ───────────────────────────────────────────────────────────────────────────────────

const hexagon = {
  slug: 'hexagon',
  title: 'One use case, two wirings',
  desc: 'The Lambda entrypoint and the use case test both run the HandleInbox use case of the core; the use case reaches the world only through its ports, which the Lambda binds to live adapters and the test binds to fakes.',
  width: 980,
  height: 520,
  body: () => [
    `<path class="core" d="M340,40 H630 L670,240 L630,440 H340 L300,240 Z"/>`,
    eyebrow('ENTRYPOINTS · DRIVING', 24, 72),
    eyebrow('CORE/PIPELINE', 480, 72, 'middle'),
    eyebrow('INFRASTRUCTURE · DRIVEN', 780, 72),
    wire('M264,116 H360', { kind: 'live' }),
    wire(
      [
        [264, 340],
        [280, 340],
        [280, 140],
        [360, 140],
      ],
      { dashed: true }
    ),
    wire('M460,156 V264'),
    wire('M560,128 H596'),
    wire('M780,116 H740', { kind: 'live' }),
    wire('M780,284 H740', { dashed: true }),
    node({
      x: 24,
      y: 88,
      w: 240,
      kind: 'fn',
      shape: 'hexagon',
      icon: 'lambda',
      name: 'Lambda entrypoint',
      sub: 'inbox.ts · services.ts',
    }),
    node({ x: 24, y: 312, w: 240, kind: 'ext', name: 'Use case test', sub: 'handler.test.ts' }),
    node({ x: 360, y: 100, w: 200, kind: 'done', name: 'HandleInbox', sub: 'command · handler', tag: 'USE CASE' }),
    node({ x: 360, y: 264, w: 200, name: 'Domain', sub: 'Schema · keys · rules' }),
    `<text class="note" x="460" y="400" text-anchor="middle">the core imports no AWS SDK</text>`,
    `<g class="node port"><path class="mask" d="${outlineOf('box', 596, 96, 144, 216)}"/><path class="box" d="${outlineOf('box', 596, 96, 144, 216)}"/>${tag('PORTS', 732, 104)}${[
      'Storage',
      'EmailParser',
      'Guard',
      'RequestLedger',
    ]
      .map((port, index) => `<text class="name small" x="612" y="${148 + index * 40}">${port}</text>`)
      .join('')}</g>`,
    node({ x: 780, y: 88, w: 180, kind: 'aws', name: 'Live adapters', sub: 'S3 · SQS · DynamoDB' }),
    node({ x: 780, y: 256, w: 180, kind: 'ext', name: 'Test adapters', sub: 'Ports/testing' }),
    // The legend.
    wire('M24,488 H64', { kind: 'live' }),
    `<text class="note" x="76" y="492">live: services.ts provides the adapters of AWS</text>`,
    wire('M520,488 H560', { dashed: true }),
    `<text class="note" x="572" y="492">test: the test provides fakes</text>`,
  ],
};

// ─── The inbox handler ───────────────────────────────────────────────────────────────────────────────────────────

const inbox = {
  slug: 'inbox-handler',
  title: 'The inbox handler, step by step',
  desc: 'The HandleInbox use case acknowledges, reads, parses, authorizes, and stores the attachments of one email; each step can fail with a typed error, which either rejects the email or fails the handler, and a processed or rejected email is deleted.',
  width: 928,
  height: 624,
  body: () => {
    const rows = [
      { port: 'RequestLedger', step: 'acknowledge', error: 'RequestNotAcknowledged', retried: true },
      { port: 'Storage', step: 'read', error: 'FileNotRead', retried: true },
      { port: 'EmailParser', step: 'parse', error: 'EmailNotParsed' },
      { port: 'Guard', step: 'authorize', error: 'Unauthorized' },
      { port: 'Storage', step: 'store attachments', error: 'AttachmentsNotStored', retried: true },
    ];
    const top = (index) => 136 + index * 56;
    const middle = (index) => top(index) + 20;
    const parts = [
      `<path class="container" d="M40,16 H884 L912,312 L884,608 H40 L12,312 Z"/>`,
      eyebrow('STAGE 1 · INBOX', 56, 56),
      `<text class="code" x="216" y="56">HandleInbox</text>`,
      `<g class="icon" style="stroke: var(--ok)" transform="translate(312,43) scale(0.6667)">${icons.lambda}</g>`,
      tag('LAMBDA', 384, 45),
      eyebrow('PORT', 56, 120),
      eyebrow('STEP', 216, 120),
      eyebrow('TYPED ERROR', 448, 120),
    ];
    rows.forEach((row, index) => {
      parts.push(wire(`M192,${middle(index)} H216`, { marker: false, thin: true }));
      parts.push(wire(`M416,${middle(index)} H448`, { kind: 'crit' }));
      if (index < rows.length - 1) parts.push(wire(`M316,${top(index) + 40} V${top(index + 1)}`, { kind: 'live' }));
    });
    // Failures that a redrive can fix fail the handler; the others reject the email.
    parts.push(wire(`M664,${middle(0)} H776`, { kind: 'crit', marker: false }), dot(776, middle(0)));
    parts.push(wire(`M664,${middle(1)} H776`, { kind: 'crit', marker: false }), dot(776, middle(1)));
    parts.push(
      wire(`M664,${middle(4)} H698 A6,6 0 0 1 710,${middle(4)} H768 Q776,${middle(4)} 776,${middle(4) - 8} V96`, {
        kind: 'crit',
      })
    );
    parts.push(
      wire(
        [
          [664, middle(2)],
          [704, middle(2)],
          [704, 440],
        ],
        { kind: 'crit' }
      )
    );
    parts.push(wire(`M664,${middle(3)} H704`, { kind: 'crit', marker: false }), dot(704, middle(3)));
    parts.push(label('FAILED', 766, 120, { anchor: 'end', kind: 'crit' }));
    parts.push(label('REJECTED', 714, 428, { kind: 'crit' }));
    parts.push(wire(`M316,${top(4) + 40} V440`, { kind: 'live' }), label('PROCESSED', 326, 424, { kind: 'live' }));
    parts.push(wire('M316,480 V520', { kind: 'ok' }));
    parts.push(wire('M728,460 H752', { kind: 'warn' }));
    parts.push(
      wire(
        [
          [816, 488],
          [816, 500],
          [408, 500],
          [408, 520],
        ],
        { kind: 'warn', dashed: true }
      )
    );
    rows.forEach((row, index) => {
      parts.push(node({ x: 56, y: top(index), w: 136, h: 40, kind: 'port', name: row.port, small: true }));
      parts.push(node({ x: 216, y: top(index), w: 200, h: 40, kind: 'fn', name: row.step }));
      if (row.retried) parts.push(badge('×3', 380, top(index) + 12));
      parts.push(
        `<g class="node fail"><path class="mask" d="${outlineOf('box', 448, top(index), 216, 40)}"/><path class="box" d="${outlineOf('box', 448, top(index), 216, 40)}"/><text class="code" x="464" y="${middle(index) + 4}">${row.error}</text></g>`
      );
    });
    parts.push(node({ x: 56, y: 440, w: 136, h: 40, kind: 'port', name: 'Storage', small: true }));
    parts.push(wire('M192,460 H216', { marker: false, thin: true }));
    parts.push(node({ x: 216, y: 440, w: 512, h: 40, kind: 'fn', name: 'delete' }));
    parts.push(badge('×3', 288, 452));
    parts.push(
      `<text class="note" x="712" y="464" text-anchor="end">withHandlerOutcome: the file has no more use</text>`
    );
    parts.push(
      `<g class="node warn"><path class="mask" d="${outlineOf('box', 752, 440, 128, 48)}"/><path class="box" d="${outlineOf('box', 752, 440, 128, 48)}"/><text class="code" x="764" y="460">FileNotDeleted</text><text class="sub" x="764" y="478">a warning</text></g>`
    );
    parts.push(
      node({ x: 216, y: 520, w: 240, kind: 'done', name: 'Handler succeeds', sub: 'the ledger keeps the status' })
    );
    parts.push(
      `<g class="node fail"><path class="mask" d="${outlineOf('box', 688, 32, 192, 64)}"/><path class="box" d="${outlineOf('box', 688, 32, 192, 64)}"/><text class="name" x="702" y="54">Handler fails</text><text class="code" x="702" y="72">InboxEventNotHandled</text><text class="sub" x="702" y="88">file stays · to the DLQ</text></g>`
    );
    parts.push(badge('×3', 56, 580));
    parts.push(`<text class="note" x="90" y="592">3 retries with backoff, then the error</text>`);
    parts.push(`<text class="note warn" x="868" y="592" text-anchor="end">a defect also fails the handler</text>`);
    return parts;
  },
};

// ─── The workspace ───────────────────────────────────────────────────────────────────────────────────────────────

const workspace = {
  slug: 'workspace',
  title: 'The packages of the workspace',
  desc: 'Four tiers of packages: the IaC stacks and the e2e suite, the three apps, the pipeline and UI libraries, and the shared kernel that every package reads; arrows point from a package to the package it installs.',
  width: 960,
  height: 520,
  body: () => [
    eyebrow('IAC + E2E', 40, 32),
    eyebrow('APPS', 40, 152),
    eyebrow('LIBRARIES', 40, 272),
    eyebrow('SHARED KERNEL', 40, 384),
    wire('M370,68 H260'),
    wire('M590,68 H700'),
    label('DEPLOYS', 315, 56, { anchor: 'middle' }),
    label('DEPLOYS', 645, 56, { anchor: 'middle' }),
    wire('M110,96 V160'),
    wire(
      [
        [400, 96],
        [400, 116],
        [180, 116],
        [180, 160],
      ],
      { dashed: true }
    ),
    wire([
      [810, 96],
      [810, 128],
      [240, 128],
      [240, 160],
    ]),
    label('THE LAMBDA BUNDLE', 680, 144, { anchor: 'middle' }),
    wire('M200,216 V280'),
    wire('M400,216 V280', { dashed: true }),
    label('CONTRACT TEST', 408, 252),
    wire('M560,216 V280'),
    wire('M760,216 V280'),
    node({ x: 40, y: 40, w: 220, kind: 'aws', name: '@leads/cdk', sub: 'iac/cdk', tag: 'IAC' }),
    node({ x: 370, y: 40, w: 220, kind: 'ext', name: '@leads/e2e', sub: 'e2e', tag: 'TEST' }),
    node({ x: 700, y: 40, w: 220, kind: 'aws', name: '@leads/alchemy', sub: 'iac/alchemy', tag: 'IAC' }),
    node({
      x: 40,
      y: 160,
      w: 220,
      kind: 'fn',
      shape: 'hexagon',
      name: '@leads/lambda',
      sub: 'apps/lambda',
      tag: 'LAMBDA',
    }),
    node({ x: 370, y: 160, w: 220, kind: 'fn', name: '@leads/lab', sub: 'apps/lab', tag: 'WEB' }),
    node({ x: 700, y: 160, w: 220, kind: 'fn', name: '@leads/dashboard', sub: 'apps/dashboard', tag: 'WEB' }),
    node({ x: 150, y: 280, w: 280, kind: 'focal', name: '@leads/pipeline', sub: 'the pipeline hexagon', tag: 'LIB' }),
    node({ x: 530, y: 280, w: 280, name: '@leads/ui', sub: 'the shadcn kit · the theme', tag: 'LIB' }),
    node({ x: 40, y: 392, w: 880, name: '@leads/shared', sub: 'domain facts · deployments · resource names' }),
    `<text class="note" x="904" y="424" text-anchor="end">every package reads it</text>`,
    // The legend.
    wire('M40,488 H80'),
    `<text class="note" x="92" y="492">installs</text>`,
    wire('M200,488 H240', { dashed: true }),
    `<text class="note" x="252" y="492">installs for a test only</text>`,
  ],
};

const diagrams = [overview, hexagon, inbox, workspace];

// ─── The fonts ───────────────────────────────────────────────────────────────────────────────────────────────────

const browser =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** The `@font-face` rule of one face, with the subset of the characters of `text` as a data URL. */
const fontFace = async (family, weight, text) => {
  const query = `family=${family.replaceAll(' ', '+')}:wght@${weight}&text=${encodeURIComponent(text)}`;
  const response = await fetch(`https://fonts.googleapis.com/css2?${query}`, { headers: { 'User-Agent': browser } });
  if (!response.ok) throw new Error(`Google Fonts refused ${family} ${weight}: ${response.status}`);
  const stylesheet = await response.text();
  const url = /url\((https:[^)]+)\)/.exec(stylesheet)?.[1];
  if (url === undefined) throw new Error(`No font file for ${family} ${weight}`);
  const font = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': browser } })).arrayBuffer());
  return `@font-face { font-family: '${family}'; font-weight: ${weight}; src: url(data:font/woff2;base64,${font.toString('base64')}) format('woff2'); }`;
};

const textOf = (markup) =>
  [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
    .map((match) => match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'))
    .join('');

const uniqueCharacters = (text) => [...new Set(text)].sort().join('');

// ─── The files ───────────────────────────────────────────────────────────────────────────────────────────────────

const svgOf = (diagram, theme, fonts) => {
  const id = `${diagram.slug}-${theme}`;
  const tokens = Object.entries(themes[theme])
    .map(([token, value]) => `--${token}: ${value};`)
    .join(' ');
  const rules = css
    .trim()
    .split('\n')
    .map((line) =>
      line.replace(
        /(^|\} )([^{}]+?) \{/g,
        (_, start, selectors) =>
          `${start}${selectors
            .split(', ')
            .map((selector) => `#${id} ${selector}`)
            .join(', ')} {`
      )
    )
    .join('\n');
  const markers = markerKinds
    .map(
      (kind) =>
        `<marker id="arrow-${kind}" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon class="m-${kind}" points="0 0, 8 3, 0 6"/></marker>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" id="${id}" width="${diagram.width}" height="${diagram.height}" viewBox="0 0 ${diagram.width} ${diagram.height}" role="img" aria-labelledby="${id}-title ${id}-desc">
<title id="${id}-title">${escape(diagram.title)}</title>
<desc id="${id}-desc">${escape(diagram.desc)}</desc>
<defs>
<style>
${fonts}
#${id} { ${tokens} font-family: ${sans}; }
${rules}
</style>
${markers}
</defs>
<rect class="paper" width="100%" height="100%" rx="8"/>
${diagram.markup}
</svg>
`;
};

for (const diagram of diagrams) diagram.markup = diagram.body().join('\n');

const allText = diagrams.map((diagram) => textOf(diagram.markup)).join('');
const fonts = (
  await Promise.all([
    fontFace('Manrope', 600, uniqueCharacters(allText)),
    fontFace('IBM Plex Mono', 400, uniqueCharacters(allText)),
    fontFace('IBM Plex Mono', 500, uniqueCharacters(allText)),
  ])
).join('\n');

mkdirSync(outputDirectory, { recursive: true });
for (const diagram of diagrams) {
  for (const theme of Object.keys(themes)) {
    const file = path.join(outputDirectory, `${diagram.slug}-${theme}.svg`);
    writeFileSync(file, svgOf(diagram, theme, fonts));
    console.log(path.relative(process.cwd(), file));
  }
}
