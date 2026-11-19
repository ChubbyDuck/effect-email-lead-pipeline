import react, { type Options } from '@vitejs/plugin-react';
import { transform } from 'oxc-transform-react';
import type { Plugin, PluginOption } from 'vite';

const defaultIncludeRE = /\.[tj]sx?$/;
const defaultExcludeRE = /\/node_modules\//;
const defaultCodeFilter = /forwardRef|memo|\b(?:[A-Z]|use[A-Z0-9])/;

type ReactWithCompilerOptions = Omit<Options, 'compiler'> & {
  /**
   * When false, Oxc compiles without injecting Fast Refresh so another plugin
   * (e.g. React Router) can own refresh.
   * @default true
   */
  fastRefresh?: boolean;
};

export function reactWithCompiler(options: ReactWithCompilerOptions = {}): PluginOption[] {
  const { fastRefresh = true, ...reactOptions } = options;
  if (fastRefresh) {
    return react({
      ...reactOptions,
      compiler: true,
    });
  }
  return [oxcCompilerWithoutFastRefresh(reactOptions)];
}

export function isViteReactPlugin(plugin: PluginOption): boolean {
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
    return false;
  }
  const name = 'name' in plugin ? String(plugin.name) : '';
  return name === '@vitejs/plugin-react' || name.startsWith('vite:react');
}

function oxcCompilerWithoutFastRefresh(reactOptions: Omit<Options, 'compiler'>): Plugin {
  const include = reactOptions.include ?? defaultIncludeRE;
  const exclude = reactOptions.exclude ?? defaultExcludeRE;

  let jsxDevelopment = false;

  return {
    name: 'vite:react-compiler',
    enforce: 'pre',
    config() {
      return {
        oxc: {
          jsx: {
            runtime: reactOptions.jsxRuntime ?? 'automatic',
            ...(reactOptions.jsxImportSource === undefined ? {} : { importSource: reactOptions.jsxImportSource }),
            refresh: false,
          },
        },
        optimizeDeps: {
          include: ['react/compiler-runtime'],
        },
      };
    },
    configResolved(config) {
      jsxDevelopment = !config.isProduction;
    },
    async transform(code, id) {
      const filename = id.split('?')[0] ?? id;
      if (!idMatches(filename, include) || idMatches(filename, exclude)) {
        return;
      }

      const isClient = this.environment?.config.consumer !== 'server';
      const shouldCompile = isClient && defaultCodeFilter.test(code);
      const result = await transform(filename, code, {
        jsx: {
          ...(reactOptions.jsxRuntime === undefined ? {} : { runtime: reactOptions.jsxRuntime }),
          development: jsxDevelopment,
          ...(reactOptions.jsxImportSource === undefined ? {} : { importSource: reactOptions.jsxImportSource }),
          refresh: false,
        },
        reactCompiler: shouldCompile ? {} : false,
        sourcemap: this.environment
          ? this.environment.config.command !== 'build' || !!this.environment.config.build.sourcemap
          : true,
      });

      const diagnostics = result.errors.map(
        (error) => `${error.message}${error.codeframe ? `\n${error.codeframe}` : ''}`
      );
      if (result.fatal) {
        this.error(diagnostics.join('\n\n') || 'React Compiler transform failed.');
      }

      return {
        code: result.code,
        ...(result.map === undefined ? {} : { map: result.map }),
      };
    },
  };
}

function idMatches(id: string, filter: NonNullable<Options['include']>): boolean {
  const filters = Array.isArray(filter) ? filter : [filter];
  return filters.some((entry) => (typeof entry === 'string' ? id.includes(entry) : entry.test(id)));
}
