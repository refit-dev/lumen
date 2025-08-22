import { Session, User } from "better-auth";

// Extended User type that includes properties from Better Auth plugins (like admin plugin)
export type ExtendedUser = User & {
  role?: string;
};

// Extended Session type that includes properties from Better Auth plugins
export type ExtendedSession = Session & {
  impersonatedBy?: string;
};

export type EnhancedSession = {
  user: ExtendedUser | null;
  session: ExtendedSession | null;
  organization: {
    id: string;
    name: string;
    slug: string | null;
  } | null;
  merchant: {
    id: string;
    defaultCurrency?: string | null;
    legalName?: string | null;
    displayName?: string | null;
  } | null;
};
