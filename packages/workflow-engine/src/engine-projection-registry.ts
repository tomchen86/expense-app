export type EngineProjectionTransition =
  'archive' | 'completion' | 'issue' | 'plan' | 'rollback-completion';

export type EngineProjectionDefinition = {
  path: string;
  transitions: EngineProjectionTransition[];
};

const REGISTRY: readonly Readonly<{
  path: string;
  transitions: readonly EngineProjectionTransition[];
}>[] = Object.freeze([
  Object.freeze({
    path: 'docs/CURRENT_AND_NEXT_STEPS.md',
    transitions: Object.freeze([
      'archive',
      'completion',
      'plan',
      'rollback-completion',
    ] satisfies EngineProjectionTransition[]),
  }),
]);

/**
 * Returns a copy of the reviewed, engine-owned projection registry. Repository
 * policy may enable an entry but cannot add another output path or transition.
 */
export function engineProjectionDefinitions(): EngineProjectionDefinition[] {
  return REGISTRY.map((definition) => ({
    path: definition.path,
    transitions: [...definition.transitions],
  }));
}

export function engineProjectionPathsForTransition(
  transition: EngineProjectionTransition,
): string[] {
  return REGISTRY.filter(({ transitions }) =>
    transitions.includes(transition),
  ).map(({ path }) => path);
}
