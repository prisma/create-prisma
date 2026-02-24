import pc from "picocolors";

const prismaTitle = `${pc.bold(pc.cyan("Create"))} ${pc.bold(pc.magenta("Prisma"))}`;

export function getCreatePrismaIntro(): string {
  return prismaTitle;
}
