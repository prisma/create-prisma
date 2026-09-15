import { createServer } from "node:http";

import { listUsers } from "@repo/database";

const port = Number(process.env.PORT ?? 3000);

createServer(async (request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Hello World!");
    return;
  }

  if (request.url !== "/users") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
    return;
  }

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
