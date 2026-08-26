export function redactSecrets(message: string): string {
  return message
    .replace(
      /\b((?:(?:prisma\+)?postgres(?:ql)?|mongodb(?:\+srv)?):\/\/)[^\s'"]+/gi,
      "$1<redacted>",
    )
    .replace(
      /\b([A-Z0-9_]*(?:MONGODB_(?:URL|URI)|DATABASE_URL|TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1<redacted>",
    )
    .replace(/(\bAuthorization\s*:\s*Bearer\s+)[^\s'"]+/gi, "$1<redacted>");
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    if (stderr) return redactSecrets(stderr);
  }
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
