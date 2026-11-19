import { RequestID } from '@leads/shared/domain/request';
import { makeRequestLedger, requestLedgerBuilder } from '@leads/shared/infrastructure/RequestLedger/mock/variants';
import { Cause, ConfigProvider, type Duration, Exit, Fiber, Layer, Logger, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';

import { emailParserBuilder, makeEmailParser } from '#Infrastructure/Pipeline/EmailParser/mock/variants';
import { guardBuilder, makeGuard } from '#Infrastructure/Pipeline/Guard/mock/variants';
import { storageBuilder, makeStorage } from '#Infrastructure/Pipeline/Storage/mock/variants';

import { awaitOnTestClock } from '../testing/clock';
import type { Command } from './command';
import { handler } from './handler';

/** The SES message ID that names the email object, so it is the request of the email. */
export const requestID = RequestID.make('o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1');

export const command: Command = {
  bucket: 'inbox',
  key: `received/${requestID}`,
  /** Local time, so the folder is 15-01-2024/14-30 in every time zone. */
  receivedAt: new Date(2024, 0, 15, 14, 37),
  functionName: 'inboxHandler',
};

type ScenarioSetup = {
  readonly storage?: typeof storageBuilder;
  readonly emailParser?: typeof emailParserBuilder;
  readonly guard?: typeof guardBuilder;
  /** `acknowledge` and `record` as `succeeds` unless a case selects otherwise. */
  readonly requestLedger?: typeof requestLedgerBuilder;
};

type LoggedEvent = {
  readonly logLevel: string;
  readonly message: unknown;
};

type ErrorCtor<T extends Error> = new (...args: never[]) => T;

function messagesOf(logged: readonly LoggedEvent[], logLevel: LoggedEvent['logLevel']): unknown[] {
  return logged.flatMap((entry) =>
    entry.logLevel === logLevel ? (Array.isArray(entry.message) ? entry.message : [entry.message]) : []
  );
}

function dieDefects(exit: Exit.Exit<unknown, unknown>): unknown[] {
  return Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect) : [];
}

function loggedAt(logged: readonly LoggedEvent[], logLevel: LoggedEvent['logLevel']) {
  function select(): unknown[];
  function select<T extends Error>(errorClass: ErrorCtor<T>): T[];
  function select<T extends Error>(errorClass?: ErrorCtor<T>) {
    const messages = messagesOf(logged, logLevel);
    if (errorClass === undefined) return messages;
    return messages.filter((message): message is T => message instanceof errorClass);
  }
  return select;
}

export function makeHandleInboxScenario(options: ScenarioSetup = {}) {
  const setup = {
    storage: options.storage ?? storageBuilder,
    emailParser: options.emailParser ?? emailParserBuilder,
    guard: options.guard ?? guardBuilder,
    requestLedger: options.requestLedger ?? requestLedgerBuilder.acknowledge('succeeds').record('succeeds'),
  };

  function start(input: Command = command) {
    const storage = makeStorage(setup.storage);
    const emailParser = makeEmailParser(setup.emailParser);
    const guard = makeGuard(setup.guard);
    const requestLedger = makeRequestLedger(setup.requestLedger);
    const logged: LoggedEvent[] = [];
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        storage.layer,
        emailParser.layer,
        guard.layer,
        requestLedger.layer,
        TestClock.layer(),
        Logger.layer([
          Logger.make((options) => {
            logged.push({ logLevel: options.logLevel, message: options.message });
          }),
        ]),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            LEAD_SOURCES_BUCKET_NAME: 'lead-sources',
            LEAD_PROCESSING_RETRY: 3,
            LEAD_PROCESSING_TIMEOUT: 45 * 1000,
          })
        )
      )
    );
    const fiber = runtime.runFork(handler(input));
    const observations = {
      storage: storage.observation,
      emailParser: emailParser.observation,
      guard: guard.observation,
      requestLedger: requestLedger.observation,
      loggedInfos: loggedAt(logged, 'Info'),
      loggedErrors: loggedAt(logged, 'Error'),
      loggedWarnings: loggedAt(logged, 'Warn'),
      loggedFatals: loggedAt(logged, 'Fatal'),
    };

    return {
      ...observations,
      /** Advances the TestClock; the handler runs every step scheduled on or before the new time. */
      adjust: (duration: Duration.Input) => runtime.runPromise(TestClock.adjust(duration)),
      /** Interrupts the running handler from outside, as a runtime shutdown would. */
      interrupt: () => runtime.runPromise(Fiber.interrupt(fiber)),
      async done() {
        const exit = await runtime.runPromise(awaitOnTestClock(fiber));
        await runtime.dispose();
        return { exit, setup, defects: dieDefects(exit), ...observations };
      },
    };
  }

  return {
    setup,
    start,
    run: (input: Command = command) => start(input).done(),
  };
}
