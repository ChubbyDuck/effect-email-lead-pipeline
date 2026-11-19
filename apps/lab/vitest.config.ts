import { reactWithCompiler } from '@leads/vite-config/reactCompilerOxc';
import { leadsTestConfig } from '@leads/vitest-config';
import { mergeConfig } from 'vitest/config';

// A unit test of the UI imports a `.tsx` module, so the tests compile JSX as the app does.
export default mergeConfig(leadsTestConfig(), { plugins: [reactWithCompiler()] });
