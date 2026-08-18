import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { listUsers } from "./prisma/users";

const app = new Hono();

app.get("/", (c) => {
  return c.json({
    message: "hello from create-prisma + hono",
  });
});

app.get("/users", async (c) => {
  const users = await listUsers(10).catch((error) => {
    console.error("Failed to query users:", error);
    return undefined;
  });

  if (!users) {
    return c.json({ error: "Could not query users yet. Run contract:emit and apply your schema first." }, 500);
  }

  return c.json(users);
});

const rawPort = (process.env.PORT ?? "").trim();
const parsedPort = rawPort.length > 0 ? Number(rawPort) : Number.NaN;
const port =
  Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 3000;
serve({
  fetch: app.fetch,
  port,
});

console.log(`Server running at http://localhost:${port}`);
