import { Schema } from "effect";

export const ComposerDeployCommandResultSchema = Schema.Struct({
  summary: Schema.NullOr(
    Schema.Struct({
      app: Schema.String,
      nodes: Schema.Array(
        Schema.Struct({
          entities: Schema.Array(
            Schema.Struct({
              kind: Schema.String,
              id: Schema.String,
              url: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
});
export type ComposerDeployCommandResult = typeof ComposerDeployCommandResultSchema.Type;

export function parseComposerDeployResult(
  result: ComposerDeployCommandResult,
): { appName: string; appUrl?: string; serviceId?: string } | undefined {
  if (!result.summary) return;
  const computeService = result.summary.nodes
    .flatMap((node) => node.entities)
    .find((entity) => entity.kind === "compute-service");
  return {
    appName: result.summary.app,
    ...(computeService?.id ? { serviceId: computeService.id } : {}),
    ...(computeService?.url ? { appUrl: computeService.url.replace(/\/$/, "") } : {}),
  };
}
