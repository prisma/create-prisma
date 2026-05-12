import { styleText } from "node:util";

const prismaMark = styleText(["bold", "cyan"], "◭");
const prismaTitle = `${prismaMark} ${styleText(["bold", "cyan"], "Create")} ${styleText(
  ["bold", "magenta"],
  "Prisma",
)} ${styleText(["bold", "cyan"], "Next")}`;

export function getCreatePrismaIntro(): string {
  return prismaTitle;
}
