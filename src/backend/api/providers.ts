import { apiRequest } from "./request";

export interface ProviderResponse {
  id: string;
  name: string;
  provider_type: string;
  provider_category?: "base" | "byok" | null;
  auth_type?: "api" | "oauth";
  api_key?: string;
  base_url?: string;
  timeout?: number | false;
  access_key?: string;
  region?: string;
}

export async function listProviders(): Promise<ProviderResponse[]> {
  try {
    return await apiRequest<ProviderResponse[]>("GET", "/v1/providers");
  } catch {
    return [];
  }
}

export async function getProviderByName(
  providerName: string,
): Promise<ProviderResponse | null> {
  const providers = await listProviders();
  return providers.find((provider) => provider.name === providerName) ?? null;
}

export async function checkProviderApiKey(
  providerType: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  baseURL?: string,
): Promise<void> {
  await apiRequest<{ message: string }>("POST", "/v1/providers/check", {
    provider_type: providerType,
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
    ...(baseURL && { base_url: baseURL }),
  });
}

export async function createProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  baseURL?: string,
): Promise<ProviderResponse> {
  return apiRequest<ProviderResponse>("POST", "/v1/providers", {
    name: providerName,
    provider_type: providerType,
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
    ...(baseURL && { base_url: baseURL }),
  });
}

export async function updateProvider(
  providerId: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  baseURL?: string,
): Promise<ProviderResponse> {
  return apiRequest<ProviderResponse>("PATCH", `/v1/providers/${providerId}`, {
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
    ...(baseURL && { base_url: baseURL }),
  });
}

export async function deleteProvider(providerId: string): Promise<void> {
  await apiRequest<void>("DELETE", `/v1/providers/${providerId}`);
}

export async function createOrUpdateProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  baseURL?: string,
): Promise<ProviderResponse> {
  const existing = await getProviderByName(providerName);
  if (existing) {
    return updateProvider(
      existing.id,
      apiKey,
      accessKey,
      region,
      profile,
      baseURL,
    );
  }
  return createProvider(
    providerType,
    providerName,
    apiKey,
    accessKey,
    region,
    profile,
    baseURL,
  );
}

export async function removeProviderByName(
  providerName: string,
): Promise<void> {
  const existing = await getProviderByName(providerName);
  if (existing) {
    await deleteProvider(existing.id);
  }
}
