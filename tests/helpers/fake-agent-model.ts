import { err, ok, type Result } from "../../src/domain/result.js";
import type {
  AgentModel,
  ModelFailure,
  ModelFailureCode,
  ModelRequest,
  ModelStep,
  ModelToolCall,
} from "../../src/ports/agent-model.js";

/** The fake's opaque state: a distinct token per step, so tests can follow and look for it. */
export type FakeContinuation = string;

export type FakeOutcome = Result<ModelStep<FakeContinuation>, ModelFailure>;

/** One scripted invocation. `index` is the 0-based invocation number. */
export type FakeReply = (
  request: ModelRequest<FakeContinuation>,
  signal: AbortSignal,
  index: number,
) => Promise<FakeOutcome>;

export interface FakeAgentModel extends AgentModel<FakeContinuation> {
  /** Every request, as received; the runner hands each one a transcript snapshot. */
  readonly requests: readonly ModelRequest<FakeContinuation>[];
}

export function continuationToken(index: number): FakeContinuation {
  return `opaque-continuation-${index}`;
}

/** A completed step with the given text and calls. */
export function step(text: string | null, toolCalls: readonly ModelToolCall[] = []): FakeReply {
  return async (_request, _signal, index) =>
    ok({ text, toolCalls, continuation: continuationToken(index) });
}

export function fail(code: ModelFailureCode): FakeReply {
  return async () => err({ code });
}

/** Keeps the port contract: settles only by rejecting when the signal aborts. */
export const hangUntilAbort: FakeReply = async (_request, signal) =>
  new Promise<FakeOutcome>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

export function toolCall(
  callId: string,
  name: string,
  args: ModelToolCall["arguments"],
): ModelToolCall {
  return { callId, name, arguments: args };
}

/**
 * A scripted `AgentModel` with no provider behind it. An invocation past the end of the script
 * throws, which the runner reports as `internal_error`, so an unexpected extra call fails the test.
 */
export function createFakeAgentModel(replies: readonly FakeReply[]): FakeAgentModel {
  const requests: ModelRequest<FakeContinuation>[] = [];

  return {
    requests,
    respond: async (request, signal): Promise<FakeOutcome> => {
      const index = requests.length;
      requests.push(request);
      const reply = replies[index];

      if (reply === undefined) {
        throw new Error(`Unscripted model invocation ${index}.`);
      }

      return reply(request, signal, index);
    },
  };
}
