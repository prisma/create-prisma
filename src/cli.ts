import { intro, outro, text, isCancel } from "@clack/prompts";

export async function run(): Promise<void> {
	intro("create-prisma");

	const projectName = await text({
		message: "Project name",
		placeholder: "my-app",
		validate(value) {
			if (!value || !value.trim()) return "Please enter a project name";
		}
	});

	if (isCancel(projectName)) {
		outro("Cancelled.");
		process.exit(0);
		return;
	}

	outro(`Scaffold would run for "${projectName}".`);
}

// Allow running directly when transpiled or executed with a TS runner.
if (import.meta.url === `file://${process.argv[1]}`) {
	run().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}


