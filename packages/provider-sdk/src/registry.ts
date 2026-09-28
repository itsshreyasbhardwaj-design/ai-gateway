import { GatewayError, type AIProvider, type ModelDescriptor } from '@ai-gateway/core';

/**
 * Runtime index of configured providers and the models they serve.
 *
 * The router asks this registry what exists; it never reasons about vendors
 * directly. Adding a provider is a registration, not a code change in the
 * request path.
 */
export class ProviderRegistry {
  private providers = new Map<string, AIProvider>();
  private models = new Map<string, ModelDescriptor>();
  private modelsByProvider = new Map<string, ModelDescriptor[]>();

  register(provider: AIProvider, models: ModelDescriptor[]): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    const owned: ModelDescriptor[] = [];
    for (const model of models) {
      if (model.providerId !== provider.id) {
        throw new Error(
          `model ${model.id} declares provider ${model.providerId} but was registered under ${provider.id}`,
        );
      }
      this.models.set(model.id, model);
      owned.push(model);
    }
    this.modelsByProvider.set(provider.id, owned);
  }

  unregister(providerId: string): void {
    this.providers.delete(providerId);
    for (const model of this.modelsByProvider.get(providerId) ?? []) {
      this.models.delete(model.id);
    }
    this.modelsByProvider.delete(providerId);
  }

  /** Replace a provider's model list in place, e.g. after a discovery refresh. */
  setModels(providerId: string, models: ModelDescriptor[]): void {
    if (!this.providers.has(providerId)) {
      throw new Error(`unknown provider: ${providerId}`);
    }
    for (const old of this.modelsByProvider.get(providerId) ?? []) this.models.delete(old.id);
    for (const model of models) this.models.set(model.id, model);
    this.modelsByProvider.set(providerId, models);
  }

  getProvider(id: string): AIProvider | undefined {
    return this.providers.get(id);
  }

  requireProvider(id: string): AIProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new GatewayError('no_route_available', `No provider registered with id "${id}".`);
    }
    return provider;
  }

  getModel(id: string): ModelDescriptor | undefined {
    return this.models.get(id);
  }

  requireModel(id: string): ModelDescriptor {
    const model = this.models.get(id);
    if (!model) {
      throw new GatewayError('model_not_found', `Model "${id}" is not registered on this gateway.`, {
        details: { model: id },
      });
    }
    return model;
  }

  listProviders(): AIProvider[] {
    return [...this.providers.values()];
  }

  listProviderIds(): string[] {
    return [...this.providers.keys()];
  }

  listModels(providerId?: string): ModelDescriptor[] {
    if (providerId) return [...(this.modelsByProvider.get(providerId) ?? [])];
    return [...this.models.values()];
  }

  get size(): number {
    return this.providers.size;
  }
}
