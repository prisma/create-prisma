import { styleText } from "node:util";

const prismaMark = styleText(["bold", "cyanBright"], "◭");
const createLabel = styleText(["bold", "cyanBright"], "Create");
const prismaLabel = styleText(["bold", "magentaBright"], "Prisma");
const versionLabel = styleText(["bold", "blueBright"], "8");
const prismaTitle = `${prismaMark} ${createLabel} ${prismaLabel} ${versionLabel}`;

export function getCreatePrismaIntro(): string {
  return prismaTitle;
}
