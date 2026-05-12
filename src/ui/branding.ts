import { styleText } from "node:util";

const prismaTitle = `${styleText(["bold", "cyan"], "Create")} ${styleText(
  ["bold", "magenta"],
  "Prisma",
)} ${styleText(["bold", "cyan"], "Next")}`;

export function getCreatePrismaIntro(): string {
  return prismaTitle;
}
