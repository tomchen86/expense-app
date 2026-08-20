/**
 * Compatibility surface for the mechanically extracted neutral Git trailer
 * grammar. The public core module is the sole parser and error authority.
 */
export {
  hasManagedTrailerLine,
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
} from '@jigwright/core/managed-transition-trailers';
export type {
  AmendPlanManagedTrailers,
  ArchiveManagedTrailers,
  AuthorityCandidateManagedTrailers,
  AuthorityManagedTrailers,
  ManagedTrailers,
  PlanManagedTrailers,
  TaskManagedTrailers,
} from '@jigwright/core/managed-transition-trailers';
