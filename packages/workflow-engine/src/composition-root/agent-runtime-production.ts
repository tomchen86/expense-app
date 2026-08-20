import type { AgentRuntimePort } from '../modules/provider-orchestration/agent-runtime-port.ts';
import {
  runBuiltInProvider,
  runBuiltInProviderAsync,
} from '../runtime/provider-execution/provider-runner.ts';

/** Production adapter retaining sync compatibility while exposing async launch. */
const builtInAgentRuntime: AgentRuntimePort = {
  runSingleShot(input, options) {
    return runBuiltInProvider(input, options);
  },
  runSingleShotAsync(input, options) {
    return runBuiltInProviderAsync(input, options);
  },
};

export const productionAgentRuntime = Object.freeze(builtInAgentRuntime);

export type {
  AgentRuntimeCompletionReceipt,
  AgentRuntimePort,
  AgentRuntimeProcessActivity,
  AgentRuntimeProcessProgressProjection,
  AgentRuntimeProcessTermination,
  AgentRuntimeSingleShotInput,
  AgentRuntimeSingleShotOptions,
  AgentRuntimeSingleShotReport,
  ProviderInvocationAcceptanceBinding,
} from '../modules/provider-orchestration/agent-runtime-port.ts';
