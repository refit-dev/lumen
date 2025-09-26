import { env } from "../env";
export const isProdOrStaging =
  env.NODE_ENV === "staging" || env.NODE_ENV === "production";
