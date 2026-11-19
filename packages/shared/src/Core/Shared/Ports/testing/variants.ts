import { type Context, Effect, Layer } from 'effect';

/** A member that is an Effect value, not a function, takes no parameters: each run of it is one call. */
export type PortCall<S> = {
  [K in keyof S]: S[K] extends (...args: infer P) => unknown
    ? { readonly method: K; readonly params: P }
    : S[K] extends Effect.Effect<unknown, unknown, unknown>
      ? { readonly method: K; readonly params: [] }
      : never;
}[keyof S];

export function makePortCalls<S>() {
  const calls: PortCall<S>[] = [];

  return {
    record:
      <K extends PortCall<S>['method']>(method: K) =>
      (...params: Extract<PortCall<S>, { method: K }>['params']) =>
        Effect.sync(() => {
          calls.push({ method, params } as Extract<PortCall<S>, { method: K }>);
        }),
    observation: {
      get calls(): readonly PortCall<S>[] {
        return calls;
      },
    },
  };
}

type EffectMethod<S> = {
  [K in keyof S]: S[K] extends
    | ((...args: never[]) => Effect.Effect<unknown, unknown, unknown>)
    | Effect.Effect<unknown, unknown, unknown>
    ? K
    : never;
}[keyof S];

type PortVariants<S> = {
  [K in EffectMethod<S>]?: Record<string, S[K]>;
};

type VariantBuilder<V> = {
  [K in keyof V]: (variant: Extract<keyof V[K], string>) => VariantBuilder<V>;
};

type PortMockContext<S> = ReturnType<typeof makePortCalls<S>> & {
  method: <K extends EffectMethod<S>, V extends Record<string, S[K]>>(name: K, variants: V) => V;
};

export function definePortMock<I, S extends object, V extends PortVariants<S>, O>(
  service: Context.Key<I, S>,
  define: (context: PortMockContext<S>) => { variants: V; observation: O }
) {
  const selections = new WeakMap<object, Record<string, string>>();

  const build = (selected: Record<string, string> = {}): VariantBuilder<V> => {
    const builder = new Proxy(
      {},
      {
        get: (_, method) =>
          typeof method === 'string' ? (variant: string) => build({ ...selected, [method]: variant }) : undefined,
      }
    ) as VariantBuilder<V>;
    selections.set(builder, selected);
    return builder;
  };

  const builder = build();

  return {
    builder,
    make(selection: VariantBuilder<V> = builder) {
      const calls = makePortCalls<S>();
      const { variants, observation } = define({ ...calls, method: (_name, choices) => choices });
      const selected = selections.get(selection);
      if (!selected) throw new Error('Variant selection belongs to another port mock');

      const implementation: Record<string, unknown> = {};
      for (const [method, variant] of Object.entries(selected)) {
        const choices = variants[method as keyof V] as Record<string, unknown> | undefined;
        if (!choices || !Object.hasOwn(choices, variant)) {
          throw new Error(`Unknown variant ${method}.${variant}`);
        }
        implementation[method] = choices[variant];
      }

      return { layer: Layer.mock(service, implementation as Layer.PartialEffectful<S>), observation };
    },
  };
}

/** The defect of a port mock when a case calls a method that it selected no variant for. The message names the key of the port. */
export const unimplemented = (port: Context.Key<unknown, unknown>, method: string) => ({
  name: 'UnimplementedError',
  message: `${port.key}: Unimplemented method "${method}"`,
});
