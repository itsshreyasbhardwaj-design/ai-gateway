import { DEFAULT_PRIVACY, GatewayError, type ModelDescriptor, type Organization, type Project } from '@ai-gateway/core';
import { DEFAULT_POLICY, parsePolicyOrThrow, type RoutingPolicyDocument } from '@ai-gateway/policies';
import type { Budget } from '@ai-gateway/usage';
import type { GatewayContext } from '../context.js';
import type { AuthenticatedKey } from '../auth.js';

export interface TenantContext {
  organization: Organization;
  project: Project;
  policy: RoutingPolicyDocument;
  policyId?: string;
  policyVersion?: number;
  budgets: Budget[];
  /** Models registered on this gateway, before allow/deny filtering. */
  registeredModels: ModelDescriptor[];
  privacy: Organization['privacy'];
}

/**
 * Load everything tenant-specific for a request.
 *
 * Resolution order for the routing policy: the project's assigned policy, then
 * the organization's default, then the built-in starter policy. A project with
 * a dangling policy id is an error rather than a silent fall-through to
 * defaults - routing that quietly changes is the failure mode the gateway is
 * meant to prevent.
 */
export async function loadTenant(ctx: GatewayContext, auth: AuthenticatedKey): Promise<TenantContext> {
  const [organization, project] = await Promise.all([
    ctx.store.getOrganization(auth.organizationId),
    ctx.store.getProject(auth.projectId),
  ]);

  if (!organization) {
    throw new GatewayError('authentication_error', 'The organization for this API key no longer exists.');
  }
  if (!project || project.organizationId !== organization.id) {
    throw new GatewayError('authentication_error', 'The project for this API key no longer exists.');
  }
  if (project.archived) {
    throw new GatewayError('permission_denied', `Project "${project.name}" is archived.`);
  }

  const { policy, policyId, policyVersion } = await resolvePolicy(ctx, organization, project);
  const budgets = await ctx.store.listBudgets(organization.id);

  return {
    organization,
    project,
    policy,
    policyId,
    policyVersion,
    budgets: budgets.filter((b) => budgetApplies(b, project.id, auth.apiKeyId)),
    registeredModels: ctx.providers.listModels(),
    privacy: project.privacy ?? organization.privacy ?? DEFAULT_PRIVACY,
  };
}

async function resolvePolicy(
  ctx: GatewayContext,
  organization: Organization,
  project: Project,
): Promise<{ policy: RoutingPolicyDocument; policyId?: string; policyVersion?: number }> {
  if (project.routingPolicyId) {
    const version = await ctx.store.getActivePolicyVersion(project.routingPolicyId);
    if (!version) {
      throw new GatewayError(
        'internal_error',
        `Project "${project.name}" references routing policy "${project.routingPolicyId}", which has no active version.`,
      );
    }
    return {
      policy: parsePolicyOrThrow(version.document),
      policyId: version.policyId,
      policyVersion: version.version,
    };
  }

  const orgPolicies = await ctx.store.listPolicies(organization.id, undefined);
  const orgDefault = orgPolicies.find((p) => p.projectId === null);
  if (orgDefault) {
    const version = await ctx.store.getActivePolicyVersion(orgDefault.id);
    if (version) {
      return {
        policy: parsePolicyOrThrow(version.document),
        policyId: version.policyId,
        policyVersion: version.version,
      };
    }
  }

  return { policy: fallbackPolicy(ctx) };
}

/**
 * Starter policy for an org that has not configured one.
 *
 * It routes across whatever is actually registered rather than pretending a
 * model exists: an empty gateway produces a clear `no_route_available` instead
 * of a confusing `model_not_found`.
 */
function fallbackPolicy(ctx: GatewayContext): RoutingPolicyDocument {
  const models = ctx.providers.listModels().filter((m) => m.capabilities.includes('chat'));
  if (models.length === 0) return DEFAULT_POLICY;
  return {
    ...DEFAULT_POLICY,
    name: 'implicit-default',
    description: 'Generated because no routing policy is configured. Reliability-first across every registered model.',
    routing: {
      strategy: 'highest_reliability',
      models: models.slice(0, 20).map((m) => m.id),
    },
  };
}

function budgetApplies(budget: Budget, projectId: string, apiKeyId: string): boolean {
  if (budget.scope === 'organization') return true;
  if (budget.scope === 'project') return budget.scopeId === projectId;
  if (budget.scope === 'api_key') return budget.scopeId === apiKeyId;
  return false;
}
