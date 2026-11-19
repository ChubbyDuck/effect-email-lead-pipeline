import { RequestID } from '@leads/shared/domain/request';
import { Lead } from '@leads/shared/domain/types';
import { makeRequestLedger, requestLedgerBuilder } from '@leads/shared/infrastructure/RequestLedger/mock/variants';
import { ConfigProvider, type Duration, Fiber, Layer, type LogLevel, Logger, ManagedRuntime, Schema } from 'effect';
import { TestClock } from 'effect/testing';

import { orderRepositoryBuilder, makeOrderRepository } from '#Infrastructure/Pipeline/OrderRepository/mock/variants';

import { awaitOnTestClock, NoJitter } from '../testing/clock';
import type { Command } from './command';
import { handler } from './handler';

export const leadProcessingRetry = 3;
export const leadProcessingRetryDelay = 100;
export const leadProcessingTimeoutMillis = 5_000;
export const leadConcurrency = 2;

export const lead = (name: string) =>
  Schema.decodeSync(Lead)({
    extraction_source: 'new_acquisition',
    idempotencyKey: 'key',
    extracted: { name },
    raw: { Name: name },
  });

export const record = (messageId: string, body: string) => ({ messageId, body });
/** The request of every lead unless a case names another one. */
export const sourceRequest = RequestID.make('source-request');
export const recordForLead = (messageId: string, name: string, requestID: string = sourceRequest) =>
  record(messageId, JSON.stringify({ lead: lead(name), requestID }));

export const command: Command = {
  records: [recordForLead('message-0', 'Acme')],
  functionName: 'leadHandler',
  source: 'leads-queue',
};

export const commandForLeads = (...names: readonly string[]): Command => ({
  ...command,
  records: names.map((name, index) => recordForLead(`message-${index}`, name)),
});

type ScenarioSetup = {
  readonly orderRepository?: typeof orderRepositoryBuilder;
  /** `record` as `succeeds` unless a case selects otherwise. */
  readonly requestLedger?: typeof requestLedgerBuilder;
  /** In ms. `leadProcessingRetryDelay` unless a case selects otherwise. */
  readonly retryDelay?: number;
};

type LoggedEvent = {
  readonly logLevel: LogLevel.LogLevel;
  readonly message: unknown;
};

type ErrorCtor<T extends Error> = new (...args: never[]) => T;

function messagesOf(logged: readonly LoggedEvent[], logLevel: LoggedEvent['logLevel']): unknown[] {
  return logged.flatMap((entry) =>
    entry.logLevel === logLevel ? (Array.isArray(entry.message) ? entry.message : [entry.message]) : []
  );
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

export function makeHandleLeadScenario(options: ScenarioSetup = {}) {
  const setup = {
    orderRepository: options.orderRepository ?? orderRepositoryBuilder,
    requestLedger: options.requestLedger ?? requestLedgerBuilder.record('succeeds'),
  };

  function start(input: Command = command) {
    const orderRepository = makeOrderRepository(setup.orderRepository);
    const requestLedger = makeRequestLedger(setup.requestLedger);
    const logged: LoggedEvent[] = [];
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        orderRepository.layer,
        requestLedger.layer,
        TestClock.layer(),
        NoJitter,
        Logger.layer([
          Logger.make((options) => {
            logged.push({ logLevel: options.logLevel, message: options.message });
          }),
        ]),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            LEAD_SOURCES_BUCKET_NAME: 'lead-sources',
            LEAD_INTERNAL_CONCURRENCY: leadConcurrency,
            LEAD_PROCESSING_RETRY: leadProcessingRetry,
            LEAD_PROCESSING_RETRY_DELAY: options.retryDelay ?? leadProcessingRetryDelay,
            LEAD_PROCESSING_TIMEOUT: leadProcessingTimeoutMillis,
          })
        )
      )
    );
    const fiber = runtime.runFork(handler(input));
    const observations = {
      orderRepository: orderRepository.observation,
      requestLedger: requestLedger.observation,
      loggedErrors: loggedAt(logged, 'Error'),
      loggedWarnings: loggedAt(logged, 'Warn'),
    };

    return {
      ...observations,
      /** Advances the TestClock; the handler runs every step scheduled on or before the new time. */
      adjust: (duration: Duration.Input) => runtime.runPromise(TestClock.adjust(duration)),
      /** Interrupts the running handler from outside, as a runtime shutdown would. */
      interrupt: () => runtime.runPromise(Fiber.interrupt(fiber)),
      async done() {
        try {
          const exit = await runtime.runPromise(awaitOnTestClock(fiber));
          return { exit, setup, ...observations };
        } finally {
          await runtime.dispose();
        }
      },
    };
  }

  return {
    setup,
    start,
    run: (input: Command = command) => start(input).done(),
  };
}
