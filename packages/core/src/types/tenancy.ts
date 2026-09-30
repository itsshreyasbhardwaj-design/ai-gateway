export type ApiKeyScope = 'models.read' | 'inference.create' | 'usage.read' | 'logs.read' | 'admin';

export const ALL_SCOPES: ApiKeyScope[] = [
  'models.read',
  'inference.create',
  'usage.read',
  'logs.read',
  'admin',
];

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

/** How long request bodies are kept. Defaults are deliberately privacy-conservative. */
export type PromptRetentionMode = 'none' | 'metadata_only' | 'redacted' | 'full';

export interface PromptPrivacySettings {
  mode: PromptRetentionMode;
  /** Days to keep stored prompt/response bodies. Ignored when mode is `none`. */
  retentionDays: number;
}

export const DEFAULT_PRIVACY: PromptPrivacySettings = {
  mode: 'metadata_only',
  retentionDays: 30,
};

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  privacy: PromptPrivacySettings;
  /** Null means every registered model is allowed. */
  allowedModels?: string[] | null;
  deniedModels?: string[];
  /** ISO 4217 code used for budget and cost display. */
  currency: string;
}

export interface OrganizationMember {
  organizationId: string;
  userId: string;
  role: OrgRole;
  createdAt: string;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: string;
  /** Overrides the org list when set. */
  allowedModels?: string[] | null;
  deniedModels?: string[];
  routingPolicyId?: string | null;
  privacy?: PromptPrivacySettings | null;
  archived?: boolean;
}

export interface ApiKeyRecord {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  /** Non-secret display prefix, e.g. `aigw_live_a1b2c3`. */
  prefix: string;
  /** Argon2id/scrypt hash. The plaintext is shown once at creation and never stored. */
  hash: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  /** Set when the key was created by rotating an older one. */
  rotatedFrom?: string | null;
}

export interface AuthContext {
  organizationId: string;
  projectId: string;
  apiKeyId: string;
  scopes: ApiKeyScope[];
}

export function hasScope(ctx: Pick<AuthContext, 'scopes'>, scope: ApiKeyScope): boolean {
  return ctx.scopes.includes('admin') || ctx.scopes.includes(scope);
}
