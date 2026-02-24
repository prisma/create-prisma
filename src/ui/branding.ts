import { styleText } from "node:util";

const prismaTitle = `${styleText(["bold", "cyan"], "Create")} ${styleText(
  ["bold", "magenta"],
  "Prisma"
)}`;

export function getCreatePrismaIntro(): string {
  return prismaTitle;
}
