import { handler as actualHandler } from '../Lambda/leads';
import { wrap } from './control';
export const handler = wrap('leads', actualHandler);
