import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Comparison } from '#Core/Observation/Domain/comparison';
import type { Simulation } from '#Core/Simulation/Application/UseCases/SimulateBurst/handler';
import { inboxPutWaves } from '#Core/Simulation/Domain/inbox';
import { arrivalNear, isWhole, waitingAt, type Lane, type LaneName, type Piece } from '#Core/Simulation/Domain/lane';
import { leadStoreWaves, leadsPerHandler } from '#Core/Simulation/Domain/leads';
import type { HandlerWave } from '#Core/Simulation/Domain/schedule';
import { leadBatchSize, sourceBatches, type SliceInputs } from '#Core/Simulation/Domain/sources';
import { valueAt, type Peak, type Step, type Swarm } from '#Core/Simulation/Domain/swarm';

import { number } from './format';
import {
  barDuration,
  barWidthOnAxis,
  formatZoom,
  maxZoom,
  minZoom,
  nextZoom,
  plotWidthAtZoom,
  rowsInBand,
  scrollHoldingTime,
  spanWidths,
  timeUnderPointer,
  zoomAtWheel,
} from './spanLayout';

const viewWidth = 1000;
/** Center inset: 8px circle plus the 1px ring, matching the track's rounded end. */
const handleRadius = 9;
const plotLeft = 132;
const plotRight = 72;
const barHeight = 16;
const barGap = 8;
const skipGap = 28;
const laneTop = 22;

function slotY(slot: number, origin: number) {
  if (slot === 0) return origin;
  if (slot === 1) return origin + barHeight + barGap;
  return origin + (barHeight + barGap) * 2 + skipGap;
}

const innerGap = 22;

/** A wave is as tall as the bars it draws: one, two, or three with the dots. */
function waveHeight(count: number) {
  return slotY(shownBars(count).bars - 1, 0) + barHeight;
}

/** Room above the model waves and above the real runs for the name of each part. */
const partGap = 20;

/**
 * Top of each wave, stacked down the lane with one gap between waves. With real runs, the model waves come first and
 * the real runs follow, each part under its name.
 */
function waveOrigins(waves: readonly HandlerWave[], real: readonly HandlerWave[] | null) {
  let top = laneTop + (real === null || waves.length === 0 ? 0 : partGap);
  const stack = (wave: HandlerWave) => {
    const origin = top;
    top += waveHeight(wave.count) + innerGap;
    return origin;
  };
  const tops = waves.map(stack);
  if (real === null) return { tops, realTop: undefined };
  const realTop = top;
  top = realTop + partGap;
  return { tops: [...tops, ...real.map(stack)], realTop };
}

function shownBars(count: number) {
  return { bars: Math.min(3, count), skipped: count > 3 };
}

/** The fill of each span and the ink of a label on it. Defined in simulator.css. */
const spanFill = {
  init: 'var(--span-init)',
  get: 'var(--span-get)',
  ledger: 'var(--span-ledger)',
  parse: 'var(--span-parse)',
  put: 'var(--span-put)',
  send: 'var(--span-put)',
  wait: 'var(--span-wait)',
  store: 'var(--span-put)',
  delete: 'var(--span-delete)',
};
const spanInk: Record<keyof typeof spanFill, string> = {
  init: 'var(--span-ink-on-light)',
  get: 'var(--span-ink-on-light)',
  ledger: 'var(--span-ink-on-dark)',
  parse: 'var(--span-ink-on-light)',
  put: 'var(--span-ink-on-put)',
  send: 'var(--span-ink-on-put)',
  wait: 'var(--span-ink-on-light)',
  store: 'var(--span-ink-on-put)',
  delete: 'var(--span-ink-on-dark)',
};

interface Tip {
  x: number;
  y: number;
  align: 'start' | 'center' | 'end';
  below: boolean;
  span: Piece;
  waveCount: number;
}

/** Index of each handler lane among the scroll clips, top to bottom. */
const laneClip: Record<LaneName, number> = { inbox: 0, sources: 1, leads: 2 };

interface SpanHover {
  lane: LaneName;
  index: number;
  slot: number;
  piece: number;
  start: number;
  end: number;
  symbol: string;
  duration: number;
}

interface SpanGuide {
  startX: number;
  endX: number;
  top: number;
  height: number;
  callout: number;
  endTop: number;
  startPx: number;
  endPx: number;
  symbol: string;
  duration: number;
}

function tightMs(ms: number) {
  return `${number(Math.round(ms))}ms`;
}

/** How long a release stays up after the instant it happens, in ms. */
const releaseFadeMs = 15;

function releaseFade(time: number, at: number) {
  const elapsed = time - at;
  if (elapsed < 0 || elapsed >= releaseFadeMs) return 0;
  return 0.5 + 0.5 * Math.cos((elapsed / releaseFadeMs) * Math.PI);
}

function releaseLabel(span: Piece) {
  if (span.amount === undefined || span.unit === undefined) return null;
  const noun = span.unit === 'source' ? 'lead source' : 'lead';
  return `+${number(span.amount)} ${span.amount === 1 ? noun : `${noun}s`}`;
}

function BraceRatio({
  x,
  y,
  count,
  cap,
  countName,
  capName,
}: {
  x: number;
  y: number;
  count: number;
  cap: number;
  countName: string;
  capName: string;
}) {
  const countText = number(count);
  const capText = number(cap);
  const right = Math.max(capText.length, capName.length) * 7.4 + 8;
  const left = Math.max(countText.length, countName.length) * 7.4 + 8;
  const slash = x - right;
  return (
    <g fontFamily="IBM Plex Mono, monospace">
      <rect className="svg-backdrop" x={slash - left} y={y - 20} width={left + right} height={40} />
      <text x={slash - 6} y={y - 4} textAnchor="end" className="svg-ink" fontSize="13">
        {countText}
      </text>
      <text x={slash} y={y - 4} textAnchor="middle" className="svg-ink" fontSize="13">
        /
      </text>
      <text x={slash + 6} y={y - 4} textAnchor="start" className="svg-ink" fontSize="13">
        {capText}
      </text>
      <text x={slash - 6} y={y + 13} textAnchor="end" className="svg-ink-muted" fontSize="12">
        {countName}
      </text>
      <text x={slash} y={y + 13} textAnchor="middle" className="svg-ink-muted" fontSize="12">
        /
      </text>
      <text x={slash + 6} y={y + 13} textAnchor="start" className="svg-ink-muted" fontSize="12">
        {capName}
      </text>
    </g>
  );
}

type SpanHandler = (
  event: React.PointerEvent,
  span: Piece,
  wave: HandlerWave,
  index: number,
  slot: number,
  piece: number
) => void;

/** True when a release in this wave is still fading at `time`. Only such a wave needs the clock. */
function releasingAt(wave: HandlerWave, pieces: readonly Piece[], time: number) {
  return pieces.some((span) => span.amount !== undefined && releaseFade(time, wave.start + span.end) > 0);
}

/**
 * One wave: its bars, its dots, and its brace. It draws again only when its own props change,
 * so the playback clock redraws just the waves whose release label is fading.
 */
const WaveBars = memo(function WaveBars({
  lane,
  index,
  wave,
  origin,
  x,
  width,
  pieces,
  fadeTime,
  whole,
  cap,
  countName,
  capName,
  onSpan,
  dim = false,
}: {
  lane: string;
  index: number;
  wave: HandlerWave;
  origin: number;
  x: number;
  width: number;
  pieces: readonly Piece[];
  /** The clock, or null when no release of this wave is fading. */
  fadeTime: number | null;
  whole: boolean;
  cap: number;
  countName: string;
  capName: string;
  onSpan: SpanHandler;
  /** True for a model wave that a comparison draws behind the real runs. */
  dim?: boolean;
}) {
  const { bars, skipped } = shownBars(wave.count);
  const widths = spanWidths(
    pieces.map((span) => Math.max(0, span.end - span.start)),
    width
  );
  const top = slotY(0, origin);
  const bottom = slotY(bars - 1, origin) + barHeight;
  const mid = (top + bottom) / 2;
  const braceX = x - 28;
  return (
    <g data-wave={`${lane}-${index}`} className={dim ? 'wave-dim' : undefined}>
      <text className="wave-bar-time" x={x} y={top - 5}>
        {barDuration(wave.end - wave.start)}
      </text>
      {Array.from({ length: bars }, (_, slot) => {
        const clip = `${lane}-${index}-${slot}`;
        let spanX = x;
        const placedSpans = pieces.map((span, piece) => {
          const spanWidth = widths[piece] ?? 0;
          const gutter = pieces.length > 1 && spanWidth > 4 ? 1.5 : 0;
          const drawnX = spanX;
          spanX += spanWidth;
          return { span, piece, spanWidth, gutter, drawnX };
        });
        const rowY = slotY(slot, origin);
        return (
          <g key={slot}>
            <clipPath id={clip}>
              <rect x={x} y={rowY} width={width} height={barHeight} rx={3} />
            </clipPath>
            <g clipPath={`url(#${clip})`}>
              {placedSpans.map(({ span, piece, spanWidth, gutter, drawnX }) => {
                const label = releaseLabel(span);
                const release = label === null || fadeTime === null ? 0 : releaseFade(fadeTime, wave.start + span.end);
                const labelWidth = label === null ? 0 : label.length * 6.2 + 8;
                const showRelease = label !== null && release > 0 && spanWidth >= labelWidth;
                const ink = spanInk[span.tone];
                const spanEnd = drawnX + Math.max(0, spanWidth - gutter);
                return (
                  <g key={span.symbol + span.start}>
                    <rect
                      x={drawnX}
                      y={rowY}
                      width={Math.max(0, spanWidth - gutter)}
                      height={barHeight}
                      data-span=""
                      data-slot={slot}
                      data-piece={piece}
                      style={{ cursor: 'default', fill: spanFill[span.tone] }}
                      onPointerEnter={(event) => onSpan(event, span, wave, index, slot, piece)}
                      onPointerMove={(event) => {
                        event.stopPropagation();
                        onSpan(event, span, wave, index, slot, piece);
                      }}
                    />
                    {showRelease ? (
                      <>
                        <clipPath id={`${clip}-r-${piece}`}>
                          <rect x={drawnX} y={rowY} width={Math.max(0, spanWidth - gutter)} height={barHeight} />
                        </clipPath>
                        <text
                          className="wave-release"
                          x={spanEnd - 5}
                          y={rowY + barHeight / 2 + 3.5}
                          textAnchor="end"
                          style={{ fill: ink }}
                          opacity={release}
                          clipPath={`url(#${clip}-r-${piece})`}
                        >
                          {label}
                        </text>
                      </>
                    ) : null}
                  </g>
                );
              })}
            </g>
          </g>
        );
      })}
      {skipped &&
        [-8, 0, 8].map((offset) => (
          <circle
            key={offset}
            cx={x + Math.min(18, width * 0.35)}
            cy={(slotY(1, origin) + barHeight + slotY(2, origin)) / 2 + offset}
            r={2.4}
            className="svg-ink-2"
          />
        ))}
      {bars > 1 && (
        <>
          <path
            d={`M ${x - 8} ${top + 1} C ${braceX} ${top + 1}, ${braceX} ${mid - 12}, ${braceX - 8} ${mid} C ${braceX} ${mid + 12}, ${braceX} ${bottom - 1}, ${x - 8} ${bottom - 1}`}
            fill="none"
            className="svg-stroke"
            strokeWidth="1.6"
          />
          {whole ? (
            <BraceRatio x={braceX - 16} y={mid} count={wave.count} cap={cap} countName={countName} capName={capName} />
          ) : (
            <text
              x={braceX - 12}
              y={mid + 4}
              textAnchor="end"
              className="svg-ink"
              fontSize="13"
              fontFamily="IBM Plex Mono, monospace"
            >
              ×{number(wave.count)}
            </text>
          )}
        </>
      )}
    </g>
  );
});

/** A lane zoomed out to the swarm: every handler of the stage as one body. */
interface SwarmSummary {
  swarm: Swarm;
  cap: number;
  /** One output unit, plural, such as `sources`. */
  unit: string;
  /** Title of the output tile, such as `Sources stored`. */
  outputTitle: string;
  /** Where the output goes. */
  target: string;
  /** The output call, as `Service.method`. */
  call: string;
}

const swarmRangeY = 18;
const runTop = 48;
const runHeight = 60;
const flightTop = 140;
const flightHeight = 44;
const swarmHeight = flightTop + flightHeight + 10;
/** The range of the real swarm sits under the in-flight band, so its label never covers the model range. */
const realRangeY = swarmHeight + 12;
const realSwarmHeight = realRangeY + 10;
/** Width of one character of an 11px mono label, in view units. */
const labelChar = 6.7;

/** One step series as a filled area. The highest of `scale` and its peak touches the top of the band. */
function StepArea({
  steps,
  peak,
  scale = peak.value,
  top,
  height,
  xAt,
  right,
  tone,
  name,
  peakLabel,
  bare = false,
}: {
  steps: readonly Step[];
  peak: Peak;
  /** The value at the top of the band, when two series share it. */
  scale?: number;
  top: number;
  height: number;
  xAt: (value: number) => number;
  right: number;
  tone: string;
  name: string;
  peakLabel: string;
  /** True for a series drawn over another one: no baseline, no name, and no `none`. */
  bare?: boolean;
}) {
  const base = top + height;
  const yOf = (value: number) => base - (scale === 0 ? 0 : (value / scale) * height);
  const yAt = (value: number) => yOf(value).toFixed(2);
  let d = '';
  for (const [index, step] of steps.entries()) {
    const x = xAt(step.at).toFixed(2);
    d += index === 0 ? `M ${x} ${base} V ${yAt(step.value)}` : ` H ${x} V ${yAt(step.value)}`;
  }
  if (d) d += ` V ${base} Z`;
  const peakX = xAt(peak.at);
  const peakY = yOf(peak.value);
  const flip = peakX + 6 + peakLabel.length * labelChar > right;
  return (
    <g>
      {bare ? null : (
        <>
          <line className="svg-baseline" x1={plotLeft} x2={right} y1={base} y2={base} />
          <text className="wave-swarm-name" x={plotLeft - 12} y={top + height / 2 + 4} textAnchor="end">
            {name}
          </text>
        </>
      )}
      {d ? (
        <path d={d} style={{ fill: tone, stroke: tone }} fillOpacity={0.2} strokeWidth={1.2} strokeLinejoin="round" />
      ) : null}
      {peak.value > 0 ? (
        <>
          <circle cx={peakX} cy={peakY} r={2.6} style={{ fill: tone }} />
          <text
            className="wave-bar-time"
            x={flip ? peakX - 6 : peakX + 6}
            y={peakY - 4}
            textAnchor={flip ? 'end' : 'start'}
          >
            {peakLabel}
          </text>
        </>
      ) : bare ? null : (
        <text className="wave-bar-time" x={plotLeft} y={base - 6}>
          none
        </text>
      )}
    </g>
  );
}

/** The time from the first handler of a swarm to the end of the last, as a bracket with its length over it. */
function SwarmRange({
  body,
  y,
  xAt,
  label,
}: {
  body: Swarm;
  y: number;
  xAt: (value: number) => number;
  label: string;
}) {
  const startX = xAt(body.start);
  const endX = Math.max(startX + 1, xAt(body.end));
  return (
    <>
      <text className="wave-bar-time" x={startX} y={y - 7}>
        {label}
      </text>
      <path
        d={`M ${startX} ${y - 4} V ${y + 4} M ${startX} ${y} H ${endX} M ${endX} ${y - 4} V ${y + 4}`}
        fill="none"
        className="svg-stroke-2"
        strokeWidth="1.4"
      />
    </>
  );
}

/** The swarm on the shared clock: its span, the handlers that run at once, and the output in flight. */
const SwarmChart = memo(function SwarmChart({
  summary,
  real,
  horizon,
  plotWidth,
}: {
  summary: SwarmSummary;
  /** The swarm of the real runs, drawn over the model, or null. */
  real: Swarm | null;
  horizon: number;
  plotWidth: number;
}) {
  const { swarm: body, cap, unit } = summary;
  const xAt = (value: number) => plotLeft + (horizon === 0 ? 0 : (value / horizon) * plotWidth);
  const right = plotLeft + plotWidth + plotRight;
  if (body.handlers === 0 && (real?.handlers ?? 0) === 0) {
    return (
      <text className="wave-bar-time" x={plotLeft} y={runTop + runHeight / 2}>
        No handler runs.
      </text>
    );
  }
  const peak = body.peakRunning.value;
  const runScale = Math.max(peak, real?.peakRunning.value ?? 0);
  const flightScale = Math.max(body.peakInFlight.value, real?.peakInFlight.value ?? 0);
  const model = real === null ? '' : 'model ';
  return (
    <g>
      <g className={real === null ? undefined : 'wave-dim'}>
        {body.handlers > 0 ? (
          <SwarmRange body={body} y={swarmRangeY} xAt={xAt} label={`${model}${barDuration(body.end - body.start)}`} />
        ) : null}
        <StepArea
          steps={body.running}
          peak={body.peakRunning}
          scale={runScale}
          top={runTop}
          height={runHeight}
          xAt={xAt}
          right={right}
          tone="var(--sim-tone-email)"
          name="handlers"
          peakLabel={`${model}peak ${number(peak)} · cap ${number(cap)}`}
        />
        <StepArea
          steps={body.inFlight}
          peak={body.peakInFlight}
          scale={flightScale}
          top={flightTop}
          height={flightHeight}
          xAt={xAt}
          right={right}
          tone={spanFill.put}
          name={`${unit} in flight`}
          peakLabel={`${model}peak ${number(body.peakInFlight.value)}`}
        />
      </g>
      {real !== null && real.handlers > 0 ? (
        <g>
          <SwarmRange body={real} y={realRangeY} xAt={xAt} label={`real ${barDuration(real.end - real.start)}`} />
          <StepArea
            steps={real.running}
            peak={real.peakRunning}
            scale={runScale}
            top={runTop}
            height={runHeight}
            xAt={xAt}
            right={right}
            tone="var(--sim-real)"
            name="handlers"
            peakLabel={`real peak ${number(real.peakRunning.value)}`}
            bare
          />
          <StepArea
            steps={real.inFlight}
            peak={real.peakInFlight}
            scale={flightScale}
            top={flightTop}
            height={flightHeight}
            xAt={xAt}
            right={right}
            tone="var(--sim-real)"
            name={`${unit} in flight`}
            peakLabel={`real peak ${number(real.peakInFlight.value)}`}
            bare
          />
        </g>
      ) : null}
    </g>
  );
});

function SwarmTiles({ summary, real, time }: { summary: SwarmSummary; real: Swarm | null; time: number }) {
  const { swarm: body, cap, unit, outputTitle, target, call } = summary;
  const calls = body.peakCalls.value;
  /** The real value under the model value of a tile, when a comparison is on. */
  const realLine = (text: string) => (real === null ? null : <span className="swarm-tile-real">real {text}</span>);
  return (
    <dl className={`swarm-tiles${real === null ? '' : ' swarm-tiles-compared'}`}>
      <div>
        <dt>Swarm time</dt>
        <dd>{barDuration(body.end - body.start)}</dd>
        <span>
          {tightMs(body.start)} to {tightMs(body.end)} on the clock
        </span>
        {real && realLine(`${barDuration(real.end - real.start)}, ${tightMs(real.start)} to ${tightMs(real.end)}`)}
      </div>
      <div>
        <dt>Peak handlers</dt>
        <dd>{number(body.peakRunning.value)}</dd>
        <span>
          of a cap of {number(cap)} · {number(valueAt(body.running, time))} now
        </span>
        {real && realLine(`${number(real.peakRunning.value)} · ${number(valueAt(real.running, time))} now`)}
      </div>
      <div>
        <dt>{outputTitle}</dt>
        <dd>{number(body.output)}</dd>
        <span>
          {target} by {number(body.handlers)} {body.handlers === 1 ? 'handler' : 'handlers'}
        </span>
        {real && realLine(`${number(real.output)} by ${number(real.handlers)} ${real.handlers === 1 ? 'run' : 'runs'}`)}
      </div>
      <div>
        <dt>Peak in flight</dt>
        <dd>{number(body.peakInFlight.value)}</dd>
        <span>
          {unit} in {number(calls)} <code>{call}</code> {calls === 1 ? 'call' : 'calls'} at most ·{' '}
          {number(valueAt(body.inFlight, time))} now
        </span>
        {real && realLine(`${number(real.peakInFlight.value)} · ${number(valueAt(real.inFlight, time))} now`)}
      </div>
    </dl>
  );
}

/** Screen heights of overscan above and below the visible part of a lane. Rows outside are not drawn. */
const overscanScreens = 1;

function HandlerPlot({
  lane,
  model,
  hiddenNote,
  emptyName,
  horizon,
  time,
  onTime,
  brace,
  plotWidth,
  clipRef,
  onScroll,
  onPanStart,
  onPanMove,
  onPanEnd,
  onHover,
  summary,
  real,
}: {
  lane: LaneName;
  model: Lane;
  hiddenNote: string;
  /** The name of the one range of a handler whose every timing is 0 ms. */
  emptyName: string;
  horizon: number;
  time: number;
  onTime: (time: number) => void;
  brace: { countName: string; capName: string };
  plotWidth: number;
  clipRef: (node: HTMLDivElement | null) => void;
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  onPanStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPanMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPanEnd: () => boolean;
  onHover: (hover: SpanHover | null) => void;
  /** The swarm to draw in place of the waves, or null to draw each wave. */
  summary: SwarmSummary | null;
  /** The lane of the real runs, drawn under the dim model waves, or null without a comparison. */
  real: Lane | null;
}) {
  const hidden = model.hidden;
  const svg = useRef<SVGSVGElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const layout = useMemo(() => {
    const rows = real === null ? model.rows : [...model.rows, ...real.rows];
    const { tops, realTop } = waveOrigins(
      model.rows.map(({ wave }) => wave),
      real === null ? null : real.rows.map(({ wave }) => wave)
    );
    const bottoms = rows.map(({ wave }, index) => (tops[index] ?? laneTop) + waveHeight(wave.count));
    return { rows, tops, bottoms, realTop };
  }, [model, real]);
  const lastBottom = layout.bottoms[layout.bottoms.length - 1];
  const laneBottom = (lastBottom ?? laneTop + barHeight) + 12;
  const viewHeight = summary ? (real === null ? swarmHeight : realSwarmHeight) : laneBottom + 8;
  const svgWidth = plotLeft + plotWidth + plotRight;
  const [band, setBand] = useState({ first: 0, last: -1 });
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const node = svg.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) return;
      const scale = rect.width / svgWidth;
      const margin = window.innerHeight * overscanScreens;
      const next = rowsInBand(
        layout.tops,
        layout.bottoms,
        (-rect.top - margin) / scale,
        (window.innerHeight - rect.top + margin) / scale
      );
      setBand((current) => (current.first === next.first && current.last === next.last ? current : next));
    };
    const later = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    // Tables and lanes above this one can change height without a scroll.
    const observer = new ResizeObserver(later);
    observer.observe(document.body);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
    };
  }, [layout, svgWidth]);
  const xAt = (value: number) => plotLeft + (horizon === 0 ? 0 : (value / horizon) * plotWidth);
  const seek = (clientX: number) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || horizon === 0) return;
    const viewX = ((clientX - rect.left) / rect.width) * svgWidth;
    const next = ((viewX - plotLeft) / plotWidth) * horizon;
    onTime(Math.min(horizon, Math.max(0, next)));
  };
  const clearTip = () => {
    setTip(null);
    onHover(null);
  };
  const showTip = useCallback<SpanHandler>(
    (event, span, wave, index, slot, piece) => {
      const box = plot.current?.getBoundingClientRect();
      if (!box) return;
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      setTip({
        x,
        y,
        align: x < 140 ? 'start' : x > box.width - 140 ? 'end' : 'center',
        below: y < box.height * 0.55,
        span,
        waveCount: wave.count,
      });
      onHover({
        lane,
        index,
        slot,
        piece,
        start: wave.start + span.start,
        end: wave.start + span.end,
        symbol: span.symbol,
        duration: span.end - span.start,
      });
    },
    [lane, onHover]
  );
  /** The one range of a handler whose every timing is 0 ms, so that its wave still has a bar. */
  const empty = useMemo<readonly Piece[]>(
    () => [
      { tone: 'get', symbol: 't', name: emptyName, start: 0, end: 0, detail: 'Every timing on this handler is 0 ms.' },
    ],
    [emptyName]
  );
  const drawn: React.ReactNode[] = [];
  if (real !== null && summary === null) {
    if (model.rows.length > 0) {
      drawn.push(
        <text key="model" className="wave-part-name" x={8} y={laneTop + 6}>
          Model
        </text>
      );
    }
    drawn.push(
      <text key="real" className="wave-part-name wave-part-real" x={8} y={(layout.realTop ?? laneTop) + 6}>
        Real · {number(real.pool.waves.length)} {real.pool.waves.length === 1 ? 'run' : 'runs'}
      </text>
    );
  }
  const last = summary ? -1 : Math.min(band.last, layout.rows.length - 1);
  for (let index = Math.max(0, band.first); index <= last; index++) {
    const { wave, pieces: own } = layout.rows[index]!;
    const owner = index < model.rows.length || real === null ? model : real;
    const pieces = own.length > 0 ? own : empty;
    drawn.push(
      <WaveBars
        key={`${lane}-${index}`}
        lane={lane}
        index={index}
        wave={wave}
        origin={layout.tops[index] ?? laneTop}
        x={xAt(wave.start)}
        width={barWidthOnAxis(wave.start, wave.end, horizon, plotWidth)}
        pieces={pieces}
        fadeTime={releasingAt(wave, pieces, time) ? time : null}
        whole={isWhole(owner, wave)}
        cap={model.cap}
        countName={brace.countName}
        capName={brace.capName}
        onSpan={showTip}
        dim={owner === model && real !== null}
      />
    );
  }
  return (
    <div className="wave-plot" ref={plot} onPointerLeave={clearTip}>
      {summary ? <SwarmTiles summary={summary} real={real?.swarm ?? null} time={time} /> : null}
      {hidden > 0 && summary === null ? <p className="wave-hidden">{hiddenNote}</p> : null}
      {hidden > 0 && summary === null && real === null ? null : (
        <div
          className="wave-plot-clip"
          ref={clipRef}
          onScroll={onScroll}
          onPointerDown={(event) => {
            clearTip();
            onPanStart(event);
          }}
          onPointerMove={onPanMove}
          onPointerUp={(event) => {
            if (onPanEnd()) return;
            if (event.target === event.currentTarget && event.nativeEvent.offsetY >= event.currentTarget.clientHeight)
              return;
            seek(event.clientX);
          }}
          onPointerCancel={onPanEnd}
        >
          <div className="wave-shift" style={{ width: `${(svgWidth / viewWidth) * 100}%` }}>
            <svg
              ref={svg}
              viewBox={`0 0 ${svgWidth} ${viewHeight}`}
              aria-hidden="true"
              onPointerMove={(event) => {
                const target = event.target as Element;
                if (!target.closest('[data-span]')) clearTip();
              }}
            >
              {summary ? (
                <SwarmChart summary={summary} real={real?.swarm ?? null} horizon={horizon} plotWidth={plotWidth} />
              ) : (
                drawn
              )}
            </svg>
          </div>
        </div>
      )}
      {tip && (
        <div
          className={`wave-tip wave-tip-${tip.align}${tip.below ? ' wave-tip-below' : ''}`}
          style={{ left: tip.x, top: tip.y }}
        >
          <strong>
            <i style={{ background: spanFill[tip.span.tone] }} />
            {tip.span.name}
          </strong>
          {tip.span.call && tip.span.call !== tip.span.name ? <span>{tip.span.call}</span> : null}
          <p>
            {tip.span.amount === undefined
              ? tip.span.detail
              : `${tip.span.detail} This handler releases ${number(tip.span.amount)} ${
                  tip.span.amount === 1 ? tip.span.unit : `${tip.span.unit}s`
                }.${
                  tip.waveCount > 1
                    ? ` The ${number(tip.waveCount)} handlers release ${number(tip.waveCount * tip.span.amount)} together.`
                    : ''
                }`}
          </p>
        </div>
      )}
    </div>
  );
}

function axisTicks(start: number, end: number) {
  const span = end - start;
  if (!(span > 0)) return [Math.max(0, start)];
  const rough = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / magnitude;
  const nice = fraction >= 7.5 ? 10 : fraction >= 3.5 ? 5 : fraction >= 1.5 ? 2 : 1;
  const step = nice * magnitude;
  const first = Math.max(0, Math.ceil((start - step * 1e-6) / step) * step);
  const ticks: number[] = [];
  for (let tick = first; tick <= end + step * 1e-6 && ticks.length < 8; tick += step) ticks.push(tick);
  return ticks;
}

function LaneChevron() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4 2.5 7.5 6 4 9.5" />
    </svg>
  );
}

/** The lane title. A click zooms the lane out to its swarm, or back in to each wave. */
function LaneToggle({ title, open, toggle }: { title: string; open: boolean; toggle: () => void }) {
  return (
    <button
      type="button"
      className="wave-lane-toggle"
      aria-expanded={open}
      title={open ? 'Zoom out to the swarm' : 'Show each wave'}
      onClick={toggle}
    >
      <LaneChevron />
      <strong>{title}</strong>
    </button>
  );
}

function sourceCaption(input: SliceInputs) {
  const batches = sourceBatches(input);
  if (batches === 0) return 'no sends';
  return `${number(batches)} ${batches === 1 ? 'batch' : 'batches'} of ${leadBatchSize} each`;
}

function leadCaption(input: SliceInputs) {
  const leads = leadsPerHandler(input);
  const stores = leadStoreWaves(input, leads);
  return `${number(leads)} ${leads === 1 ? 'lead' : 'leads'} · ${number(stores)} ${stores === 1 ? 'store wave' : 'store waves'} each`;
}

const ratio = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

/** A queue as a tank. With a comparison, the model fill is dim and the real fill is in front of it. */
function TankVessel({ model, real }: { model: number; real: number | null }) {
  return (
    <div className="source-tank-vessel" aria-hidden="true">
      <div
        className={`source-tank-fill${real === null ? '' : ' source-tank-model'}`}
        style={{ height: `${model * 100}%` }}
      />
      {real === null ? null : (
        <div className="source-tank-fill source-tank-real" style={{ height: `${real * 100}%` }} />
      )}
    </div>
  );
}

/** The count of a tank. With a comparison, the count is the real estimate and the model count follows it. */
function TankCount({ model, real, text }: { model: number; real: number | null; text: string }) {
  return (
    <p>
      <strong>{number(real ?? model)}</strong>
      <span>{text}</span>
      {real === null ? null : (
        <span className="source-tank-model-count">model {number(model)} · real is an estimate</span>
      )}
    </p>
  );
}

export function InboxLanes({
  simulation,
  horizon,
  time,
  onTime,
  real = null,
}: {
  simulation: Simulation;
  /** The end of the last wave of the model or of the real runs. */
  horizon: number;
  time: number;
  onTime: (time: number) => void;
  /** The real runs of one request, drawn with the model, or null. */
  real?: Comparison | null;
}) {
  const { knobs: input, lanes } = simulation;
  const realLanes = real?.lanes ?? null;
  /** The lanes that give the count of each queue: the real ones with a comparison. */
  const counted = realLanes ?? lanes;
  const emails = waitingAt(lanes.inbox, time);
  const depth = waitingAt(lanes.sources, time);
  const arrival = arrivalNear(lanes.sources, time, releaseFadeMs);
  const arrivalOpacity = arrival ? releaseFade(time, arrival.at) : 0;
  const leadDepth = waitingAt(lanes.leads, time);
  const leadArrival = arrivalNear(lanes.leads, time, releaseFadeMs);
  const leadArrivalOpacity = leadArrival ? releaseFade(time, leadArrival.at) : 0;
  /** The part of its queue that waits at the cursor. */
  const fillOf = (lane: Lane) => ratio(waitingAt(lane, time), lane.total);
  // A comparison opens each wave, because a real run is one bar.
  const [zoomedOut, setZoomedOut] = useState<Record<LaneName, boolean>>(() => {
    const swarmed = real === null;
    return { inbox: swarmed, sources: swarmed, leads: swarmed };
  });
  const toggleLane = (lane: LaneName) => setZoomedOut((current) => ({ ...current, [lane]: !current[lane] }));
  const inboxSummary = useMemo<SwarmSummary | null>(
    () =>
      zoomedOut.inbox
        ? {
            swarm: lanes.inbox.swarm,
            cap: lanes.inbox.cap,
            unit: 'sources',
            outputTitle: 'Sources stored',
            target: 'to the sources bucket',
            call: 'Storage.store',
          }
        : null,
    [zoomedOut.inbox, lanes.inbox]
  );
  const sourceSummary = useMemo<SwarmSummary | null>(
    () =>
      zoomedOut.sources
        ? {
            swarm: lanes.sources.swarm,
            cap: lanes.sources.cap,
            unit: 'leads',
            outputTitle: 'Leads pushed',
            target: 'to the leads queue',
            call: 'Queue.pushBatch',
          }
        : null,
    [zoomedOut.sources, lanes.sources]
  );
  const leadSummary = useMemo<SwarmSummary | null>(
    () =>
      zoomedOut.leads
        ? {
            swarm: lanes.leads.swarm,
            cap: lanes.leads.cap,
            unit: 'leads',
            outputTitle: 'Leads stored',
            target: 'as orders',
            call: 'OrderRepository.store',
          }
        : null,
    [zoomedOut.leads, lanes.leads]
  );
  const [zoom, setZoom] = useState(minZoom);
  const zoomLive = useRef(minZoom);
  const plotWidth = plotWidthAtZoom(viewWidth - plotLeft - plotRight, zoom);
  const zoomAnchor = useRef<{ time: number; px: number } | null>(null);
  const fitting = useRef(false);
  const svgWidth = plotLeft + plotWidth + plotRight;
  const board = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const clips = useRef<Array<HTMLDivElement | null>>([null, null, null]);
  const dragging = useRef(false);
  const pointer = useRef<{ x: number; scroll: number } | null>(null);
  const thumb = useRef<{ x: number; scroll: number } | null>(null);
  const cursorDrag = useRef(false);
  const syncing = useRef(false);
  const [scroll, setScroll] = useState(0);
  const scrollLive = useRef(0);
  const [spanHover, setSpanHover] = useState<SpanHover | null>(null);
  const [guide, setGuide] = useState<SpanGuide | null>(null);
  const [cursorLine, setCursorLine] = useState<{ left: number; top: number; height: number } | null>(null);
  const [trackedWidth, setTrackedWidth] = useState(svgWidth);
  const [viewport, setViewport] = useState(0);
  const [trackWidth, setTrackWidth] = useState(0);
  const [content, setContent] = useState(0);
  if (trackedWidth !== svgWidth) setTrackedWidth(svgWidth);
  const applyScroll = (left: number) => {
    syncing.current = true;
    for (const clip of clips.current) {
      if (clip) clip.scrollLeft = left;
    }
    syncing.current = false;
  };
  const writeScroll = (left: number) => {
    const clip = clips.current.find((item) => item !== null);
    const max = clip ? Math.max(0, clip.scrollWidth - clip.clientWidth) : 0;
    const next = Math.min(max, Math.max(0, left));
    applyScroll(next);
    scrollLive.current = next;
    setScroll(next);
  };
  const timeAt = (px: number) => timeUnderPointer(scroll, px, content, svgWidth, plotWidth, horizon, plotLeft);
  const zoomAbout = (next: number, px: number) => {
    if (next === zoomLive.current) return;
    const clip = clips.current.find((item) => item !== null);
    const width = clip?.scrollWidth ?? 0;
    const left = clip?.scrollLeft ?? scroll;
    const time = timeUnderPointer(left, px, width, svgWidth, plotWidth, horizon, plotLeft);
    fitting.current = false;
    zoomAnchor.current = { time, px };
    zoomLive.current = next;
    setZoom(next);
  };
  const zoomBy = (direction: 1 | -1) => {
    const clip = clips.current.find((item) => item !== null);
    zoomAbout(nextZoom(zoom, direction), clip ? clip.clientWidth / 2 : 0);
  };
  const fit = () => {
    zoomAnchor.current = null;
    if (zoomLive.current === minZoom) {
      writeScroll(0);
      return;
    }
    fitting.current = true;
    zoomLive.current = minZoom;
    setZoom(minZoom);
  };
  const horizonSeen = useRef(horizon);
  useLayoutEffect(() => {
    if (horizonSeen.current !== horizon) {
      horizonSeen.current = horizon;
      zoomAnchor.current = null;
      fitting.current = false;
      writeScroll(0);
      return;
    }
    if (fitting.current) {
      fitting.current = false;
      writeScroll(0);
      return;
    }
    const place = zoomAnchor.current;
    const clip = clips.current.find((item) => item !== null);
    if (!place || !clip || clip.clientWidth === 0) return;
    zoomAnchor.current = null;
    writeScroll(scrollHoldingTime(place.time, place.px, clip.scrollWidth, svgWidth, plotWidth, horizon, plotLeft));
  }, [zoom, plotWidth, svgWidth, horizon]);
  useEffect(() => {
    const clip = board.current?.querySelector('.wave-plot-clip');
    const ruler = board.current?.querySelector('.wave-ruler-track');
    if (!(clip instanceof HTMLElement)) return;
    const measure = () => {
      setViewport(clip.clientWidth);
      setContent(clip.scrollWidth);
      if (ruler instanceof HTMLElement) setTrackWidth(ruler.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(clip);
    if (ruler instanceof HTMLElement) observer.observe(ruler);
    const frame = requestAnimationFrame(measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [svgWidth, zoomedOut]);
  // A lane that comes back from the hidden note mounts a new clip at scroll 0.
  useLayoutEffect(() => {
    applyScroll(scrollLive.current);
  }, [zoomedOut]);
  useEffect(() => {
    const node = board.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      const clip = clips.current.find((item) => item !== null);
      if (!clip || event.deltaY === 0) return;
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.wave-plot, .wave-ruler-track, .wave-ruler-labels')
      )
        return;
      event.preventDefault();
      const px = event.clientX - clip.getBoundingClientRect().left;
      zoomAbout(zoomAtWheel(zoomLive.current, event.deltaY, event.deltaMode), px);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  });
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (syncing.current) return;
    writeScroll(event.currentTarget.scrollLeft);
  };
  const pxAt = (ms: number) =>
    horizon === 0 || content === 0 ? 0 : scrollHoldingTime(ms, scroll, content, svgWidth, plotWidth, horizon, plotLeft);
  const maxScroll = Math.max(0, content - viewport);
  const thumbWidth = viewport === 0 || content <= viewport ? viewport : Math.max(28, (viewport / content) * viewport);
  const travel = Math.max(0, viewport - thumbWidth);
  const thumbLeft = maxScroll === 0 || travel === 0 ? 0 : (scroll / maxScroll) * travel;
  const labels = (() => {
    if (viewport === 0) return [];
    const ticks = axisTicks(Math.max(0, timeAt(0)), Math.min(horizon, Math.max(0, timeAt(viewport))));
    const placed: { tick: number; px: number }[] = [];
    for (const tick of ticks) {
      const px = pxAt(tick);
      const previous = placed[placed.length - 1];
      if (previous && px > viewport - 80 && px - previous.px < 100) placed.pop();
      placed.push({ tick, px });
    }
    return placed;
  })();
  const cursorPx = pxAt(time);
  useLayoutEffect(() => {
    const boardEl = board.current;
    if (!boardEl) return;
    const place = () => {
      const clip = clips.current.find((item) => item !== null);
      const lanes = boardEl.querySelectorAll('.wave-lane');
      const first = lanes[0];
      const last = lanes[lanes.length - 1];
      const width = clip?.clientWidth ?? 0;
      if (!clip || !first || !last || width === 0 || cursorPx < 0 || cursorPx > width) {
        setCursorLine((current) => (current === null ? current : null));
        return;
      }
      const boardRect = boardEl.getBoundingClientRect();
      const clipRect = clip.getBoundingClientRect();
      const firstRect = first.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      const next = {
        left: clipRect.left - boardRect.left + cursorPx,
        top: firstRect.top - boardRect.top,
        height: lastRect.bottom - firstRect.top,
      };
      setCursorLine((current) =>
        current && current.left === next.left && current.top === next.top && current.height === next.height
          ? current
          : next
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(boardEl);
    return () => observer.disconnect();
  }, [cursorPx]);
  const labelAlign = (px: number) => (px < 64 ? 'start' : px > viewport - 80 ? 'end' : 'middle');
  useLayoutEffect(() => {
    const hover = spanHover;
    const axis = track.current;
    if (!hover || !axis) {
      setGuide(null);
      return;
    }
    const place = () => {
      const node = board.current?.querySelector(`[data-wave="${hover.lane}-${hover.index}"]`);
      const current = clips.current[laneClip[hover.lane]] ?? null;
      const piece = node?.querySelector(`[data-slot="${hover.slot}"][data-piece="${hover.piece}"]`);
      const labels = axis.parentElement?.querySelector('.wave-ruler-labels');
      if (!current || !(piece instanceof Element) || !(labels instanceof HTMLElement)) {
        setGuide(null);
        return;
      }
      const bar = piece.getBoundingClientRect();
      const axisRect = axis.getBoundingClientRect();
      const clipRect = current.getBoundingClientRect();
      const labelsLeft = labels.getBoundingClientRect().left;
      const offscreen = bar.right < clipRect.left || bar.left > clipRect.right;
      if (bar.top <= axisRect.bottom + 1 || offscreen) {
        setGuide(null);
        return;
      }
      const gap = bar.top - axisRect.bottom;
      const next: SpanGuide = {
        startX: bar.left,
        endX: bar.right,
        top: axisRect.bottom,
        height: gap,
        callout: gap >= 40 ? 34 : 0,
        endTop: axisRect.top,
        startPx: bar.left - labelsLeft,
        endPx: bar.right - labelsLeft,
        symbol: hover.symbol,
        duration: hover.duration,
      };
      setGuide((currentGuide) =>
        currentGuide &&
        currentGuide.startX === next.startX &&
        currentGuide.endX === next.endX &&
        currentGuide.top === next.top &&
        currentGuide.height === next.height &&
        currentGuide.callout === next.callout &&
        currentGuide.endTop === next.endTop &&
        currentGuide.startPx === next.startPx &&
        currentGuide.endPx === next.endPx &&
        currentGuide.symbol === next.symbol &&
        currentGuide.duration === next.duration
          ? currentGuide
          : next
      );
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [spanHover, scroll, content, plotWidth, horizon, svgWidth]);
  const onPanStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.nativeEvent.offsetY >= event.currentTarget.clientHeight) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { x: event.clientX, scroll: event.currentTarget.scrollLeft };
    dragging.current = false;
  };
  const onPanMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const origin = pointer.current;
    if (!origin) return;
    const dx = event.clientX - origin.x;
    if (!dragging.current && Math.abs(dx) < 6) return;
    dragging.current = true;
    const max = event.currentTarget.scrollWidth - event.currentTarget.clientWidth;
    writeScroll(Math.min(max, Math.max(0, origin.scroll - dx)));
  };
  const onPanEnd = () => {
    const dragged = dragging.current;
    pointer.current = null;
    dragging.current = false;
    return dragged;
  };
  const bar = trackWidth || viewport;
  const cursorBound = (px: number, width: number) => {
    if (width <= handleRadius * 2) return width / 2;
    return Math.min(width - handleRadius, Math.max(handleRadius, px));
  };
  const viewStart = timeAt(0);
  const viewEnd = viewport === 0 ? viewStart : timeAt(viewport);
  const cursorOnRuler = bar > 0 && cursorPx >= 0 && cursorPx <= bar && viewEnd > viewStart;
  const cursorLeft = cursorBound(cursorPx, bar);
  const seekOnRuler = (clientX: number) => {
    const node = track.current;
    if (!node || horizon === 0) return;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = cursorBound(clientX - rect.left, rect.width);
    onTime(Math.min(horizon, Math.max(0, timeAt(px))));
  };
  const nudgeCursor = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (horizon === 0 || bar === 0) return;
    const start = Math.max(0, timeAt(cursorBound(0, bar)));
    const end = Math.min(horizon, Math.max(start, timeAt(cursorBound(bar, bar))));
    if (end <= start) return;
    const step = (end - start) / 40;
    let next = time;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = time + step;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = time - step;
    else if (event.key === 'Home') next = start;
    else if (event.key === 'End') next = end;
    else return;
    event.preventDefault();
    onTime(Math.min(end, Math.max(start, next)));
  };
  const onHover = useCallback((hover: SpanHover | null) => {
    setSpanHover((current) => {
      if (hover === null) return current === null ? current : null;
      if (
        current?.lane === hover.lane &&
        current.index === hover.index &&
        current.slot === hover.slot &&
        current.piece === hover.piece &&
        current.start === hover.start &&
        current.end === hover.end
      )
        return current;
      return hover;
    });
  }, []);
  const setInboxClip = useCallback((node: HTMLDivElement | null) => {
    clips.current[0] = node;
  }, []);
  const setSourceClip = useCallback((node: HTMLDivElement | null) => {
    clips.current[1] = node;
  }, []);
  const setLeadClip = useCallback((node: HTMLDivElement | null) => {
    clips.current[2] = node;
  }, []);
  return (
    <div className="wave-board" id="wave-axis" ref={board}>
      {cursorLine ? (
        <div
          className="wave-cursor"
          style={{ left: cursorLine.left, top: cursorLine.top, height: cursorLine.height }}
        />
      ) : null}
      {guide ? (
        <>
          {guide.callout > 0 && guide.endX - guide.startX >= 8 ? (
            <div
              className="wave-span-callout"
              style={{ left: guide.startX, top: guide.top, width: guide.endX - guide.startX, height: guide.callout }}
            >
              {guide.endX - guide.startX >= 88 ? (
                <>
                  <span>{guide.symbol}</span>
                  <b>{tightMs(guide.duration)}</b>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="wave-start-guide" style={{ left: guide.startX, top: guide.top, height: guide.height }} />
          <div
            className="wave-end-guide"
            style={{ left: guide.endX, top: guide.endTop, height: guide.top + guide.height - guide.endTop }}
          />
        </>
      ) : null}
      <div className="wave-ruler">
        <div className="wave-zoom">
          <div className="zoom-controls">
            <button aria-label="Zoom out" disabled={zoom === minZoom} onClick={() => zoomBy(-1)}>
              −
            </button>
            <span>{formatZoom(zoom)}</span>
            <button aria-label="Zoom in" disabled={zoom === maxZoom} onClick={() => zoomBy(1)}>
              +
            </button>
            <button className="fit-button" onClick={fit}>
              Fit
            </button>
          </div>
        </div>
        <div>
          <div className="wave-ruler-labels">
            {labels.map(({ tick, px }) => {
              const align = px < 64 ? 'start' : px > viewport - 80 ? 'end' : 'middle';
              return (
                <span key={tick} className={`wave-ruler-tick wave-ruler-tick-${align}`} style={{ left: px }}>
                  {number(Math.max(0, Math.round(tick)))} ms
                </span>
              );
            })}
            {guide && guide.startPx >= 0 && guide.startPx <= viewport ? (
              <span
                className={`wave-ruler-tick wave-ruler-start wave-ruler-tick-${labelAlign(guide.startPx)}`}
                style={{ left: guide.startPx }}
              >
                {number(Math.max(0, Math.round(spanHover?.start ?? 0)))} ms
              </span>
            ) : null}
            {guide && guide.endPx >= 0 && guide.endPx <= viewport ? (
              <span
                className={`wave-ruler-tick wave-ruler-end wave-ruler-tick-${labelAlign(guide.endPx)}`}
                style={{ left: guide.endPx }}
              >
                {tightMs(Math.max(0, spanHover?.end ?? 0))}
              </span>
            ) : null}
          </div>
          <div
            className="wave-ruler-track"
            ref={track}
            role="scrollbar"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, Math.round(horizon))}
            aria-valuenow={Math.max(0, Math.round(timeAt(0)))}
            aria-label="Time axis"
            aria-controls="wave-axis"
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget || viewport === 0) return;
              const rect = event.currentTarget.getBoundingClientRect();
              writeScroll(((event.clientX - rect.left) / rect.width) * content - viewport / 2);
            }}
          >
            {guide && guide.startPx >= 0 && guide.startPx <= viewport ? (
              <i className="wave-ruler-start-mark" style={{ left: guide.startPx }} />
            ) : null}
            <div
              className="wave-ruler-thumb"
              style={{ width: thumbWidth, transform: `translateX(${thumbLeft}px)` }}
              onPointerDown={(event) => {
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                thumb.current = { x: event.clientX, scroll };
              }}
              onPointerMove={(event) => {
                const origin = thumb.current;
                if (!origin || travel === 0) return;
                writeScroll(origin.scroll + ((event.clientX - origin.x) / travel) * maxScroll);
              }}
              onPointerUp={() => {
                thumb.current = null;
              }}
              onPointerCancel={() => {
                thumb.current = null;
              }}
            />
            {cursorOnRuler ? (
              <button
                type="button"
                className="wave-ruler-handle"
                style={{ left: cursorLeft }}
                aria-label={`Timeline cursor, ${(time / 1000).toFixed(3)} s`}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  cursorDrag.current = true;
                  event.currentTarget.focus();
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // A pointer that is already gone cannot be captured.
                  }
                }}
                onPointerMove={(event) => {
                  if (!cursorDrag.current) return;
                  seekOnRuler(event.clientX);
                }}
                onPointerUp={() => {
                  cursorDrag.current = false;
                }}
                onPointerCancel={() => {
                  cursorDrag.current = false;
                }}
                onKeyDown={nudgeCursor}
              />
            ) : null}
          </div>
        </div>
      </div>
      <div className="wave-lane">
        <div className="wave-lane-label">
          <span>01</span>
          <strong>Email Queue</strong>
          <em>waiting</em>
        </div>
        <div className="source-tank email-tank" aria-live="polite">
          <TankVessel model={fillOf(lanes.inbox)} real={realLanes === null ? null : fillOf(realLanes.inbox)} />
          <TankCount
            model={emails}
            real={realLanes === null ? null : waitingAt(realLanes.inbox, time)}
            text={`of ${number(counted.inbox.total)} emails waiting`}
          />
        </div>
      </div>
      <div className="wave-lane">
        <div className="wave-lane-label wave-lane-label-top">
          <div className="wave-lane-head">
            <span>02</span>
            <LaneToggle title="Inbox handler" open={!zoomedOut.inbox} toggle={() => toggleLane('inbox')} />
            <em>{inboxPutWaves(input) === 1 ? '1 put each' : `${inboxPutWaves(input)} puts each`}</em>
          </div>
        </div>
        <HandlerPlot
          lane="inbox"
          model={lanes.inbox}
          hiddenNote={`${number(lanes.inbox.hidden)} inbox waves is too many to draw. Raise the stage cap or lower the email count. The tanks still follow the cursor.`}
          emptyName="Inbox"
          horizon={horizon}
          time={time}
          onTime={onTime}
          brace={{ countName: 'E', capName: 'E_q_c' }}
          plotWidth={plotWidth}
          clipRef={setInboxClip}
          onScroll={onScroll}
          onPanStart={onPanStart}
          onPanMove={onPanMove}
          onPanEnd={onPanEnd}
          onHover={onHover}
          summary={inboxSummary}
          real={realLanes?.inbox ?? null}
        />
      </div>
      <div className="wave-lane">
        <div className="wave-lane-label">
          <span>03</span>
          <strong>Source Queue</strong>
          <em>waiting</em>
        </div>
        <div className="source-tank" aria-live="polite">
          <TankVessel model={fillOf(lanes.sources)} real={realLanes === null ? null : fillOf(realLanes.sources)} />
          {arrival && arrivalOpacity > 0 && real === null ? (
            <em className="source-tank-arrival" style={{ opacity: arrivalOpacity }}>
              +{number(arrival.amount)}
            </em>
          ) : null}
          <TankCount
            model={depth}
            real={realLanes === null ? null : waitingAt(realLanes.sources, time)}
            text={`of ${number(counted.sources.total)} sources waiting`}
          />
        </div>
      </div>
      <div className="wave-lane">
        <div className="wave-lane-label wave-lane-label-top">
          <div className="wave-lane-head">
            <span>04</span>
            <LaneToggle title="Source handler" open={!zoomedOut.sources} toggle={() => toggleLane('sources')} />
            <em>{sourceCaption(input)}</em>
          </div>
        </div>
        <HandlerPlot
          lane="sources"
          model={lanes.sources}
          hiddenNote={`${number(lanes.sources.hidden)} source waves is too many to draw. Raise the stage cap or lower the source count. The tanks still follow the cursor.`}
          emptyName="Source"
          horizon={horizon}
          time={time}
          onTime={onTime}
          brace={{ countName: 'E×S', capName: 'S_q_c' }}
          plotWidth={plotWidth}
          clipRef={setSourceClip}
          onScroll={onScroll}
          onPanStart={onPanStart}
          onPanMove={onPanMove}
          onPanEnd={onPanEnd}
          onHover={onHover}
          summary={sourceSummary}
          real={realLanes?.sources ?? null}
        />
      </div>
      <div className="wave-lane">
        <div className="wave-lane-label">
          <span>05</span>
          <strong>Lead Queue</strong>
          <em>waiting</em>
        </div>
        <div className="source-tank" aria-live="polite">
          <TankVessel model={fillOf(lanes.leads)} real={realLanes === null ? null : fillOf(realLanes.leads)} />
          {leadArrival && leadArrivalOpacity > 0 && real === null ? (
            <em className="source-tank-arrival" style={{ opacity: leadArrivalOpacity }}>
              +{number(leadArrival.amount)}
            </em>
          ) : null}
          <TankCount
            model={leadDepth}
            real={realLanes === null ? null : waitingAt(realLanes.leads, time)}
            text={`of ${number(counted.leads.total)} leads waiting`}
          />
        </div>
      </div>
      <div className="wave-lane">
        <div className="wave-lane-label wave-lane-label-top">
          <div className="wave-lane-head">
            <span>06</span>
            <LaneToggle title="Lead handler" open={!zoomedOut.leads} toggle={() => toggleLane('leads')} />
            <em>{leadCaption(input)}</em>
          </div>
        </div>
        <HandlerPlot
          lane="leads"
          model={lanes.leads}
          hiddenNote={`${number(lanes.leads.hidden)} lead waves is too many to draw. Raise the stage cap, raise the batch, or lower the lead count. The tanks still follow the cursor.`}
          emptyName="Lead"
          horizon={horizon}
          time={time}
          onTime={onTime}
          brace={{ countName: 'batches', capName: 'L_q_c' }}
          plotWidth={plotWidth}
          clipRef={setLeadClip}
          onScroll={onScroll}
          onPanStart={onPanStart}
          onPanMove={onPanMove}
          onPanEnd={onPanEnd}
          onHover={onHover}
          summary={leadSummary}
          real={realLanes?.leads ?? null}
        />
      </div>
    </div>
  );
}
