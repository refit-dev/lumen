import { createAccessControl } from "better-auth/plugins/access";

const statement = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  merchant: ["view", "update"],
  plans: ["create", "update", "delete", "view"],
  customers: ["create", "update", "delete", "view"],
  subscriptions: ["create", "update", "delete", "pause", "resume", "view"],
  invoices: ["create", "view", "send"],
  api_keys: ["create", "rotate", "delete", "view"],
  analytics: ["view"],
} as const;

export const ac = createAccessControl(statement);

export const ownerRole = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  merchant: ["view", "update"],
  plans: ["create", "update", "delete", "view"],
  customers: ["create", "update", "delete", "view"],
  subscriptions: ["create", "update", "delete", "pause", "resume", "view"],
  invoices: ["create", "view", "send"],
  api_keys: ["create", "rotate", "delete", "view"],
  analytics: ["view"],
});

export const adminRole = ac.newRole({
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  merchant: ["view", "update"],
  plans: ["create", "update", "delete", "view"],
  customers: ["create", "update", "delete", "view"],
  subscriptions: ["create", "update", "delete", "pause", "resume", "view"],
  invoices: ["create", "view", "send"],
  api_keys: ["create", "rotate", "delete", "view"],
  analytics: ["view"],
});

export const memberRole = ac.newRole({
  merchant: ["view"],
  plans: ["view"],
  customers: ["view"],
  subscriptions: ["view"],
  invoices: ["view"],
  analytics: ["view"],
});

export const developerRole = ac.newRole({
  merchant: ["view", "update"],
  plans: ["create", "update", "delete", "view"],
  customers: ["create", "update", "delete", "view"],
  subscriptions: ["create", "update", "delete", "pause", "resume", "view"],
  invoices: ["create", "view", "send"],
  analytics: ["view"],
  api_keys: ["view"],
});
