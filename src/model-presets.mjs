import {
  getModelProviderDefinition,
  normalizeModelSelection,
  sanitizeModelSelectionPayload,
} from "./model-providers.mjs";

function trimString(value) {
  return String(value || "").trim();
}

function describePreset(preset) {
  const name = trimString(preset?.name);
  if (name) {
    return name;
  }

  const providerId = trimString(preset?.providerId);
  const modelId = trimString(preset?.modelId);
  if (providerId || modelId) {
    return `${providerId || "unknown"}/${modelId || "unknown"}`;
  }

  return "默认模型预设";
}

export function normalizeModelPresetPayload(payload = {}, existingModel = null) {
  return sanitizeModelSelectionPayload(payload, existingModel, { allowMissingApiKey: true });
}

export function isModelPresetConfigured(preset) {
  const normalized = normalizeModelSelection(preset);
  if (!normalized) {
    return false;
  }

  const definition = getModelProviderDefinition(normalized.providerKey)
    || getModelProviderDefinition("custom-provider");

  if (!definition) {
    return false;
  }

  if (definition.authType === "api_key") {
    return Boolean(trimString(normalized.apiKey));
  }

  if (definition.authType === "custom_gateway") {
    return Boolean(trimString(normalized.baseUrl) || trimString(normalized.apiKey));
  }

  return true;
}

export function resolveModelPresetForRuntime(preset, existingModel = null) {
  try {
    return sanitizeModelSelectionPayload(preset, existingModel);
  } catch (error) {
    const normalized = normalizeModelSelection(preset);
    const definition = getModelProviderDefinition(normalized?.providerKey || preset?.providerKey)
      || getModelProviderDefinition("custom-provider");

    if (definition?.authType === "api_key" && !trimString(normalized?.apiKey || preset?.apiKey)) {
      throw new Error(`模型预设“${describePreset(preset)}”尚未配置 API Key，请先由管理员补全。`);
    }

    throw error;
  }
}
