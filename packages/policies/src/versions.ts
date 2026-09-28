import { newId } from '@ai-gateway/core';
import { checksumPolicy, type RoutingPolicyDocument } from './policy.js';

export interface PolicyVersion {
  id: string;
  policyId: string;
  version: number;
  document: RoutingPolicyDocument;
  checksum: string;
  createdAt: string;
  createdBy: string;
  note?: string;
  /** Exactly one version per policy is active. */
  active: boolean;
}

export interface StoredPolicy {
  id: string;
  organizationId: string;
  projectId?: string | null;
  name: string;
  activeVersion: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Versioned routing policies.
 *
 * Production routing is not edited in place. Every change creates a new
 * immutable version; activating one is a separate, audited step. That is what
 * makes "roll back the routing change from 14:03" a one-click operation rather
 * than an archaeology exercise.
 */
export class PolicyVersionStore {
  private policies = new Map<string, StoredPolicy>();
  private versions = new Map<string, PolicyVersion[]>();

  create(input: {
    organizationId: string;
    projectId?: string | null;
    name: string;
    document: RoutingPolicyDocument;
    createdBy: string;
    note?: string;
  }): { policy: StoredPolicy; version: PolicyVersion } {
    const now = new Date().toISOString();
    const policy: StoredPolicy = {
      id: newId('pol'),
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      name: input.name,
      activeVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    const version: PolicyVersion = {
      id: newId('ver'),
      policyId: policy.id,
      version: 1,
      document: input.document,
      checksum: checksumPolicy(input.document),
      createdAt: now,
      createdBy: input.createdBy,
      ...(input.note ? { note: input.note } : {}),
      active: true,
    };
    this.policies.set(policy.id, policy);
    this.versions.set(policy.id, [version]);
    return { policy, version };
  }

  /**
   * Add a version without activating it.
   *
   * Deliberately two-step: publishing and rolling out are different decisions,
   * and a gateway that activates on save makes an editor typo a production
   * incident.
   */
  publish(policyId: string, document: RoutingPolicyDocument, createdBy: string, note?: string): PolicyVersion {
    const history = this.versions.get(policyId);
    const policy = this.policies.get(policyId);
    if (!history || !policy) throw new Error(`unknown policy: ${policyId}`);

    const version: PolicyVersion = {
      id: newId('ver'),
      policyId,
      version: history.length + 1,
      document,
      checksum: checksumPolicy(document),
      createdAt: new Date().toISOString(),
      createdBy,
      ...(note ? { note } : {}),
      active: false,
    };
    history.push(version);
    return version;
  }

  activate(policyId: string, version: number): PolicyVersion {
    const history = this.versions.get(policyId);
    const policy = this.policies.get(policyId);
    if (!history || !policy) throw new Error(`unknown policy: ${policyId}`);
    const target = history.find((v) => v.version === version);
    if (!target) throw new Error(`unknown version ${version} for policy ${policyId}`);

    for (const v of history) v.active = v.version === version;
    policy.activeVersion = version;
    policy.updatedAt = new Date().toISOString();
    return target;
  }

  /** Activate the version immediately before the current one. */
  rollback(policyId: string): PolicyVersion {
    const policy = this.policies.get(policyId);
    if (!policy) throw new Error(`unknown policy: ${policyId}`);
    const history = this.history(policyId);
    const currentIndex = history.findIndex((v) => v.version === policy.activeVersion);
    const previous = history[currentIndex - 1];
    if (!previous) throw new Error(`policy ${policyId} has no earlier version to roll back to`);
    return this.activate(policyId, previous.version);
  }

  active(policyId: string): PolicyVersion | undefined {
    return this.versions.get(policyId)?.find((v) => v.active);
  }

  history(policyId: string): PolicyVersion[] {
    return [...(this.versions.get(policyId) ?? [])].sort((a, b) => a.version - b.version);
  }

  get(policyId: string): StoredPolicy | undefined {
    return this.policies.get(policyId);
  }

  list(organizationId: string, projectId?: string): StoredPolicy[] {
    return [...this.policies.values()].filter(
      (p) => p.organizationId === organizationId && (projectId === undefined || p.projectId === projectId),
    );
  }

  /** Human-readable diff between two versions, for the change-review UI. */
  diff(policyId: string, fromVersion: number, toVersion: number): string[] {
    const history = this.history(policyId);
    const from = history.find((v) => v.version === fromVersion);
    const to = history.find((v) => v.version === toVersion);
    if (!from || !to) throw new Error('unknown version');
    return diffObjects(from.document as unknown as Record<string, unknown>, to.document as unknown as Record<string, unknown>, '');
  }
}

function diffObjects(a: Record<string, unknown>, b: Record<string, unknown>, prefix: string): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const left = a[key];
    const right = b[key];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    if (isPlainObject(left) && isPlainObject(right)) {
      out.push(...diffObjects(left, right, path));
      continue;
    }
    if (left === undefined) out.push(`+ ${path} = ${JSON.stringify(right)}`);
    else if (right === undefined) out.push(`- ${path} (was ${JSON.stringify(left)})`);
    else out.push(`~ ${path}: ${JSON.stringify(left)} -> ${JSON.stringify(right)}`);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
