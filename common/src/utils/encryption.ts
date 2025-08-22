import { z } from "zod";

export const encryptedFieldSchema = z.object({
  data: z.string(),
  iv: z.string(),
  tag: z.string(),
});
