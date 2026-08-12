import { z } from "zod";

export const widgetSessionResponse = z.object({
  externalUserId: z.string(),
});
