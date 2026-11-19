# Burst simulator · Wave layout

**Status:** layout agreed. All six lanes are on the burst simulator: the emails tank, the inbox lane, the sources tank, the source-handler lane, the leads tank, and the lead-handler lane.
**App:** [apps/lab](../apps/lab)
**Glossary:** [CONTEXT.md](../CONTEXT.md)
**This slice:** [inbox.ts](../apps/lab/src/Core/Simulation/Domain/inbox.ts), [sources.ts](../apps/lab/src/Core/Simulation/Domain/sources.ts), [leads.ts](../apps/lab/src/Core/Simulation/Domain/leads.ts), [UI/Simulator/](../apps/lab/src/UI/Simulator/)

The burst simulator is the `/simulator` page of the lab, next to the monitor page at `/`. It shows one simulated burst through the queue pipeline as waves on one shared clock. The V1 and V2 pages and their models are removed.

---

## What the screen is

Six lanes, top to bottom, on one clock:

1. **Emails** — a tank and a number. The burst waiting for an inbox handler.
2. **Inbox handlers** — bars.
3. **Sources queue** — a tank and a number.
4. **Source handlers** — bars.
5. **Leads queue** — a tank and a number.
6. **Lead handlers** — bars.

The time axis belongs to the handler lanes. A tank is not a history line and does not draw itself. Its level and its number are the queue depth at the cursor.

One cursor moves the whole picture. The ruler handle, Play, and a drag on a handler lane all set that same time. Play walks the horizon in 8 seconds and stops at the end.

---

## What a wave is

A wave is work that starts together and finishes together because every member takes the same time.

Two widths produce that shape:

| Width        | Bounds                                      | Picture                         |
| ------------ | ------------------------------------------- | ------------------------------- |
| **Q_in**, **Q_src**, **Q_ld** | Handlers of one stage at once        | One stack of bars               |
| **C_in**, **C_src**, **C_ld** | Puts, sends, or stores inside one handler | Steps in the tank, not new bars |

**C_*** is how many of those operations run at once, not a rate. Items per second are derived from the timings.

Durations in a wave are equal. Do not add jitter. A shorter last put, send, or batch is its own wave, because its duration differs. Handlers that finish early and free a slot are a later model. This layout uses the equal-duration simplification.

Failures, redrive, and the dead-letter queue are off. There is no failure knob on this page.

---

## Drawing a handler wave

Draw the handlers in one wave as a stack, not as one bar per handler.

| Count   | Bars                         | Dots                                      |
| ------- | ---------------------------- | ----------------------------------------- |
| 1, 2, 3 | That many                   | None                                      |
| More    | Three                        | Between the second and the third          |

A brace on the left of the stack carries the count. A wave of one handler is the bar alone: no brace and no count. Each later wave of the same stage sits on its own inner lane inside that stage lane: the same stack, shifted down, with clear space and no border between inner lanes. The axis labels the visible clock. Each bar carries its own duration above it: milliseconds until the handler runs ten seconds, then seconds.

**Brace label.** When the wave holds the whole burst (`count = R` on the inbox lane), the brace reads the burst out of the stage cap, twice:

```text
10 / 50
R / Q_in
```

The first line is the digits. The second line is the names. Same order, same slash. When the wave is only part of the burst, the brace is `×` and the count (`×4`, `×2`). Source and lead lanes use the same brace once they are drawn: the whole stage input over that stage cap, in digits and in names, and `×` the count otherwise.

Puts, sends, and stores inside a handler are not bars. They move the tank.

An inbox bar is painted as the timings that make its duration, left to right: acknowledge, get, parse, record (the attachment count), one range per put wave, record (the end), delete. A source bar is record (the start), get, parse, record (the leads found), the sends, record (the end), and delete. A lead bar is parse, record (the starts), the wait for tokens when the handler has one, the store waves, and record (the ends), with one write for each of the `ld_requests` requests in the batch, up to `ld_c` at once. Each acknowledge and record is one write of the request entry in the request ledger. The record of the leads found is absent when the source has no leads; the handler still records its end and deletes it. Each handler deletes its email or source after the end, processed or rejected, so a run leaves no file in S3. A timing of 0 ms takes no space. Up to eight send waves are drawn as their own ranges. More than eight are one send stretch, and the hover tells the wave count and the time of one wave. Hovering a range shows its name, symbol, duration, where it sits on the clock, and what it does. A put shows how many sources that handler releases. A send shows how many leads. When the wave has more than one handler, the hover also shows how many they release together.

Bars and the ranges inside them are drawn to the clock. A 40 ms delete on a 60 s handler is a sliver. A range wide enough to hold its time shows that time inside the color. A bar thinner than a pixel is drawn one pixel wide so it can be seen; the duration above it is the true time. The hover states the true duration and the true clock interval.

Zoom scales that clock. Fit shows the whole horizon. The + and − buttons double or halve the scale, up to 256×, and keep the time at the center of the window. Holding Ctrl and rolling the wheel zooms toward the pointer: the time under the cursor stays put and the clock stretches around it. The wheel alone scrolls as the browser does. A short handler is a mark until you zoom.

A later wave starts only after the previous wave of that stage has finished. Each bar is drawn at that modeled start. Hovering a range draws one dashed line from that range's start up to the floating axis, and the axis points at that time. When the zoomed clock is wider than the panel, the panel scrolls across it.

If a lane has more than 2,000 handler waves, do not draw the bars. Say how many were skipped and how to shorten the picture (raise the stage cap or lower the count). The tank still follows the cursor.

---

## Tanks

A tank is a vessel plus a sentence: how many messages are waiting, out of the volume at these knobs.

| Tank    | Volume   | Rises when                         | Falls when                          |
| ------- | -------- | ---------------------------------- | ----------------------------------- |
| Emails  | **R**    | The burst arrives at 0             | An inbox wave starts                |
| Sources | **R × A** | An inbox handler puts a source     | A source handler takes one          |
| Leads   | **R × A × L** | A source handler sends a lead | A lead handler takes one batch      |

The volume is whatever the knobs currently say. The opening sketch’s “1,000,000” and “→1M” were an arithmetic slip. At the opening preset the leads volume is 10,000,000, and it is never a hardcoded constant.

A source wave takes its sources when it starts. A lead wave takes its batches when it starts.

---

## Cursor

The horizon is the end of the last handler on the lanes that exist. The cursor is a handle on the ruler, sitting at the current time. A dashed line at that time runs down every row under the ruler: the handler lanes and the tanks. Dragging it moves only through the times on screen. Scrolling the layout carries the handle with the ruler, and once that time leaves the window the handle is off screen. The clock is a fixed-width `0.000 s`.

The handler lanes share one horizontal scroller. When the zoomed clock is wider than the panel, that axis scrolls and the lane labels and tanks stay put. One bar floats over the whole layout and stays on screen. It labels the visible times in milliseconds, carries the zoom, and carries the thumb for the window. Holding Ctrl and rolling the wheel zooms both lanes about the pointer. A drag on a handler lane and that thumb pan both lanes together. The wheel alone is left to the browser. A click on a lane seeks the cursor. Start and End jump to the ends. Changing a knob returns the cursor to the start, returns the window to the start, and stops playback.

---

## Opening preset

Counts and widths from the sketch. Timings from the queue defaults of the removed V2 model, now written into the simulator defaults, except **C_in**, which the sketch sets to 50, and **delay_in** and **delay_src**, which open at 25 ms. The timings of this table are the first sketch. The simulator now opens at measured times: see [Measured defaults](#measured-defaults).

| Symbol     | Opening | Meaning                                      |
| ---------- | ------- | -------------------------------------------- |
| **R**      | 10      | Emails in the burst                          |
| **A**      | 10      | Sources per email                            |
| **L**      | 100,000 | Leads per source                             |
| **leadKb** | 4       | Lead message size                            |
| **Q_in**   | 50      | Inbox handlers at once                       |
| **Q_src**  | 50      | Source handlers at once                      |
| **Q_ld**   | 200     | Lead handlers at once                        |
| **C_in**   | 50      | Attachment puts at once inside one inbox handler |
| **C_src**  | 200     | Lead sends at once inside one source handler |
| **C_ld**   | 200     | Stores at once inside one lead handler       |
| **batch**  | 10      | Leads one lead handler takes                 |

Sketch misreads, so they are not reopened: the corner’s “C_src = 50” was **Q_src** written twice. “100k / 200 ≈ 500” is **C_src = 200**. The “10 leads” on the lead row is **batch**, not **C_ld**.

Timings, milliseconds:

| Symbol        | Opening |
| ------------- | ------- |
| **delay_in**, **delay_src** | 25 |
| **delay_ld** | 0 |
| **t_get_in**  | 200     |
| **t_parse_in**| 80      |
| **t_put_in**  | 120     |
| **t_delete_in** | 40    |
| **t_get_src** | 200     |
| **t_parse_src** | 150   |
| **t_send**    | 120     |
| **t_delete_src** | 40   |
| **t_parse_ld**| 20      |
| **t_store**   | 200     |

Counts floor to an integer. **A** and **L** may be 0. Every other count is at least 1. Times are at least 0.

---

## Clock the lanes share

These match the discrete rules of the removed V2 model when durations are equal. A stage wave starts when the previous wave of that stage ends.

**Emails.** The whole burst is released at 0. Waiting emails are **R** minus every email whose wave has already started. A wave takes its count at its start, so a burst that fits in **Q_in** with no delay never sits in the tank. During **delay_in** the whole burst is waiting.

**Inbox.** Prefix = `t_get_in + t_parse_in`. Put waves `W_in` are 0 when `A` is 0, otherwise `ceil(A / C_in)`. Duration `T_in = prefix + W_in × t_put_in + t_delete_in`. Handler waves = `ceil(R / Q_in)`. Wave `i` starts at `delay_in + i × T_in`, holds `Q_in` handlers, and the last holds the remainder. At a zero duration the burst is one mark of `R` at `delay_in`.

Sources from a handler appear at `prefix + w × t_put_in` for put `w = 1 … W_in`, `min(C_in, sources still on that handler)` at a time. A stage wave emits that chunk times its handler count. With `t_put_in = 0`, every source from the handler appears at the prefix.

**Sources, when that lane is drawn.** A source handler takes one source, at most **Q_src** at once, after **delay_src**. Prefix = `t_get_src + t_parse_src`. Send waves `W_src` are 0 when `L` is 0, otherwise `ceil(L / C_src)`. Duration is the prefix, plus `W_src × t_send`, plus delete. Leads appear at `prefix + w × t_send`, `min(C_src, leads still on that handler)` at a time.

**Leads.** A lead handler takes one batch of at most `ld_batch` leads, at most `L_q_c` at once, after `delay_ld`. The batch is cut down when it does not fit the 6 MB Lambda payload. A full batch goes at once. A partial batch goes once its oldest lead has waited `ld_window_t`, so a short tail can wait up to the window of the stack (10 s). Its duration is `ld_records_parse_t + ceil(n / ld_c) × ld_order_repository_store_t` for the `n` leads in that batch. A partial batch is its own wave, because its duration can differ. Store waves step nothing downstream in this picture. They are not bars.

**Order write limit.** Each lead execution environment has a bucket of `ld_writes` tokens with `ld_writes` new tokens a second, and each store takes one. The handler waits for its tokens before its stores, and Lambda bills the wait. The wait is `n × 1000 / ld_writes − min(1000, rest) − T` ms, and never less than 0, for `n` leads, a handler time of `T`, and `rest` ms of rest of its environment. A new environment has a full bucket, so its first batch of up to `ld_writes` leads does not wait. A handler that follows the previous batch waits for all its tokens, so a full batch of the defaults takes 1 s. The environment that has rested longest takes the next batch. `L_q_c × ld_writes` above 2,000 breaks the order write limit, and `sliceLimits` flags it.

---

## What is on the page now

Knobs that move this slice: **R**, **A**, **L**, **Q_in**, **C_in**, **Q_src**, **C_src**, the inbox timings, and the source timings. Reset restores the opening preset for those knobs.

At the opening preset the ten emails wait through the 25 ms start delay, then one inbox wave of 10 runs for 520 ms. Those 10 fit in **Q_in**, so the emails tank is empty once that wave starts. All 100 sources appear at 425 ms and wait another 25 ms. Fifty source handlers start at 450 ms, so 50 sources stay waiting until 60.920 s, when the second wave takes them. Each source handler lasts 60.470 s, almost all of it the 500 send waves, drawn as one stretch. The inbox brace reads `10 / 50` over `R / Q_in`. Each source wave reads `×50`, because neither wave holds every source. Set **Q_src** to 100 to see one source wave labeled `100 / 100` over `R×A / Q_src`. Set **Q_in** below **R** to see later inbox waves, and the emails tank step down as each wave starts. Set **C_in** below **A** to see the sources tank step as puts land.

---

## Out of this layout

- Per-handler bars for 50 or 200 handlers.
- A queue drawn as a line, static or self-drawing.
- Random duration differences.
- Failures, redrive, and the dead-letter queue.
- Early finish freeing a slot for a waiting handler.
- A hardcoded leads volume.

## Measured defaults

The timing defaults are the medians of the last five requests of 1 Nov 2026: 5 inbox runs, 5 source runs, and 13 lead runs. Each request had one source of 20 leads. The tests of the model arithmetic use the round timings in [roundDefaults.ts](../apps/lab/src/Core/Simulation/Domain/testing/roundDefaults.ts), so a new measurement does not change them.

A handler logs a progress line first and writes the ledger after it, so each line marks the start of a write. The logs give ranges between lines, not one value for each call.

| Knobs | Range of the logs |
| --- | --- |
| `delay_in` | From the store of the email in S3 to the start of the inbox run, before INIT |
| `in_request_ledger_acknowledge_t` + `in_storage_read_t` | From the start of the run to the size line |
| `in_email_parser_parse_t` | From the size line to the attachment count |
| `in_request_ledger_record_t` + `in_storage_store_t` | From the attachment count to the end status |
| `in_request_ledger_record_t` + `in_storage_delete_t` | From the end status to the end of the run |
| `delay_src` | From the end status of the inbox run to the start of the source run, before INIT |
| `src_request_ledger_record_t` + `src_storage_read_t` | From the start of the run to the size line |
| `src_excel_sheet_parser_parse_t` | From the size line to the lead count |
| `src_request_ledger_record_t` + `src_queue_push_t` | From the lead count to the end of the source |
| `src_request_ledger_record_t` + `src_storage_delete_t` | From the end of the source to the end of the run |
| `delay_ld` | From the end of the source to the start of the first lead run, before INIT |
| `ld_records_parse_t` | From the start of the run to the leads pending |
| `ld_request_ledger_record_t` + `ld_order_repository_store_t` | From the leads pending to the end of the leads |
| `ld_request_ledger_record_t` | From the end of the leads to the end of the run. This is the only range that shows one ledger write alone. |
| `in_init_t`, `src_init_t`, `ld_init_t` | Init Duration of the REPORT line. One, one, and two cold starts. |

The inbox has the memory of the lead handler, so its two ledger knobs take the measured lead write. The source handler has more memory, and no range shows its write alone, so `src_request_ledger_record_t` stays an estimate of 20 ms, and the other source knobs are the range minus 20 ms.

The other knobs are not measurements. The stack, AWS, or the person sets them: the load `E`, `S`, `L`, and `N`, the concurrency, the batch, the window, the memory, and `esm_start` and `esm_rate`. The files of these requests are too small to show `in_storage_mb_t` and `src_storage_mb_t`. The logs give no size of a queued lead, so `lead_b` stays. `row_b` stays, because a workbook of 20 rows gives about 1,700 B a row with the overhead of the file, and a large workbook gives about 300 B.
