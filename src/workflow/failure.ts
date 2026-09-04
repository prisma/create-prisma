import { Effect } from "effect";

import {
  CreateCancellationError,
  CreateFailure,
  type CreateFailureReason,
  type CreateFailureStage,
} from "../create-outcome";
import { getErrorMessage } from "../utils/errors";

export const atCreateStage = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  stage: CreateFailureStage,
  reason: CreateFailureReason,
) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof CreateFailure || error instanceof CreateCancellationError
        ? error
        : new CreateFailure({ stage, reason, message: getErrorMessage(error), cause: error }),
    ),
  );
