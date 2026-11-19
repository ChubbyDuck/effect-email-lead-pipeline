import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { beforeEach, expect, test, vi } from 'vitest';

import { MessageNotInDlq, RedriveNotDeleted } from '#Core/Observation/Ports/DlqRedrive';

import { makeSqsDlqRedrive } from './dlq';

const message = (id: string, extra: Partial<Message> = {}): Message => ({
  MessageId: id,
  ReceiptHandle: `receipt-${id}`,
  Body: `{"id":"${id}"}`,
  ...extra,
});

const send = vi.fn();
const sqs = { send } as unknown as SQSClient;

/** Each receive gives the next batch, and then nothing. */
function answer(batches: Message[][], fail: { send?: Error; delete?: Error } = {}) {
  const left = [...batches];
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof GetQueueUrlCommand) return { QueueUrl: `https://sqs/${command.input.QueueName}` };
    if (command instanceof ReceiveMessageCommand) return { Messages: left.shift() ?? [] };
    if (command instanceof SendMessageCommand) {
      if (fail.send !== undefined) throw fail.send;
      return { MessageId: 'sent-1' };
    }
    if (command instanceof DeleteMessageCommand && fail.delete !== undefined) throw fail.delete;
    return {};
  });
}

const inputsOf = <T>(type: abstract new (...args: never[]) => { readonly input: T }) =>
  send.mock.calls
    .map(([command]: unknown[]) => command)
    .flatMap((command) => (command instanceof type ? [command.input] : []));

beforeEach(() => send.mockReset());

test('sends the message to the main queue of its stage, then deletes it from the DLQ', async () => {
  const attributes = { kind: { DataType: 'String', StringValue: 'source' } };
  answer([[message('other')], [message('m1', { MessageAttributes: attributes }), message('next')]]);

  await expect(makeSqsDlqRedrive(sqs, 'leads').redrive('leadSources', 'm1')).resolves.toEqual({
    messageId: 'm1',
    sentMessageId: 'sent-1',
    queueName: 'leads-lead-sources',
  });

  expect(inputsOf(SendMessageCommand)).toEqual([
    { QueueUrl: 'https://sqs/leads-lead-sources', MessageBody: '{"id":"m1"}', MessageAttributes: attributes },
  ]);
  expect(inputsOf(DeleteMessageCommand)).toEqual([
    { QueueUrl: 'https://sqs/leads-lead-sources-dlq', ReceiptHandle: 'receipt-m1' },
  ]);
  // The other messages that the receives hid are visible again at once.
  expect(inputsOf(ChangeMessageVisibilityCommand).map(({ ReceiptHandle }) => ReceiptHandle)).toEqual([
    'receipt-other',
    'receipt-next',
  ]);
  const order = send.mock.calls.map(([command]: unknown[]) => command);
  expect(order.findIndex((command) => command instanceof SendMessageCommand)).toBeLessThan(
    order.findIndex((command) => command instanceof DeleteMessageCommand)
  );
});

test('sends nothing when the DLQ no longer has the message', async () => {
  answer([[message('other')]]);

  await expect(makeSqsDlqRedrive(sqs, 'leads').redrive('inbox', 'gone')).rejects.toBeInstanceOf(MessageNotInDlq);

  expect(inputsOf(SendMessageCommand)).toEqual([]);
  expect(inputsOf(DeleteMessageCommand)).toEqual([]);
});

test('keeps the message in the DLQ, visible, when the send fails', async () => {
  const failure = new Error('access denied');
  answer([[message('m1')]], { send: failure });

  await expect(makeSqsDlqRedrive(sqs, 'leads').redrive('leads', 'm1')).rejects.toBe(failure);

  expect(inputsOf(DeleteMessageCommand)).toEqual([]);
  expect(inputsOf(ChangeMessageVisibilityCommand)).toEqual([
    { QueueUrl: 'https://sqs/leads-leads-dlq', ReceiptHandle: 'receipt-m1', VisibilityTimeout: 0 },
  ]);
});

test('reports a message that went back to its queue, but stays in the DLQ, with the original failure', async () => {
  const failure = new Error('receipt expired');
  answer([[message('m1')]], { delete: failure });

  const error = await makeSqsDlqRedrive(sqs, 'leads')
    .redrive('leads', 'm1')
    .catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(RedriveNotDeleted);
  expect((error as RedriveNotDeleted).reason).toBe(failure);
  expect(inputsOf(SendMessageCommand)).toHaveLength(1);
});
