import { handler as actualHandler } from '../Lambda/inbox';
import { wrap } from './control';
export const handler = wrap('inbox', actualHandler);
