import { handler as actualHandler } from '../Lambda/leadSources';
import { wrap } from './control';
export const handler = wrap('lead-sources', actualHandler);
