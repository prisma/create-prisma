import { Schema } from "effect";

export const CreateFailureStageSchema = Schema.Literals([
  "validate_input",
  "collect_context",
  "scaffold_template",
  "initialize_prisma",
  "configure_project",
  "install_dependencies",
  "initialize_agent_skills",
  "emit_contract",
  "plan_migration",
  "initialize_git",
  "authenticate",
  "select_workspace",
  "check_project_name",
  "build",
  "composer_deploy",
  "unknown",
]);
export type CreateFailureStage = typeof CreateFailureStageSchema.Type;

export const CreateFailureReasonSchema = Schema.Literals([
  "invalid_input",
  "unsupported_node_version",
  "invalid_project_name",
  "target_path_not_directory",
  "target_directory_not_empty",
  "unsupported_configuration",
  "template_scaffold_failed",
  "prisma_init_failed",
  "project_configuration_failed",
  "dependency_install_failed",
  "agent_skills_init_failed",
  "contract_emit_failed",
  "migration_plan_failed",
  "git_initialization_failed",
  "prisma_auth_command_failed",
  "not_authenticated",
  "authentication_failed",
  "workspace_missing",
  "workspace_mismatch",
  "workspace_selection_failed",
  "project_lookup_failed",
  "project_name_collision",
  "build_failed",
  "composer_deploy_failed",
  "unexpected_error",
]);
export type CreateFailureReason = typeof CreateFailureReasonSchema.Type;

export const CreateCancellationStageSchema = Schema.Literals([
  "project_name",
  "template",
  "database_provider",
  "authoring_style",
  "package_manager",
  "deployment_intent",
  "select_workspace",
]);
export type CreateCancellationStage = typeof CreateCancellationStageSchema.Type;

export class CreateCancellationError extends Schema.TaggedError<CreateCancellationError>()(
  "CreateCancellationError",
  {
    stage: CreateCancellationStageSchema,
    message: Schema.optionalKey(Schema.String),
  },
) {
  constructor(options: { stage: CreateCancellationStage; message?: string }) {
    super({ message: "Operation cancelled.", ...options });
  }
}

export class CreateFailure extends Schema.TaggedError<CreateFailure>()("CreateFailure", {
  stage: CreateFailureStageSchema,
  reason: CreateFailureReasonSchema,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
  errorReported: Schema.optionalKey(Schema.Boolean),
}) {}

export class PrismaCliCommandError extends Schema.TaggedError<PrismaCliCommandError>()(
  "PrismaCliCommandError",
  {
    message: Schema.String,
    command: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.String),
    stderr: Schema.optionalKey(Schema.String),
    exitCode: Schema.optionalKey(Schema.Number),
  },
) {
  readonly prismaCliCommand = this.command;
  readonly prismaCliErrorCode = this.code;
}

export function isCreateFailure(error: unknown): error is CreateFailure {
  return error instanceof CreateFailure;
}

export function toCreateFailure(options: {
  stage: CreateFailureStage;
  reason: CreateFailureReason;
  message: string;
  cause?: unknown;
  errorReported?: boolean;
}): CreateFailure {
  return new CreateFailure(options);
}
