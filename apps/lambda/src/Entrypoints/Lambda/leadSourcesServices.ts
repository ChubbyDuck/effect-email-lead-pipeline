import { makeQueueLive } from '@leads/pipeline/infrastructure/Queue/live';
import { Layer } from 'effect';

import { flociEndpoint } from './flociEndpoint';
import { leadSourcesSqsSockets, makeLeadSourcesSqsClient } from './leadSourcesSqs';
import { LambdaServicesLive } from './services';

// One client per execution environment, so warm invocations reuse its keep-alive sockets.
const sqs = makeLeadSourcesSqsClient(leadSourcesSqsSockets, flociEndpoint);

export const LeadSourcesServicesLive = Layer.mergeAll(LambdaServicesLive, makeQueueLive(sqs));
