import type { PageServerLoad } from "./$types";

import { listUsers } from "../prisma/users";

export const load: PageServerLoad = async () => {
  const users = await listUsers(10)
    .then((rows) =>
      rows.map((user) => ({
        ...user,
        createdAt: user.createdAt ?? null,
      }))
    )
    .catch(() => undefined);

  return { users };
};
