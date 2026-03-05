import {
  cancel,
  isCancel,
  log,
  multiselect,
  select,
  spinner,
} from "@clack/prompts";
import { execa } from "execa";

import type {
  AddonInstallScope,
  CreateAddon,
  CreateAddonSetupContext,
  CreateCommandInput,
  DatabaseProvider,
  ExtensionTarget,
  PackageManager,
  PrismaSkillName,
} from "../types";
import {
  getPackageExecutionArgs,
} from "../utils/package-manager";

type AgentOption = {
  value: string;
  label: string;
};

const DEFAULT_ADDON_SCOPE: AddonInstallScope = "project";
const DEFAULT_SKILLS_AGENTS = ["claude-code", "codex", "cursor"] as const;
const DEFAULT_MCP_AGENTS = ["claude-code", "codex", "cursor"] as const;
const DEFAULT_EXTENSION_TARGETS: ExtensionTarget[] = ["vscode", "cursor"];
const PRISMA_MCP_SERVER = "https://mcp.prisma.io/mcp";

const ADDON_OPTIONS: Array<{
  value: CreateAddon;
  label: string;
  hint: string;
}> = [
  {
    value: "skills",
    label: "Skills",
    hint: "Install curated Prisma skills to your selected coding agents",
  },
  {
    value: "mcp",
    label: "MCP",
    hint: "Configure Prisma MCP server in agent MCP config files",
  },
  {
    value: "extension",
    label: "IDE Extension",
    hint: "Install Prisma extension in selected IDEs (VS Code, Cursor, Windsurf)",
  },
];

const SKILLS_AGENT_OPTIONS: AgentOption[] = [
  { value: "cursor", label: "Cursor" },
  { value: "claude-code", label: "Claude Code" },
  { value: "cline", label: "Cline" },
  { value: "github-copilot", label: "GitHub Copilot" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
  { value: "windsurf", label: "Windsurf" },
  { value: "goose", label: "Goose" },
  { value: "roo", label: "Roo Code" },
  { value: "kilo", label: "Kilo Code" },
  { value: "gemini-cli", label: "Gemini CLI" },
  { value: "antigravity", label: "Antigravity" },
  { value: "openhands", label: "OpenHands" },
  { value: "trae", label: "Trae" },
  { value: "amp", label: "Amp" },
  { value: "pi", label: "Pi" },
  { value: "qoder", label: "Qoder" },
  { value: "qwen-code", label: "Qwen Code" },
  { value: "kiro-cli", label: "Kiro CLI" },
  { value: "droid", label: "Droid" },
  { value: "command-code", label: "Command Code" },
  { value: "clawdbot", label: "Clawdbot" },
  { value: "zencoder", label: "Zencoder" },
  { value: "neovate", label: "Neovate" },
  { value: "mcpjam", label: "MCPJam" },
];

const MCP_AGENT_OPTIONS: AgentOption[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "vscode", label: "VS Code" },
  { value: "github-copilot-cli", label: "GitHub Copilot CLI" },
  { value: "opencode", label: "OpenCode" },
  { value: "gemini-cli", label: "Gemini CLI" },
  { value: "goose", label: "Goose" },
  { value: "zed", label: "Zed" },
  { value: "antigravity", label: "Antigravity" },
  { value: "cline", label: "Cline VS Code Extension" },
  { value: "cline-cli", label: "Cline CLI" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "mcporter", label: "MCPorter" },
];

const SHARED_PRISMA_SKILLS: PrismaSkillName[] = [
  "prisma-cli",
  "prisma-client-api",
  "prisma-database-setup",
  "prisma-upgrade-v7",
];

type SkillOption = {
  value: PrismaSkillName;
  label: string;
  hint: string;
};

function getAvailablePrismaSkills(provider: DatabaseProvider): PrismaSkillName[] {
  if (provider === "postgresql") {
    return [...SHARED_PRISMA_SKILLS, "prisma-postgres"];
  }

  return [...SHARED_PRISMA_SKILLS];
}

function getSkillOptions(provider: DatabaseProvider): SkillOption[] {
  const available = getAvailablePrismaSkills(provider);
  const options: Record<PrismaSkillName, SkillOption> = {
    "prisma-cli": {
      value: "prisma-cli",
      label: "prisma-cli",
      hint: "Prisma CLI reference",
    },
    "prisma-client-api": {
      value: "prisma-client-api",
      label: "prisma-client-api",
      hint: "Prisma Client query patterns",
    },
    "prisma-database-setup": {
      value: "prisma-database-setup",
      label: "prisma-database-setup",
      hint: "Database provider setup guides",
    },
    "prisma-upgrade-v7": {
      value: "prisma-upgrade-v7",
      label: "prisma-upgrade-v7",
      hint: "v6 to v7 migration guide",
    },
    "prisma-postgres": {
      value: "prisma-postgres",
      label: "prisma-postgres",
      hint: "Prisma Postgres workflows",
    },
  };

  return available.map((skill) => options[skill]);
}

function collectAddonsFromInput(input: CreateCommandInput): CreateAddon[] {
  const addons: CreateAddon[] = [];

  if (input.skills === true) {
    addons.push("skills");
  }
  if (input.mcp === true) {
    addons.push("mcp");
  }
  if (input.extension === true) {
    addons.push("extension");
  }

  return uniqueValues(addons);
}

const EXTENSION_TARGET_OPTIONS: Array<{
  value: ExtensionTarget;
  label: string;
  hint: string;
}> = [
  {
    value: "vscode",
    label: "VS Code",
    hint: "Uses the `code` CLI",
  },
  {
    value: "cursor",
    label: "Cursor",
    hint: "Uses the `cursor` CLI",
  },
  {
    value: "windsurf",
    label: "Windsurf",
    hint: "Uses the `windsurf` CLI",
  },
];

function uniqueValues<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function getRecommendedPrismaSkills(
  provider: DatabaseProvider,
  shouldUsePrismaPostgres: boolean
): PrismaSkillName[] {
  const skills = [...getAvailablePrismaSkills(provider)];

  if (!shouldUsePrismaPostgres) {
    return skills.filter((skill) => skill !== "prisma-postgres");
  }

  return uniqueValues(skills);
}

async function promptForAddons(): Promise<CreateAddon[] | undefined> {
  const selectedAddons = await multiselect({
    message: "Select add-ons (optional)",
    options: ADDON_OPTIONS,
    required: false,
  });

  if (isCancel(selectedAddons)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return uniqueValues(selectedAddons as CreateAddon[]);
}

async function promptForAddonScope(): Promise<AddonInstallScope | undefined> {
  const selectedScope = await select<AddonInstallScope>({
    message: "Where should add-ons write config?",
    initialValue: DEFAULT_ADDON_SCOPE,
    options: [
      {
        value: "project",
        label: "Project",
        hint: "Recommended for teams (checked into the project when applicable)",
      },
      {
        value: "global",
        label: "Global",
        hint: "Personal machine-level setup",
      },
    ],
  });

  if (isCancel(selectedScope)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return selectedScope;
}

async function promptForPrismaSkills(
  provider: DatabaseProvider,
  recommendedSkills: PrismaSkillName[]
): Promise<PrismaSkillName[] | undefined> {
  const options = getSkillOptions(provider);
  const optionValues = new Set(options.map((option) => option.value));
  const selectedSkills = await multiselect({
    message: "Select Prisma skills",
    options,
    required: false,
    initialValues: recommendedSkills.filter((skill) => optionValues.has(skill)),
  });

  if (isCancel(selectedSkills)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return uniqueValues(selectedSkills as PrismaSkillName[]);
}

async function promptForSkillsAgents(): Promise<string[] | undefined> {
  const selectedAgents = await multiselect({
    message: "Select agents for skills",
    options: SKILLS_AGENT_OPTIONS,
    required: false,
    initialValues: [...DEFAULT_SKILLS_AGENTS],
  });

  if (isCancel(selectedAgents)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return uniqueValues(selectedAgents as string[]);
}

async function promptForMcpAgents(): Promise<string[] | undefined> {
  const selectedAgents = await multiselect({
    message: "Select agents for MCP",
    options: MCP_AGENT_OPTIONS,
    required: false,
    initialValues: [...DEFAULT_MCP_AGENTS],
  });

  if (isCancel(selectedAgents)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return uniqueValues(selectedAgents as string[]);
}

async function promptForExtensionTargets(): Promise<ExtensionTarget[] | undefined> {
  const selectedTargets = await multiselect({
    message: "Select IDEs for extension install",
    options: EXTENSION_TARGET_OPTIONS,
    required: false,
    initialValues: DEFAULT_EXTENSION_TARGETS,
  });

  if (isCancel(selectedTargets)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return uniqueValues(selectedTargets as ExtensionTarget[]);
}

export async function collectCreateAddonSetupContext(
  input: CreateCommandInput,
  options: {
    useDefaults: boolean;
    provider: DatabaseProvider;
    shouldUsePrismaPostgres: boolean;
  }
): Promise<CreateAddonSetupContext | null | undefined> {
  const hasExplicitAddonSelection =
    input.skills !== undefined ||
    input.mcp !== undefined ||
    input.extension !== undefined;
  const selectedFromInput = collectAddonsFromInput(input);
  const selectedAddons =
    selectedFromInput.length > 0
      ? selectedFromInput
      : hasExplicitAddonSelection
        ? []
        : options.useDefaults
          ? []
          : await promptForAddons();
  if (!selectedAddons) {
    return undefined;
  }

  const addons = uniqueValues(selectedAddons);
  if (addons.length === 0) {
    return null;
  }

  const needsScopedConfig = addons.includes("skills") || addons.includes("mcp");
  const scope = needsScopedConfig
    ? options.useDefaults
      ? DEFAULT_ADDON_SCOPE
      : await promptForAddonScope()
    : DEFAULT_ADDON_SCOPE;
  if (!scope) {
    return undefined;
  }

  const recommendedSkills = getRecommendedPrismaSkills(
    options.provider,
    options.shouldUsePrismaPostgres
  );
  const skills =
    !addons.includes("skills")
      ? []
      : options.useDefaults
        ? recommendedSkills
        : await promptForPrismaSkills(options.provider, recommendedSkills);
  if (!skills) {
    return undefined;
  }

  const skillsAgents =
    !addons.includes("skills")
      ? []
      : options.useDefaults
        ? [...DEFAULT_SKILLS_AGENTS]
        : await promptForSkillsAgents();
  if (!skillsAgents) {
    return undefined;
  }

  const mcpAgents =
    !addons.includes("mcp")
      ? []
      : options.useDefaults
        ? [...DEFAULT_MCP_AGENTS]
        : await promptForMcpAgents();
  if (!mcpAgents) {
    return undefined;
  }

  const extensionTargets =
    !addons.includes("extension")
      ? []
      : options.useDefaults
        ? [...DEFAULT_EXTENSION_TARGETS]
        : await promptForExtensionTargets();
  if (!extensionTargets) {
    return undefined;
  }

  return {
    addons,
    scope,
    skills,
    skillsAgents: uniqueValues(skillsAgents),
    mcpAgents: uniqueValues(mcpAgents),
    extensionTargets: uniqueValues(extensionTargets),
  };
}

async function executeExternalCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  verbose: boolean;
}): Promise<void> {
  await execa(params.command, params.args, {
    cwd: params.cwd,
    stdio: params.verbose ? "inherit" : "pipe",
    env: {
      ...process.env,
      CI: "true",
    },
  });
}

async function installSkillsAddon(params: {
  packageManager: PackageManager;
  projectDir: string;
  scope: AddonInstallScope;
  skills: PrismaSkillName[];
  agents: string[];
  verbose: boolean;
}): Promise<string | undefined> {
  if (params.agents.length === 0 || params.skills.length === 0) {
    return "Skipped skills addon because no skills or agents were selected.";
  }

  const scopeArgs = params.scope === "global" ? ["-g"] : [];
  const skillArgs = params.skills.flatMap((skill) => ["-s", skill]);
  const agentArgs = params.agents.flatMap((agent) => ["-a", agent]);
  const commandArgs = [
    "skills@latest",
    "add",
    "prisma/skills",
    ...scopeArgs,
    ...skillArgs,
    ...agentArgs,
    "-y",
  ];
  const execution = getPackageExecutionArgs(params.packageManager, commandArgs);

  try {
    await executeExternalCommand({
      command: execution.command,
      args: execution.args,
      cwd: params.projectDir,
      verbose: params.verbose,
    });
    return;
  } catch (error) {
    return `Skills addon failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function installMcpAddon(params: {
  packageManager: PackageManager;
  projectDir: string;
  scope: AddonInstallScope;
  agents: string[];
  verbose: boolean;
}): Promise<string | undefined> {
  if (params.agents.length === 0) {
    return "Skipped MCP addon because no agents were selected.";
  }

  const scopeArgs = params.scope === "global" ? ["-g"] : [];
  const agentArgs = params.agents.flatMap((agent) => ["-a", agent]);
  const commandArgs = [
    "add-mcp@latest",
    PRISMA_MCP_SERVER,
    ...scopeArgs,
    ...agentArgs,
    "--name",
    "prisma",
    "--gitignore",
    "-y",
  ];
  const execution = getPackageExecutionArgs(params.packageManager, commandArgs);

  try {
    await executeExternalCommand({
      command: execution.command,
      args: execution.args,
      cwd: params.projectDir,
      verbose: params.verbose,
    });
    return;
  } catch (error) {
    return `MCP addon failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function getExtensionInstallBinary(target: ExtensionTarget): string {
  switch (target) {
    case "vscode":
      return "code";
    case "cursor":
      return "cursor";
    case "windsurf":
      return "windsurf";
    default: {
      const exhaustiveCheck: never = target;
      throw new Error(`Unsupported extension target: ${String(exhaustiveCheck)}`);
    }
  }
}

async function installExtensionAddon(params: {
  projectDir: string;
  verbose: boolean;
  targets: ExtensionTarget[];
}): Promise<string[]> {
  if (params.targets.length === 0) {
    return ["Skipped extension addon because no IDE targets were selected."];
  }

  const warnings: string[] = [];

  for (const target of params.targets) {
    const binary = getExtensionInstallBinary(target);

    try {
      await executeExternalCommand({
        command: binary,
        args: ["--version"],
        cwd: params.projectDir,
        verbose: false,
      });
    } catch {
      warnings.push(
        `Skipped ${target} extension install because the \`${binary}\` CLI is not available.`
      );
      continue;
    }

    try {
      await executeExternalCommand({
        command: binary,
        args: ["--install-extension", "Prisma.prisma", "--force"],
        cwd: params.projectDir,
        verbose: params.verbose,
      });
    } catch (error) {
      warnings.push(
        `${target} extension install failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return warnings;
}

export async function executeCreateAddonSetupContext(params: {
  context: CreateAddonSetupContext;
  packageManager: PackageManager;
  projectDir: string;
  verbose: boolean;
}): Promise<void> {
  const { context, packageManager, projectDir, verbose } = params;
  const addonSpinner = spinner();
  addonSpinner.start("Applying selected add-ons...");

  const warnings: string[] = [];

  if (context.addons.includes("skills")) {
    const warning = await installSkillsAddon({
      packageManager,
      projectDir,
      scope: context.scope,
      skills: context.skills,
      agents: context.skillsAgents,
      verbose,
    });
    if (warning) {
      warnings.push(warning);
    }
  }

  if (context.addons.includes("mcp")) {
    const warning = await installMcpAddon({
      packageManager,
      projectDir,
      scope: context.scope,
      agents: context.mcpAgents,
      verbose,
    });
    if (warning) {
      warnings.push(warning);
    }
  }

  if (context.addons.includes("extension")) {
    const extensionWarnings = await installExtensionAddon({
      projectDir,
      verbose,
      targets: context.extensionTargets,
    });
    warnings.push(...extensionWarnings);
  }

  if (warnings.length > 0) {
    addonSpinner.stop("Add-ons applied with warnings.");
    for (const warning of warnings) {
      log.warn(warning);
    }
    return;
  }

  addonSpinner.stop("Add-ons applied.");
}
