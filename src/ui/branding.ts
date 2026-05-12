import { styleText } from "node:util";

const prismaMark = styleText(["bold", "cyanBright"], "◭");
const createLabel = styleText(["bold", "cyanBright"], "Create");
const prismaLabel = styleText(["bold", "magentaBright"], "Prisma");
const nextLabel = styleText(["bold", "blueBright"], "Next");
const prismaTitle = `${prismaMark} ${createLabel} ${prismaLabel} ${nextLabel}`;

export function getCreatePrismaIntro(): string {
  return prismaTitle;
}
