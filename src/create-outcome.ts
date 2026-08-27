export type CreateFailureStage =
  | "validate_input"
  | "collect_context"
  | "scaffold_template"
  | "initialize_prisma"
  | "configure_project"
  | "install_dependencies"
  | "initialize_agent_skills"
  | "emit_contract"
  | "plan_migration"
  | "initialize_git"
  | "authenticate"
  | "select_workspace"
  | "check_project_name"
  | "build"
  | "composer_deploy"
  | "unknown";

export type CreateFailureReason =
  | "invalid_input"
  | "unsupported_node_version"
  | "invalid_project_name"
  | "target_path_not_directory"
  | "target_directory_not_empty"
  | "unsupported_configuration"
  | "template_scaffold_failed"
  | "prisma_init_failed"
  | "project_configuration_failed"
  | "dependency_install_failed"
  | "agent_skills_init_failed"
  | "contract_emit_failed"
  | "migration_plan_failed"
  | "git_initialization_failed"
  | "prisma_auth_command_failed"
  | "not_authenticated"
  | "authentication_failed"
  | "workspace_missing"
  | "workspace_mismatch"
  | "workspace_selection_failed"
  | "project_lookup_failed"
  | "project_name_collision"
  | "build_failed"
  | "composer_deploy_failed"
  | "unexpected_error";

export type CreateCancellationStage =
  | "project_name"
  | "template"
  | "database_provider"
  | "authoring_style"
  | "package_manager"
  | "deployment_intent"
  | "select_workspace";

export class CreateCancellationError extends Error {
  readonly stage: CreateCancellationStage;

  constructor(stage: CreateCancellationStage) {
    super("Operation cancelled.");
    this.name = "CreateCancellationError";
    this.stage = stage;
  }
}

export class ClassifiedCreateError extends Error {
  readonly reason: CreateFailureReason;

  constructor(reason: CreateFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClassifiedCreateError";
    this.reason = reason;
  }
}

export function getCreateFailureReason(
  error: unknown,
  fallback: CreateFailureReason,
): CreateFailureReason {
  return error instanceof ClassifiedCreateError ? error.reason : fallback;
}
