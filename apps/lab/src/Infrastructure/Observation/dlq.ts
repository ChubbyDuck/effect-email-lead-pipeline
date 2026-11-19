import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { type DlqMessage, dlqMessageLimit, toDlqMessage } from '#Core/Observation/Domain/dlq';
import { entryOf } from '#Core/Observation/Domain/dlqClues';
import { type DlqRedrive, MessageNotInDlq, RedriveNotDeleted } from '#Core/Observation/Ports/DlqRedrive';
import type { DlqSource } from '#Core/Observation/Ports/DlqSource';

import { type AwsStatusSourceOptions, queueNameOf } from './aws';

/** The most receives of one read. With a visibility timeout of 0, a receive can give the same messages again. */
const receiveLimit = 10;

/**
 * Reads the messages of a DLQ without a change to them. Each receive has a visibility timeout of 0, so every message
 * stays visible in the queue. A receive adds 1 to the receive count of a message, but a DLQ has no DLQ of its own, so
 * the count moves no message. SQS keeps the messages on many servers, and one receive can give only some of them. So
 * the source receives again until it has the messages that SQS counts, or until `receiveLimit`.
 */
export function makeAwsDlqSource({ name, deployment, endpoint }: AwsStatusSourceOptions): DlqSource {
  const sqs = new SQSClient({ region: deployment.region, ...(endpoint === undefined ? {} : { endpoint }) });

  return {
    async peek(stage) {
      const queueName = queueNameOf(deployment.prefix, stage, 'dlq');
      const readAt = new Date();
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] })
      );
      const approximateCount = Number(Attributes?.ApproximateNumberOfMessages ?? 0);
      const wanted = Math.min(approximateCount, dlqMessageLimit);
      const messages = new Map<string, DlqMessage>();
      // The count of SQS can be late, so the source receives at least once.
      for (let receive = 0; receive < receiveLimit && (receive === 0 || messages.size < wanted); receive++) {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl,
            MaxNumberOfMessages: 10,
            VisibilityTimeout: 0,
            WaitTimeSeconds: 1,
            MessageSystemAttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          })
        );
        for (const message of Messages.map(toDlqMessage)) messages.set(message.messageId, message);
      }
      return {
        deployment: name,
        region: deployment.region,
        stage,
        queueName,
        readAt: readAt.toISOString(),
        approximateCount,
        messages: [...messages.values()]
          .toSorted((a, b) => Number(b.attributes.SentTimestamp ?? 0) - Number(a.attributes.SentTimestamp ?? 0))
          .slice(0, dlqMessageLimit)
          .map((message) => entryOf(stage, message)),
      };
    },
  };
}

/** In s. A received message stays hidden this long, so that the redrive can send it and delete it. */
const redriveVisibilitySeconds = 30;

/**
 * Sends one message of a DLQ back to the main queue of its stage. SQS has no call that moves one message, so the
 * redrive receives the DLQ until it has the message, sends the body and the attributes of the message to the main
 * queue, and then deletes it from the DLQ. The send comes first, so a failure can make a copy, but never loses the
 * message. Each other message that a receive hides is visible again at once.
 */
export function makeSqsDlqRedrive(sqs: SQSClient, prefix: string): DlqRedrive {
  async function urlOf(queueName: string) {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (QueueUrl === undefined) throw new Error(`No queue URL for ${queueName}`);
    return QueueUrl;
  }

  const release = (QueueUrl: string, messages: readonly Message[]) =>
    Promise.allSettled(
      messages.flatMap(({ ReceiptHandle }) =>
        ReceiptHandle === undefined
          ? []
          : [sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle, VisibilityTimeout: 0 }))]
      )
    );

  return {
    async redrive(stage, messageId) {
      const dlqName = queueNameOf(prefix, stage, 'dlq');
      const mainName = queueNameOf(prefix, stage, 'main');
      const [dlqUrl, mainUrl] = await Promise.all([urlOf(dlqName), urlOf(mainName)]);

      let target: Message | undefined;
      for (let receive = 0; receive < receiveLimit && target === undefined; receive++) {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            MaxNumberOfMessages: 10,
            VisibilityTimeout: redriveVisibilitySeconds,
            WaitTimeSeconds: 1,
            MessageAttributeNames: ['All'],
          })
        );
        target = Messages.find((message) => message.MessageId === messageId);
        await release(
          dlqUrl,
          Messages.filter((message) => message !== target)
        );
      }
      const receiptHandle = target?.ReceiptHandle;
      if (target === undefined || receiptHandle === undefined) throw new MessageNotInDlq(messageId, dlqName);

      const attributes = target.MessageAttributes ?? {};
      let sent;
      try {
        sent = await sqs.send(
          new SendMessageCommand({
            QueueUrl: mainUrl,
            MessageBody: target.Body ?? '',
            ...(Object.keys(attributes).length > 0 && { MessageAttributes: attributes }),
          })
        );
      } catch (error) {
        await release(dlqUrl, [target]);
        throw error;
      }
      try {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: receiptHandle }));
      } catch (error) {
        throw new RedriveNotDeleted(messageId, error);
      }
      return { messageId, sentMessageId: sent.MessageId ?? '', queueName: mainName };
    },
  };
}

export const makeAwsDlqRedrive = ({ deployment, endpoint }: AwsStatusSourceOptions): DlqRedrive =>
  makeSqsDlqRedrive(
    new SQSClient({ region: deployment.region, ...(endpoint === undefined ? {} : { endpoint }) }),
    deployment.prefix
  );
