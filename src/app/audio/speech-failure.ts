import { err, type Result } from "../../domain/result.js";
import type { SpeechErrorCode } from "../../domain/speech-error.js";
import type { LogFields } from "../../ports/logger.js";
import type { InterruptedCall } from "./speech-deadline.js";

/** Why a speech operation failed; `details` holds safe log fields only, never content. */
export interface SpeechFailure {
  readonly code: SpeechErrorCode;
  readonly details?: LogFields;
}

export function speechFailure(
  code: SpeechErrorCode,
  details?: LogFields,
): Result<never, SpeechFailure> {
  return err(details === undefined ? { code } : { code, details });
}

/** The failure for a port call that did not resolve; `timedOut` names the operation's deadline. */
export function interruptedFailure(
  reason: InterruptedCall,
  timedOut: "transcription_timed_out" | "synthesis_timed_out",
): Result<never, SpeechFailure> {
  switch (reason) {
    case "cancelled":
      return speechFailure("cancelled");
    case "timed_out":
      return speechFailure(timedOut);
    case "rejected_without_abort":
      return speechFailure("internal_error", { problem: "port_rejected_without_abort" });
  }
}
