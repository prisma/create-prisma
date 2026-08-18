import { createServer } from "node:http";

import { listUsers } from "./prisma/users";

const port = Number(process.env.PORT ?? 3000);

createServer(async (_request, response) => {
  try {
    const users = await listUsers();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ users }));
  } catch (error) {
    console.error("Failed to query users:", error);
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Could not query users yet." }));
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Server running at http://localhost:${port}`);
});
