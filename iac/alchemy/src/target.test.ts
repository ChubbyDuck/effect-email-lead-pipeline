import { deployments } from '@leads/shared/deployments';
import { expect, test } from 'vitest';

import { FlociEndpointMissing, targetOf } from './target';

test('a Floci deployment without an endpoint fails with FlociEndpointMissing', () => {
  const { flociPort: _, ...withoutPort } = deployments['local-alchemy'];

  const error = (() => {
    try {
      targetOf('local-alchemy', withoutPort, undefined);
    } catch (thrown) {
      return thrown;
    }
  })();

  expect(error).toBeInstanceOf(FlociEndpointMissing);
  expect(error).toMatchObject({
    _tag: 'FlociEndpointMissing',
    deploymentName: 'local-alchemy',
    message:
      'Give local-alchemy a flociPort in deployments.ts, or set FLOCI_ENDPOINT to the endpoint of a Floci image of Alchemy',
  });
});
