//! The leads pipeline as a factory floor: one loop of the shift is one burst of emails.
//!
//! The cast:
//! - parcel: one unit of work. An email splits into sources, and a source splits into leads.
//! - sources: three partners (one for each list type) and one forged sender.
//! - stations: a queue and a handler for each stage (Inbox, Sources, Leads).
//! - ledger: the Orders table, a column of dots.
//! - outcomes: stored, rejected (forged sender), failed (to the DLQ, then a redrive), duplicate.
//!
//! `Shift::new` calculates the timetable one time. `render_frame` only reads it.
use fframes::{AudioMap, Color, Duration, FFramesContext, Frame, Svgr, Video, include_media_dir};

include_media_dir!(pub struct PipelineVideoMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;

/// Seconds of one shift. The floor at the end of a shift is the floor at its start.
const LOOP: f32 = 19.0;
/// The video shows the shift this many times.
const LOOPS: f32 = 2.0;

const FONT: &str = "JetBrains Mono";
/// Advance of one glyph of the monospace face, as a part of the font size.
const GLYPH: f32 = 0.6;

const BG: &str = "#0a0b0d";
const HAIR: &str = "#2e323a";
const HAIR_DIM: &str = "#1b1e23";
const TEXT_1: &str = "#e8eaed";
const TEXT_2: &str = "#8d939c";
const TEXT_3: &str = "#5d636d";
const IDLE: &str = "#aab0b9";
const WORK: &str = "#f2b33d";
const PASS: &str = "#3ddc84";
const PASS_DIM: &str = "#245a3c";
const FAIL: &str = "#f25c54";

/// The height of the main belt.
const BY: f32 = 340.0;
const SENDER_X: f32 = 276.0;
const SENDER_Y: [f32; 4] = [220.0, 300.0, 380.0, 460.0];
const SENDER_NAME: [&str; 4] = ["acquisitions", "closures", "mutations", "forged sender"];
const FAN_IN_X: f32 = 428.0;
const INBOX_SLOT_X: [f32; 3] = [550.0, 500.0, 450.0];
const GATE_X: f32 = 720.0;
const SOURCE_SLOT_X: [f32; 3] = [992.0, 946.0, 900.0];
const PRESS_X: f32 = 1130.0;
const LEAD_QUEUE_X: f32 = 1290.0;
const LEAD_HANDLER_X: f32 = 1480.0;
const LEDGER_X: f32 = 1800.0;
const DLQ_Y: f32 = 470.0;
const DLQ_X: [f32; 3] = [500.0, 946.0, 1330.0];
const HANDLER_X: [f32; 3] = [GATE_X, PRESS_X, 1520.0];
const CAPTION_Y: f32 = 280.0;

/// Seconds of one hop between two stations.
const TRAVEL: f32 = 0.28;
const GATE_DWELL: f32 = 0.9;
const PRESS_DWELL: f32 = 0.8;
/// Seconds between two order writes of the lead handler.
const WRITE: f32 = 0.2;
const LEADS_OF_SOURCE: usize = 5;
/// Seconds that a lone lead waits for more leads before the handler takes it.
const BATCH_WINDOW: f32 = 1.8;
/// When the operator sends the failed lead back to its queue.
const REDRIVE_AT: f32 = 14.2;
/// Seconds from the fail mark of the gate to the end of a rejected email.
const REJECT: f32 = 1.0;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Normal,
    Forged,
    /// One lead of this email fails in the lead handler.
    FailOne,
    /// The partner sent this email before, so each lead is a duplicate.
    Resent,
}

struct EmailRun {
    sender: usize,
    kind: Kind,
    release: f32,
    queued: f32,
    gate_move: f32,
    gate_in: f32,
    gate_done: f32,
}

struct SourceRun {
    leave: f32,
    queued: f32,
    slot: usize,
    /// When the source in front of this one leaves the queue.
    front_leaves: f32,
    press_move: f32,
    press_in: f32,
    press_done: f32,
}

#[derive(Clone, Copy, PartialEq)]
enum Fate {
    Stored,
    Duplicate,
    Failed,
}

struct LeadRun {
    cell: usize,
    born: f32,
    queued: f32,
    take_move: f32,
    take_in: f32,
    work: f32,
    depart: f32,
    land: f32,
    fate: Fate,
}

/// The second life of the failed lead: the DLQ, the redrive, and the store.
struct Retry {
    dlq_arrive: f32,
    queued: f32,
    take_move: f32,
    take_in: f32,
    depart: f32,
    land: f32,
}

struct Shift {
    emails: Vec<EmailRun>,
    sources: Vec<SourceRun>,
    leads: Vec<LeadRun>,
    /// (take_in, last depart) of each batch of the lead handler.
    batches: Vec<(f32, f32)>,
    retry: Retry,
    /// The times at which a new order lands, in their order.
    landings: Vec<f32>,
    /// When the request of the `FailOne` email reaches each step of its ledger entry.
    steps: [f32; 6],
    duplicates: (f32, f32),
}

impl Shift {
    fn new() -> Self {
        let plan: [(f32, usize, Kind); 5] = [
            (0.3, 0, Kind::Normal),
            (1.4, 3, Kind::Forged),
            (2.9, 2, Kind::FailOne),
            (6.2, 0, Kind::Resent),
            (8.6, 1, Kind::Normal),
        ];
        let (mut emails, mut sources, mut leads, mut batches) = (vec![], vec![], vec![], vec![]);
        let (mut gate_free, mut press_free, mut handler_free) = (0.0_f32, 0.0_f32, 0.0_f32);
        let mut steps = [0.0; 6];
        let mut duplicates = (0.0, 0.0);
        let mut failed_at = 0.0;

        for (release, sender, kind) in plan {
            let queued = release + 0.42;
            let gate_move = (queued + 0.15).max(gate_free);
            let gate_in = gate_move + TRAVEL;
            let gate_done = gate_in + GATE_DWELL;
            gate_free = gate_done + if kind == Kind::Forged { REJECT + 0.15 } else { 0.25 };
            emails.push(EmailRun { sender, kind, release, queued, gate_move, gate_in, gate_done });
            if kind == Kind::Forged {
                continue;
            }

            let leave = gate_done + 0.1;
            let source_queued = leave + TRAVEL;
            let mut last_lead = 0.0;
            let mut front_leaves = 0.0;
            let first_lead = leads.len();
            for slot in 0..2 {
                let press_move = (source_queued + 0.15).max(press_free);
                let press_in = press_move + TRAVEL;
                let press_done = press_in + PRESS_DWELL;
                press_free = press_done + 0.1;
                sources.push(SourceRun {
                    leave,
                    queued: source_queued,
                    slot,
                    front_leaves,
                    press_move,
                    press_in,
                    press_done,
                });
                front_leaves = press_move;
                for index in 0..LEADS_OF_SOURCE {
                    let born = press_done + index as f32 * 0.04;
                    last_lead = born + TRAVEL;
                    leads.push(LeadRun {
                        cell: slot * LEADS_OF_SOURCE + index,
                        born,
                        queued: last_lead,
                        take_move: 0.0,
                        take_in: 0.0,
                        work: 0.0,
                        depart: 0.0,
                        land: 0.0,
                        fate: Fate::Stored,
                    });
                }
            }

            let take_move = (last_lead + 0.15).max(handler_free);
            let take_in = take_move + TRAVEL + 0.1;
            let begin = take_in + 0.15;
            for lead in &mut leads[first_lead..] {
                lead.take_move = take_move + lead.cell as f32 * 0.01;
                lead.take_in = lead.take_move + TRAVEL;
                lead.work = begin + lead.cell as f32 * WRITE;
                lead.depart = lead.work + WRITE;
                lead.land = lead.depart + 0.24;
                lead.fate = match kind {
                    Kind::Resent => Fate::Duplicate,
                    Kind::FailOne if lead.cell == 6 => Fate::Failed,
                    _ => Fate::Stored,
                };
                if lead.fate == Fate::Failed {
                    failed_at = lead.depart;
                }
            }
            let end = begin + 10.0 * WRITE;
            handler_free = end + 0.15;
            batches.push((take_in, end));
            if kind == Kind::Resent {
                duplicates = (begin + WRITE, end + 0.7);
            }
            if kind == Kind::FailOne {
                steps = [queued, gate_done, source_queued, last_lead, end + 0.2, 0.0];
            }
        }

        let dlq_arrive = failed_at + 0.75;
        let queued = REDRIVE_AT + 0.34;
        let take_move = (queued + BATCH_WINDOW).max(handler_free);
        let take_in = take_move + TRAVEL;
        let depart = take_in + 0.15 + WRITE;
        let retry = Retry { dlq_arrive, queued, take_move, take_in, depart, land: depart + 0.24 };
        batches.push((take_in, depart));
        steps[5] = retry.land;

        let mut landings: Vec<f32> =
            leads.iter().filter(|lead| lead.fate == Fate::Stored).map(|lead| lead.land).collect();
        landings.push(retry.land);
        landings.sort_by(f32::total_cmp);

        Self { emails, sources, leads, batches, retry, landings, steps, duplicates }
    }
}

pub struct PipelineVideoVideo<'a> {
    pub media: &'a PipelineVideoMedia,
    shift: Shift,
}

impl<'a> PipelineVideoVideo<'a> {
    pub fn new(media: &'a PipelineVideoMedia) -> Self {
        Self { media, shift: Shift::new() }
    }
}

impl std::fmt::Debug for PipelineVideoVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PipelineVideoVideo").finish()
    }
}

// ---------------------------------------------------------------- time and geometry

/// 0 before `start`, 1 after `start + length`, linear between them.
fn part(t: f32, start: f32, length: f32) -> f32 {
    ((t - start) / length).clamp(0.0, 1.0)
}

/// A quick start and a soft stop: the motion of each hop.
fn snap(p: f32) -> f32 {
    1.0 - (1.0 - p).powi(4)
}

fn mix(a: f32, b: f32, p: f32) -> f32 {
    a + (b - a) * p
}

fn mix2(a: (f32, f32), b: (f32, f32), p: f32) -> (f32, f32) {
    (mix(a.0, b.0, p), mix(a.1, b.1, p))
}

fn within(t: f32, start: f32, end: f32) -> bool {
    t >= start && t < end
}

fn text_width(size: f32, text: &str) -> f32 {
    text.chars().count() as f32 * size * GLYPH
}

/// The curve of a sender into the first queue, then the straight belt to the slot.
fn fan_in(sender: usize, p: f32) -> (f32, f32) {
    let y = SENDER_Y[sender];
    if p > 0.62 {
        return (mix(FAN_IN_X, INBOX_SLOT_X[0], (p - 0.62) / 0.38), BY);
    }
    let u = p / 0.62;
    let v = 1.0 - u;
    let (a, b, c, d) = (v * v * v, 3.0 * v * v * u, 3.0 * v * u * u, u * u * u);
    (
        a * (SENDER_X + 10.0) + b * 360.0 + c * 350.0 + d * FAN_IN_X,
        a * y + b * y + c * BY + d * BY,
    )
}

fn lead_cell(origin: f32, cell: usize) -> (f32, f32) {
    (origin + (cell % 5) as f32 * 20.0, BY - 10.0 + (cell / 5) as f32 * 20.0)
}

// ---------------------------------------------------------------- drawing helpers

fn label<'s>(x: f32, y: f32, size: f32, fill: &'static str, anchor: &'static str, text: &str) -> Svgr<'s> {
    fframes::svgr!(
        <text x={x} y={y} font-family={FONT} font-size={size} font-weight="400" fill={fill} text-anchor={anchor}>
            {text.to_owned()}
        </text>
    )
}

fn name<'s>(x: f32, y: f32, anchor: &'static str, text: &str) -> Svgr<'s> {
    fframes::svgr!(
        <text x={x} y={y} font-family={FONT} font-size="28" font-weight="700" fill={TEXT_1} text-anchor={anchor}>
            {text.to_owned()}
        </text>
    )
}

fn tag<'s>(x: f32, y: f32, text: &str, subtitle: &str) -> Svgr<'s> {
    let after = x + text.chars().count() as f32 * (22.0 * GLYPH + 4.0) + 20.0;
    fframes::svgr!(
        <g>
            <text x={x} y={y} font-family={FONT} font-size="22" font-weight="700" fill={TEXT_2} letter-spacing="4">
                {text.to_owned()}
            </text>
            <text x={after} y={y} font-family={FONT} font-size="22" font-weight="400" fill={TEXT_3}>
                {subtitle.to_owned()}
            </text>
        </g>
    )
}

fn block<'s>(center: (f32, f32), size: (f32, f32), radius: f32, fill: &'static str, opacity: f32) -> Svgr<'s> {
    fframes::svgr!(
        <rect x={center.0 - size.0 / 2.0} y={center.1 - size.1 / 2.0} width={size.0} height={size.1}
            rx={radius} fill={fill} opacity={opacity} />
    )
}

fn outline<'s>(center: (f32, f32), size: (f32, f32), radius: f32, stroke: &'static str) -> Svgr<'s> {
    fframes::svgr!(
        <rect x={center.0 - size.0 / 2.0} y={center.1 - size.1 / 2.0} width={size.0} height={size.1}
            rx={radius} fill="none" stroke={stroke} stroke-width="1.5" />
    )
}

fn hairline<'s>(d: String, stroke: &'static str) -> Svgr<'s> {
    fframes::svgr!(<path d={d} fill="none" stroke={stroke} stroke-width="1.5" stroke-linejoin="round" />)
}

fn port<'s>(x: f32, y: f32, lit: bool) -> Svgr<'s> {
    fframes::svgr!(<circle cx={x} cy={y} r="4" fill={if lit { WORK } else { HAIR }} />)
}

/// A parcel with the short blur that it leaves behind when it moves fast.
fn parcel<'s>(
    at: impl Fn(f32) -> (f32, f32),
    t: f32,
    size: (f32, f32),
    radius: f32,
    fill: &'static str,
    opacity: f32,
) -> Vec<Svgr<'s>> {
    let now = at(t);
    let mut drawn = vec![];
    for (back, ghost) in [(0.07, 0.14), (0.035, 0.3)] {
        let before = at(t - back);
        if (before.0 - now.0).abs() + (before.1 - now.1).abs() > 5.0 {
            drawn.push(block(before, size, radius, fill, opacity * ghost));
        }
    }
    drawn.push(block(now, size, radius, fill, opacity));
    drawn
}

// ---------------------------------------------------------------- the floor

/// Everything that does not move: belts, slots, station outlines, and names.
fn floor<'s>() -> Vec<Svgr<'s>> {
    let mut drawn = vec![];

    for (sender, y) in SENDER_Y.iter().enumerate() {
        drawn.push(label(SENDER_X - 20.0, y + 7.0, 22.0, TEXT_2, "end", SENDER_NAME[sender]));
        drawn.push(fframes::svgr!(
            <circle cx={SENDER_X} cy={*y} r="7" fill="none" stroke={HAIR} stroke-width="1.5" />
        ));
        drawn.push(hairline(
            format!("M{} {y} C360 {y} 350 {BY} {FAN_IN_X} {BY}", SENDER_X + 10.0),
            HAIR,
        ));
    }

    for (from, to) in [
        (FAN_IN_X, 426.0),
        (574.0, 640.0),
        (800.0, 882.0),
        (1010.0, 1060.0),
        (1200.0, 1276.0),
        (1384.0, 1440.0),
        (1600.0, LEDGER_X - 14.0),
    ] {
        drawn.push(hairline(format!("M{from} {BY} H{to}"), HAIR));
    }

    for x in INBOX_SLOT_X {
        drawn.push(outline((x, BY), (46.0, 34.0), 7.0, HAIR));
    }
    for x in SOURCE_SLOT_X {
        drawn.push(outline((x, BY), (34.0, 34.0), 7.0, HAIR));
    }
    for cell in 0..10 {
        drawn.push(outline(lead_cell(LEAD_QUEUE_X, cell), (16.0, 16.0), 4.0, HAIR));
    }
    for x in HANDLER_X {
        drawn.push(outline((x, BY), (160.0, 88.0), 12.0, HAIR));
    }

    // Each queue has its own DLQ. A failed message leaves the handler, and a redrive goes back up.
    for stage in 0..3 {
        let (dlq, handler) = (DLQ_X[stage], HANDLER_X[stage]);
        drawn.push(outline((dlq, DLQ_Y), (76.0, 40.0), 8.0, HAIR_DIM));
        drawn.push(hairline(
            format!("M{handler} {} V{} Q{handler} {DLQ_Y} {} {DLQ_Y} H{}", BY + 44.0, DLQ_Y - 12.0, handler - 12.0, dlq + 38.0),
            HAIR_DIM,
        ));
        drawn.push(hairline(format!("M{dlq} {} V{}", DLQ_Y - 20.0, BY + 30.0), HAIR_DIM));
        drawn.push(label(dlq - 50.0, DLQ_Y + 7.0, 22.0, TEXT_3, "end", "DLQ"));
    }

    drawn.push(name(FAN_IN_X, 236.0, "start", "Inbox"));
    drawn.push(label(FAN_IN_X + 100.0, 236.0, 22.0, TEXT_3, "start", "one email each"));
    drawn.push(name(878.0, 236.0, "start", "Sources"));
    drawn.push(label(878.0 + 134.0, 236.0, 22.0, TEXT_3, "start", "one workbook each"));
    drawn.push(name(1276.0, 236.0, "start", "Leads"));
    drawn.push(label(1276.0 + 100.0, 236.0, 22.0, TEXT_3, "start", "batches of 10"));
    drawn.push(name(1860.0, 236.0, "end", "Orders"));

    drawn.push(tag(100.0, 96.0, "LEADS PIPELINE", "one email becomes many orders"));
    drawn.push(label(1796.0, 96.0, 22.0, TEXT_3, "end", "one loop = one burst of emails"));

    drawn.push(hairline("M100 660 H1820".to_owned(), HAIR_DIM));
    drawn.push(tag(100.0, 722.0, "REQUEST LEDGER", "the mutations request, as the monitor shows it"));
    drawn.push(hairline("M100 862 H1820".to_owned(), HAIR_DIM));
    drawn.push(tag(100.0, 922.0, "LIMITS", "what bounds the real floor"));

    let mut x = 100.0;
    for limit in [
        "inbox ×50",
        "sources ×50",
        "leads ×200",
        "200 × 10 = 2,000 writes/s",
        "maxReceiveCount 1",
        "DLQ keeps 14 days",
    ] {
        let width = text_width(22.0, limit) + 36.0;
        drawn.push(outline((x + width / 2.0, 984.0), (width, 44.0), 10.0, HAIR_DIM));
        drawn.push(label(x + 18.0, 991.0, 22.0, TEXT_3, "start", limit));
        x += width + 16.0;
    }
    drawn
}

impl PipelineVideoVideo<'_> {
    fn clock<'s>(&self, t: f32) -> Svgr<'s> {
        let angle = t / LOOP * std::f32::consts::TAU;
        let (cx, cy) = (1832.0, 89.0);
        fframes::svgr!(
            <g>
                <circle cx={cx} cy={cy} r="13" fill="none" stroke={TEXT_3} stroke-width="1.5" />
                <line x1={cx} y1={cy} x2={cx + angle.sin() * 9.0} y2={cy - angle.cos() * 9.0}
                    stroke={TEXT_2} stroke-width="2" stroke-linecap="round" />
            </g>
        )
    }

    fn emails<'s>(&self, t: f32) -> Vec<Svgr<'s>> {
        let mut drawn = vec![];
        let mut busy = false;
        for email in &self.shift.emails {
            let forged = email.kind == Kind::Forged;
            let end = email.gate_done + if forged { REJECT } else { 0.1 };
            if !within(t, email.release, end) {
                continue;
            }
            let at = |t: f32| {
                if t < email.gate_move {
                    fan_in(email.sender, snap(part(t, email.release, email.queued - email.release)))
                } else {
                    (mix(INBOX_SLOT_X[0], GATE_X, snap(part(t, email.gate_move, TRAVEL))), mix(BY, BY - 8.0, part(t, email.gate_move, TRAVEL)))
                }
            };
            let in_gate = t >= email.gate_in;
            let done = t >= email.gate_done;
            busy |= in_gate && !done;
            let fill = match (in_gate, done, forged) {
                (true, true, true) => FAIL,
                (true, false, _) => WORK,
                _ => IDLE,
            };
            // A rejected email is deleted in place. It does not go to the DLQ.
            let gone = if forged { part(t, email.gate_done + 0.55, REJECT - 0.55) } else { 0.0 };
            let shrink = 1.0 - 0.5 * gone * gone;
            drawn.extend(parcel(at, t, (40.0 * shrink, 28.0 * shrink), 6.0, fill, 1.0 - gone));

            if email.kind == Kind::Resent && !done {
                let (x, y) = at(t);
                drawn.push(label(x, y - 24.0, 20.0, TEXT_2, "middle", "resent"));
            }
            if in_gate {
                let dot = mix(GATE_X - 56.0, GATE_X + 40.0, part(t, email.gate_in, GATE_DWELL));
                drawn.push(hairline(format!("M{} {} H{}", GATE_X - 56.0, BY + 24.0, GATE_X + 40.0), HAIR));
                if done {
                    let (mark, stroke) = if forged { ("M-6 -6 L6 6 M6 -6 L-6 6", FAIL) } else { ("M-7 0 L-2 5 L7 -6", PASS) };
                    drawn.push(fframes::svgr!(
                        <g transform={format!("translate({} {})", GATE_X + 56.0, BY + 24.0)}>
                            <path d={mark} fill="none" stroke={stroke} stroke-width="2.5" stroke-linecap="round" />
                        </g>
                    ));
                } else {
                    drawn.push(fframes::svgr!(<circle cx={dot} cy={BY + 24.0} r="4.5" fill={WORK} />));
                }
                let (caption, fill) = match (done, forged) {
                    (true, true) => ("rejected · file deleted", FAIL),
                    _ => ("dmarc=pass · whitelist", TEXT_2),
                };
                drawn.push(label(GATE_X, CAPTION_Y, 22.0, fill, "middle", caption));
            }
        }
        drawn.push(port(GATE_X - 80.0, BY, busy));
        drawn.push(port(GATE_X + 80.0, BY, busy));
        drawn
    }

    fn sources<'s>(&self, t: f32) -> Vec<Svgr<'s>> {
        let mut drawn = vec![];
        let mut pressed = None;
        for source in &self.shift.sources {
            if !within(t, source.leave, source.press_done + 0.08) {
                continue;
            }
            let at = |t: f32| {
                let slot = source.slot as f32 * (1.0 - snap(part(t, source.front_leaves, 0.2)));
                let slot_x = mix(SOURCE_SLOT_X[0], SOURCE_SLOT_X[1], slot);
                if t < source.press_move {
                    mix2((GATE_X, BY - 8.0), (slot_x, BY), snap(part(t, source.leave, TRAVEL)))
                } else {
                    (mix(slot_x, PRESS_X, snap(part(t, source.press_move, TRAVEL))), BY)
                }
            };
            let working = t >= source.press_in;
            if working {
                pressed = Some(t - source.press_in);
            }
            drawn.extend(parcel(at, t, (26.0, 26.0), 5.0, if working { WORK } else { IDLE }, 1.0));
        }

        // The press closes one time for each step: it parses the rows, then it pushes the leads.
        let closed = pressed.map_or(0.0, |elapsed: f32| {
            let step = elapsed % (PRESS_DWELL / 2.0);
            part(step, 0.0, 0.12) - part(step, 0.26, 0.12)
        });
        let stroke = if pressed.is_some() { WORK } else { HAIR };
        for side in [-1.0, 1.0] {
            let y = BY + side * (36.0 - 20.0 * closed);
            drawn.push(fframes::svgr!(
                <line x1={PRESS_X - 28.0} y1={y} x2={PRESS_X + 28.0} y2={y} stroke={stroke} stroke-width="3" stroke-linecap="round" />
            ));
        }
        if let Some(elapsed) = pressed {
            let caption = if elapsed < PRESS_DWELL / 2.0 { "parse rows" } else { "push leads" };
            drawn.push(label(PRESS_X, CAPTION_Y, 22.0, TEXT_2, "middle", caption));
        }
        drawn.push(port(PRESS_X - 80.0, BY, pressed.is_some()));
        drawn.push(port(PRESS_X + 80.0, BY, pressed.is_some()));
        drawn
    }

    fn leads<'s>(&self, t: f32) -> Vec<Svgr<'s>> {
        let mut drawn = vec![];
        let retry = &self.shift.retry;
        let size = (12.0, 12.0);
        for lead in &self.shift.leads {
            let end = match lead.fate {
                Fate::Stored => lead.land,
                Fate::Duplicate => lead.land + 0.35,
                Fate::Failed => retry.land,
            };
            if !within(t, lead.born, end) {
                continue;
            }
            let queue = lead_cell(LEAD_QUEUE_X, lead.cell);
            let held = lead_cell(LEAD_HANDLER_X, lead.cell);
            let out = (if lead.fate == Fate::Duplicate { LEDGER_X - 30.0 } else { LEDGER_X }, BY);
            let at = |t: f32| {
                if t < lead.take_move {
                    return mix2((PRESS_X, BY), queue, snap(part(t, lead.born, TRAVEL)));
                }
                if t < lead.depart {
                    return mix2(queue, held, snap(part(t, lead.take_move, TRAVEL)));
                }
                if lead.fate != Fate::Failed {
                    return mix2(held, out, snap(part(t, lead.depart, 0.24)));
                }
                // The failed lead: down the belt to the DLQ, then the redrive, then the handler again.
                let corner = (HANDLER_X[2], DLQ_Y);
                let dlq = (DLQ_X[2], DLQ_Y);
                let first = (LEAD_QUEUE_X, BY - 10.0);
                let again = lead_cell(LEAD_HANDLER_X, 0);
                if t < REDRIVE_AT {
                    let p = snap(part(t, lead.depart + 0.3, 0.45));
                    return if p < 0.45 { mix2(held, corner, p / 0.45) } else { mix2(corner, dlq, (p - 0.45) / 0.55) };
                }
                if t < retry.take_move {
                    return mix2(dlq, first, snap(part(t, REDRIVE_AT, 0.34)));
                }
                if t < retry.depart {
                    return mix2(first, again, snap(part(t, retry.take_move, TRAVEL)));
                }
                mix2(again, (LEDGER_X, BY), snap(part(t, retry.depart, 0.24)))
            };
            let failed = lead.fate == Fate::Failed;
            let fill = if failed && within(t, lead.depart, REDRIVE_AT) {
                FAIL
            } else if within(t, lead.work, lead.depart) || (failed && within(t, retry.take_in, retry.depart)) {
                WORK
            } else {
                IDLE
            };
            let skipped = lead.fate == Fate::Duplicate && t >= lead.land;
            if skipped {
                // The table has the key of this lead, so the put makes no order.
                let fade = 1.0 - part(t, lead.land, 0.35);
                drawn.push(fframes::svgr!(
                    <rect x={out.0 - 6.0} y={out.1 - 6.0} width="12" height="12" rx="3" fill="none"
                        stroke={TEXT_2} stroke-width="1.5" opacity={fade} />
                ));
            } else {
                drawn.extend(parcel(at, t, size, 3.0, fill, 1.0));
            }
            let (x, y) = at(t);
            if failed && t < retry.dlq_arrive && y > BY + 50.0 {
                drawn.push(label(x + 16.0, y + 7.0, 20.0, FAIL, "start", "failed"));
            }
        }

        if within(t, retry.dlq_arrive, REDRIVE_AT) {
            drawn.push(label(DLQ_X[2], DLQ_Y + 58.0, 22.0, TEXT_2, "middle", "waits for an operator"));
        }
        if within(t, REDRIVE_AT, REDRIVE_AT + 1.0) {
            drawn.push(label(DLQ_X[2], DLQ_Y + 58.0, 22.0, TEXT_1, "middle", "redrive"));
        }
        // The lone lead waits for the batching window. The ring is that clock.
        if within(t, retry.queued, retry.take_move) {
            let round = std::f32::consts::TAU * 15.0;
            let filled = part(t, retry.queued, retry.take_move - retry.queued) * round;
            let (x, y) = (LEAD_QUEUE_X, BY - 10.0);
            drawn.push(fframes::svgr!(
                <circle cx={x} cy={y} r="15" fill="none" stroke={WORK} stroke-width="2"
                    stroke-dasharray={format!("{filled} {round}")} transform={format!("rotate(-90 {x} {y})")} />
            ));
            drawn.push(label(DLQ_X[2], CAPTION_Y, 22.0, TEXT_2, "middle", "batching window"));
        }

        let busy = self.shift.batches.iter().any(|(start, end)| within(t, *start, *end));
        if busy {
            drawn.push(label(HANDLER_X[2], CAPTION_Y, 22.0, WORK, "middle", "10 writes/s"));
        }
        drawn.push(port(HANDLER_X[2] - 80.0, BY, busy));
        drawn.push(port(HANDLER_X[2] + 80.0, BY, busy));
        drawn
    }

    /// The Orders table: the newest order is at the top, and each new order moves the column down.
    fn orders<'s>(&self, t: f32) -> Vec<Svgr<'s>> {
        let landings = &self.shift.landings;
        let total = landings.len() as i32;
        let count: f32 = landings.iter().map(|land| snap(part(t, land - 0.15, 0.15))).sum();
        let landed = landings.iter().filter(|land| **land <= t).count() as i32;
        let mut drawn = vec![];
        for order in (landed - 9)..=landed {
            let slot = count - order as f32;
            // An order with a number below 1 landed in the loop before this one.
            let age = if order >= 1 { t - landings[(order - 1) as usize] } else { t + LOOP - landings[(total + order - 1) as usize] };
            let y = BY + slot * 26.0;
            let fade = 1.0 - part(slot, 7.0, 1.6);
            let fresh = 1.0 - part(age, 0.1, 1.1);
            drawn.push(fframes::svgr!(<circle cx={LEDGER_X} cy={y} r="6" fill={PASS_DIM} opacity={fade} />));
            if fresh > 0.01 {
                drawn.push(fframes::svgr!(<circle cx={LEDGER_X} cy={y} r="6" fill={PASS} opacity={fresh * fade} />));
            }
            if order == landed {
                drawn.push(fframes::svgr!(
                    <circle cx={LEDGER_X} cy={y} r="11" fill="none" stroke={PASS} stroke-width="1.5" opacity={0.35 + 0.65 * fresh} />
                ));
            }
        }

        let last = landings.iter().filter(|land| **land <= t).last().map_or(f32::MAX, |land| t - land);
        let (phrase, fill) = if within(t, self.shift.duplicates.0, self.shift.duplicates.1) {
            ("duplicate · skipped", TEXT_1)
        } else if last < 0.8 {
            ("stored", PASS)
        } else {
            ("waiting", TEXT_3)
        };
        drawn.push(label(1860.0, 600.0, 22.0, fill, "end", phrase));
        drawn
    }

    /// One request in the ledger. The cursor steps when a handler writes a new fact.
    fn request<'s>(&self, t: f32) -> Vec<Svgr<'s>> {
        let steps = ["received", "authorized", "2 sources", "10 leads", "9 stored · 1 failed", "10 stored"];
        let current = self.shift.steps.iter().rposition(|at| *at <= t);
        let mut drawn = vec![];
        let mut x = 100.0;
        let y = 800.0;
        let mut spans = vec![];
        for (index, step) in steps.iter().enumerate() {
            let width = text_width(24.0, step);
            let fill = match current {
                Some(at) if at == index => TEXT_1,
                Some(at) if at > index => TEXT_2,
                _ => TEXT_3,
            };
            drawn.push(label(x, y, 24.0, fill, "start", step));
            spans.push((x, width));
            if index + 1 < steps.len() {
                drawn.push(hairline(format!("M{} {} H{}", x + width + 16.0, y - 8.0, x + width + 48.0), HAIR));
            }
            x += width + 64.0;
        }
        if let Some(at) = current {
            // The cursor leaves before the loop ends, so the next loop starts with no cursor.
            let opacity = 1.0 - part(t, LOOP - 0.6, 0.4);
            let from = spans[at.saturating_sub(1)];
            let to = spans[at];
            let p = snap(part(t, self.shift.steps[at], 0.25));
            let failed_step = at == 4;
            drawn.push(fframes::svgr!(
                <rect x={mix(from.0, to.0, p)} y={y + 14.0} width={mix(from.1, to.1, p)} height="3" rx="1.5"
                    fill={if failed_step { FAIL } else if at == 5 { PASS } else { WORK }} opacity={opacity} />
            ));
        }
        drawn
    }
}

impl Video for PipelineVideoVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(LOOP * LOOPS)
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::none()
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds() % LOOP;
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" viewBox={format!("0 0 {WIDTH} {HEIGHT}")} width={WIDTH} height={HEIGHT}>
                <rect width={WIDTH} height={HEIGHT} fill={BG} />
                {floor()}
                {self.clock(t)}
                {self.orders(t)}
                {self.request(t)}
                {self.sources(t)}
                {self.emails(t)}
                {self.leads(t)}
            </svg>
        )
    }
}
