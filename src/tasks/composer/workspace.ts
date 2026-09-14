import type { PrismaWorkspace } from "../../result";

export const getWorkspaceLabel = (workspace: PrismaWorkspace) => workspace.name ?? workspace.id;
