const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function cloneValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function buildModelDefinition(modelId, patch = {}) {
  return {
    id: modelId,
    name: modelId,
    reasoning: true,
    input: ["text"],
    cost: DEFAULT_COST,
    contextWindow: 128000,
    maxTokens: 32000,
    ...patch,
  };
}

function trimString(value) {
  return String(value || "").trim();
}

function trimSecret(value) {
  return String(value || "").trim();
}

function normalizeBaseUrl(value) {
  return trimString(value).replace(/\/+$/, "");
}

function normalizeExtra(extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(extra)
      .map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])
      .filter(([, value]) => value !== "" && value !== null && value !== undefined),
  );
}

const PROVIDER_DEFINITIONS = [
  {
    key: "openai-api",
    label: "OpenAI API Key",
    providerId: "openai",
    authType: "api_key",
    authProviderId: "openai",
    authMethodId: "api-key",
    apiMode: "openai-responses",
    defaultModelId: "gpt-5.4",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "gpt-5.4" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "sk-..." },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "留空使用官方默认地址" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-responses",
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"] })],
      };
    },
  },
  {
    key: "openai-codex",
    label: "OpenAI Codex OAuth",
    providerId: "openai-codex",
    authType: "oauth_redirect_paste",
    authProviderId: "openai-codex",
    authMethodId: "oauth",
    apiMode: "openai-codex-responses",
    defaultModelId: "gpt-5.4",
    defaultBaseUrl: "https://chatgpt.com/backend-api",
    forceRemoteOAuth: true,
    supportsInteractiveAuth: true,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "gpt-5.4" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-codex-responses",
        baseUrl: model.baseUrl || "https://chatgpt.com/backend-api",
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"], contextWindow: 200000, maxTokens: 200000 })],
      };
    },
  },
  {
    key: "google-api",
    label: "Google Gemini API Key",
    providerId: "google",
    authType: "api_key",
    authProviderId: "google",
    authMethodId: "api-key",
    apiMode: "google-generative-ai",
    defaultModelId: "gemini-3.1-pro-preview",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "gemini-3.1-pro-preview" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "AIza..." },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "留空使用官方默认地址" },
    ],
    buildProviderConfig(model) {
      return {
        api: "google-generative-ai",
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"] })],
      };
    },
  },
  {
    key: "google-gemini-cli",
    label: "Gemini CLI OAuth",
    providerId: "google-gemini-cli",
    authType: "oauth_redirect_paste",
    authProviderId: "google-gemini-cli",
    authMethodId: "oauth",
    apiMode: "google-gemini-cli",
    defaultModelId: "gemini-3.1-pro-preview",
    forceRemoteOAuth: true,
    supportsInteractiveAuth: true,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "gemini-3.1-pro-preview" },
    ],
    buildProviderConfig(model) {
      return {
        api: "google-gemini-cli",
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"] })],
      };
    },
  },
  {
    key: "anthropic-api",
    label: "Anthropic API Key",
    providerId: "anthropic",
    authType: "api_key",
    authProviderId: "anthropic",
    authMethodId: "api-key",
    apiMode: "anthropic-messages",
    defaultModelId: "claude-sonnet-4-6",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "claude-sonnet-4-6" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "sk-ant-..." },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "留空使用官方默认地址" },
    ],
    buildProviderConfig(model) {
      return {
        api: "anthropic-messages",
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"] })],
      };
    },
  },
  {
    key: "anthropic-setup-token",
    label: "Anthropic setup-token",
    providerId: "anthropic",
    authType: "external_token_paste",
    authProviderId: "anthropic",
    authMethodId: "setup-token",
    apiMode: "anthropic-messages",
    defaultModelId: "claude-sonnet-4-6",
    supportsInteractiveAuth: true,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "claude-sonnet-4-6" },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "留空使用官方默认地址" },
    ],
    buildProviderConfig(model) {
      return {
        api: "anthropic-messages",
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"] })],
      };
    },
  },
  {
    key: "qwen-oauth",
    label: "Qwen OAuth",
    providerId: "qwen-portal",
    authType: "device_code",
    authProviderId: "qwen-portal",
    authMethodId: "device",
    apiMode: "openai-completions",
    defaultModelId: "coder-model",
    defaultBaseUrl: "https://portal.qwen.ai/v1",
    supportsInteractiveAuth: true,
    fields: [
      { name: "modelId", label: "Model", type: "select", required: true, options: [
        { value: "coder-model", label: "coder-model" },
        { value: "vision-model", label: "vision-model" },
      ] },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://portal.qwen.ai/v1" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-completions",
        baseUrl: model.baseUrl || "https://portal.qwen.ai/v1",
        models: [
          buildModelDefinition("coder-model", { name: "Qwen Coder", reasoning: false }),
          buildModelDefinition("vision-model", { name: "Qwen Vision", reasoning: false, input: ["text", "image"] }),
        ],
      };
    },
  },
  {
    key: "minimax-global-api",
    label: "MiniMax API Key (Global)",
    providerId: "minimax",
    authType: "api_key",
    authProviderId: "minimax",
    authMethodId: "api-global",
    apiMode: "anthropic-messages",
    defaultModelId: "MiniMax-M2.7",
    defaultBaseUrl: "https://api.minimax.io/anthropic",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "MiniMax-M2.7" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "sk-api-..." },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://api.minimax.io/anthropic" },
    ],
    buildProviderConfig(model) {
      return {
        api: "anthropic-messages",
        authHeader: true,
        baseUrl: model.baseUrl || "https://api.minimax.io/anthropic",
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId)],
      };
    },
  },
  {
    key: "minimax-cn-api",
    label: "MiniMax API Key (CN)",
    providerId: "minimax",
    authType: "api_key",
    authProviderId: "minimax",
    authMethodId: "api-cn",
    apiMode: "anthropic-messages",
    defaultModelId: "MiniMax-M2.7",
    defaultBaseUrl: "https://api.minimaxi.com/anthropic",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "MiniMax-M2.7" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "sk-api-..." },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://api.minimaxi.com/anthropic" },
    ],
    buildProviderConfig(model) {
      return {
        api: "anthropic-messages",
        authHeader: true,
        baseUrl: model.baseUrl || "https://api.minimaxi.com/anthropic",
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId)],
      };
    },
  },
  {
    key: "minimax-global-oauth",
    label: "MiniMax OAuth (Global)",
    providerId: "minimax-portal",
    authType: "device_code",
    authProviderId: "minimax-portal",
    authMethodId: "oauth",
    apiMode: "anthropic-messages",
    defaultModelId: "MiniMax-M2.7",
    defaultBaseUrl: "https://api.minimax.io/anthropic",
    supportsInteractiveAuth: true,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "MiniMax-M2.7" },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://api.minimax.io/anthropic" },
    ],
    buildProviderConfig(model) {
      return {
        api: "anthropic-messages",
        authHeader: true,
        baseUrl: model.baseUrl || "https://api.minimax.io/anthropic",
        models: [buildModelDefinition(model.modelId)],
      };
    },
  },
  {
    key: "minimax-cn-oauth",
    label: "MiniMax OAuth (CN)",
    providerId: "minimax-portal",
    authType: "device_code",
    authProviderId: "minimax-portal",
    authMethodId: "oauth-cn",
    apiMode: "anthropic-messages",
    defaultModelId: "MiniMax-M2.7",
    defaultBaseUrl: "https://api.minimaxi.com/anthropic",
    supportsInteractiveAuth: true,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "MiniMax-M2.7" },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://api.minimaxi.com/anthropic" },
    ],
    buildProviderConfig(model) {
      return {
        api: "anthropic-messages",
        authHeader: true,
        baseUrl: model.baseUrl || "https://api.minimaxi.com/anthropic",
        models: [buildModelDefinition(model.modelId)],
      };
    },
  },
  {
    key: "chutes-api",
    label: "Chutes API Key",
    providerId: "chutes",
    authType: "api_key",
    authProviderId: "chutes",
    authMethodId: "api-key",
    apiMode: "openai-completions",
    defaultModelId: "zai-org/GLM-4.7-TEE",
    defaultBaseUrl: "https://llm.chutes.ai/v1",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "zai-org/GLM-4.7-TEE" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "留空不可用" },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://llm.chutes.ai/v1" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-completions",
        baseUrl: model.baseUrl || "https://llm.chutes.ai/v1",
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"] })],
      };
    },
  },
  {
    key: "chutes-oauth",
    label: "Chutes OAuth",
    providerId: "chutes",
    authType: "oauth_redirect_paste",
    authProviderId: "chutes",
    authMethodId: "oauth",
    apiMode: "openai-completions",
    defaultModelId: "zai-org/GLM-4.7-TEE",
    defaultBaseUrl: "https://llm.chutes.ai/v1",
    forceRemoteOAuth: true,
    supportsInteractiveAuth: true,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "zai-org/GLM-4.7-TEE" },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://llm.chutes.ai/v1" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-completions",
        baseUrl: model.baseUrl || "https://llm.chutes.ai/v1",
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"] })],
      };
    },
  },
  {
    key: "github-copilot",
    label: "GitHub Copilot",
    providerId: "github-copilot",
    authType: "device_code",
    authProviderId: "github-copilot",
    authMethodId: "device",
    apiMode: "openai-responses",
    defaultModelId: "gpt-4o",
    defaultBaseUrl: "https://api.individual.githubcopilot.com",
    supportsInteractiveAuth: true,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "gpt-4o" },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://api.individual.githubcopilot.com" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-responses",
        baseUrl: model.baseUrl || "https://api.individual.githubcopilot.com",
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"] })],
      };
    },
  },
  {
    key: "moonshot-api",
    label: "Moonshot API Key (.ai)",
    providerId: "moonshot",
    authType: "api_key",
    authProviderId: "moonshot",
    authMethodId: "api-key",
    apiMode: "openai-completions",
    defaultModelId: "kimi-k2.5",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "kimi-k2.5" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "sk-..." },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://api.moonshot.ai/v1" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-completions",
        baseUrl: model.baseUrl || "https://api.moonshot.ai/v1",
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"] })],
      };
    },
  },
  {
    key: "moonshot-api-cn",
    label: "Moonshot API Key (.cn)",
    providerId: "moonshot",
    authType: "api_key",
    authProviderId: "moonshot",
    authMethodId: "api-key-cn",
    apiMode: "openai-completions",
    defaultModelId: "kimi-k2.5",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "kimi-k2.5" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "sk-..." },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://api.moonshot.cn/v1" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-completions",
        baseUrl: model.baseUrl || "https://api.moonshot.cn/v1",
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId, { input: ["text", "image"] })],
      };
    },
  },
  {
    key: "zai-api",
    label: "Z.AI API Key",
    providerId: "zai",
    authType: "api_key",
    authProviderId: "zai",
    authMethodId: "api-key",
    apiMode: "openai-completions",
    defaultModelId: "glm-5",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "glm-5" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "留空不可用" },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://api.z.ai/api/paas/v4" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-completions",
        baseUrl: model.baseUrl || "https://api.z.ai/api/paas/v4",
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId)],
      };
    },
  },
  {
    key: "zai-coding-global",
    label: "Z.AI Coding Plan Global",
    providerId: "zai",
    authType: "api_key",
    authProviderId: "zai",
    authMethodId: "coding-global",
    apiMode: "openai-completions",
    defaultModelId: "glm-5",
    defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "glm-5" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "留空不可用" },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://api.z.ai/api/coding/paas/v4" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-completions",
        baseUrl: model.baseUrl || "https://api.z.ai/api/coding/paas/v4",
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId)],
      };
    },
  },
  {
    key: "zai-coding-cn",
    label: "Z.AI Coding Plan CN",
    providerId: "zai",
    authType: "api_key",
    authProviderId: "zai",
    authMethodId: "coding-cn",
    apiMode: "openai-completions",
    defaultModelId: "glm-5",
    defaultBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    supportsInteractiveAuth: false,
    fields: [
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "glm-5" },
      { name: "apiKey", label: "API Key", type: "password", required: true, placeholder: "留空不可用" },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://open.bigmodel.cn/api/coding/paas/v4" },
    ],
    buildProviderConfig(model) {
      return {
        api: "openai-completions",
        baseUrl: model.baseUrl || "https://open.bigmodel.cn/api/coding/paas/v4",
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId)],
      };
    },
  },
  {
    key: "custom-provider",
    label: "自定义 Provider",
    providerId: "",
    authType: "custom_gateway",
    authProviderId: "",
    authMethodId: "",
    apiMode: "openai-responses",
    defaultModelId: "",
    supportsInteractiveAuth: false,
    fields: [
      { name: "providerId", label: "Provider ID", type: "text", required: true, placeholder: "my-provider" },
      { name: "modelId", label: "Model", type: "text", required: true, placeholder: "gpt-4.1" },
      { name: "apiMode", label: "API Mode", type: "select", required: true, options: [
        { value: "openai-responses", label: "openai-responses" },
        { value: "openai-completions", label: "openai-completions" },
        { value: "anthropic-messages", label: "anthropic-messages" },
        { value: "google-generative-ai", label: "google-generative-ai" },
        { value: "google-gemini-cli", label: "google-gemini-cli" },
      ] },
      { name: "baseUrl", label: "Base URL", type: "text", required: false, placeholder: "https://..." },
      { name: "apiKey", label: "API Key", type: "password", required: false, placeholder: "留空表示不写入 apiKey" },
    ],
    buildProviderConfig(model) {
      return {
        api: model.apiMode,
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        models: [buildModelDefinition(model.modelId)],
      };
    },
  },
];

const PROVIDER_MAP = new Map(PROVIDER_DEFINITIONS.map((definition) => [definition.key, definition]));

function guessProviderKeyFromLegacyModel(model = {}) {
  const providerId = trimString(model.providerId).toLowerCase();
  const apiMode = trimString(model.apiMode).toLowerCase();
  const baseUrl = normalizeBaseUrl(model.baseUrl).toLowerCase();
  const authMethodId = trimString(model.authMethodId).toLowerCase();

  if (providerId === "openai-codex") return "openai-codex";
  if (providerId === "google-gemini-cli") return "google-gemini-cli";
  if (providerId === "qwen-portal") return "qwen-oauth";
  if (providerId === "github-copilot") return "github-copilot";
  if (providerId === "chutes" && authMethodId === "oauth") return "chutes-oauth";
  if (providerId === "chutes") return "chutes-api";
  if (providerId === "minimax-portal") {
    if (authMethodId === "oauth-cn" || baseUrl.includes("minimaxi.com")) return "minimax-cn-oauth";
    return "minimax-global-oauth";
  }
  if (providerId === "moonshot" && baseUrl.includes("moonshot.cn")) return "moonshot-api-cn";
  if (providerId === "moonshot") return "moonshot-api";
  if (providerId === "google") return "google-api";
  if (providerId === "openai") return "openai-api";
  if (providerId === "zai" && authMethodId === "coding-global") return "zai-coding-global";
  if (providerId === "zai" && authMethodId === "coding-cn") return "zai-coding-cn";
  if (providerId === "zai") return "zai-api";
  if (providerId === "anthropic" && authMethodId === "setup-token") return "anthropic-setup-token";
  if (providerId === "anthropic" || apiMode === "anthropic-messages") return "anthropic-api";
  if (providerId === "minimax" && baseUrl.includes("minimaxi.com")) return "minimax-cn-api";
  if (providerId === "minimax") return "minimax-global-api";
  return "custom-provider";
}

function normalizeModelCore(definition, patch = {}, existingModel = null) {
  const providerId = trimString(
    patch.providerId ?? existingModel?.providerId ?? definition?.providerId ?? "",
  ).toLowerCase();
  const modelId = trimString(
    patch.modelId ?? existingModel?.modelId ?? definition?.defaultModelId ?? "",
  );
  const apiMode = trimString(
    patch.apiMode ?? existingModel?.apiMode ?? definition?.apiMode ?? "openai-responses",
  );
  const baseUrl = normalizeBaseUrl(
    patch.baseUrl ?? existingModel?.baseUrl ?? definition?.defaultBaseUrl ?? "",
  );
  const rawApiKey = patch.apiKey;
  const shouldKeepExistingApiKey =
    rawApiKey !== undefined &&
    trimSecret(rawApiKey) === "" &&
    existingModel?.providerKey === definition?.key;
  const apiKey = trimSecret(
    shouldKeepExistingApiKey
      ? (existingModel?.apiKey || "")
      : (rawApiKey !== undefined ? rawApiKey : (existingModel?.apiKey || "")),
  );
  const providerConfig = patch.providerConfig !== undefined
    ? cloneValue(patch.providerConfig)
    : cloneValue(existingModel?.providerConfig || null);
  const extra = normalizeExtra(patch.extra ?? existingModel?.extra);

  return {
    providerKey: definition?.key || "custom-provider",
    providerId,
    modelId,
    apiMode,
    authType: definition?.authType || "custom_gateway",
    authProviderId: trimString(definition?.authProviderId || providerId),
    authMethodId: trimString(definition?.authMethodId || ""),
    baseUrl,
    apiKey,
    providerConfig,
    extra,
  };
}

export function listModelProviders() {
  return PROVIDER_DEFINITIONS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    providerId: definition.providerId,
    authType: definition.authType,
    authProviderId: definition.authProviderId,
    authMethodId: definition.authMethodId,
    apiMode: definition.apiMode,
    defaultModelId: definition.defaultModelId,
    defaultBaseUrl: definition.defaultBaseUrl || "",
    supportsInteractiveAuth: Boolean(definition.supportsInteractiveAuth),
    forceRemoteOAuth: Boolean(definition.forceRemoteOAuth),
    fields: cloneValue(definition.fields || []),
  }));
}

export function getModelProviderDefinition(key) {
  return PROVIDER_MAP.get(String(key || "").trim()) || null;
}

export function normalizeModelSelection(model) {
  if (!model || typeof model !== "object") {
    return null;
  }

  const providerKey = trimString(model.providerKey) || guessProviderKeyFromLegacyModel(model);
  const definition = getModelProviderDefinition(providerKey) || getModelProviderDefinition("custom-provider");
  return normalizeModelCore(definition, model, null);
}

export function sanitizeModelSelectionPayload(payload = {}, existingModel = null) {
  const normalizedExisting = normalizeModelSelection(existingModel);
  const requestedKey = trimString(payload.providerKey) || normalizedExisting?.providerKey || guessProviderKeyFromLegacyModel(payload);
  const definition = getModelProviderDefinition(requestedKey) || getModelProviderDefinition("custom-provider");
  const next = normalizeModelCore(definition, payload, normalizedExisting);

  if (!next.providerId || !next.modelId || !next.apiMode) {
    throw new Error("模型配置不完整，请至少填写 provider、model 和 API 模式。");
  }

  if (definition.authType === "api_key" && !next.apiKey) {
    throw new Error("当前模型需要 API Key。");
  }

  return next;
}

export function buildProviderConfigFromModel(model) {
  const normalized = normalizeModelSelection(model);
  if (!normalized) {
    return null;
  }

  const definition = getModelProviderDefinition(normalized.providerKey) || getModelProviderDefinition("custom-provider");
  const savedConfig = cloneValue(normalized.providerConfig);
  const baseConfig = savedConfig && typeof savedConfig === "object"
    ? savedConfig
    : definition.buildProviderConfig(normalized);

  if (!baseConfig || typeof baseConfig !== "object") {
    return null;
  }

  const next = {
    ...baseConfig,
    api: trimString(baseConfig.api || normalized.apiMode || definition.apiMode),
  };

  if (normalized.baseUrl && !next.baseUrl) {
    next.baseUrl = normalized.baseUrl;
  }

  if (normalized.apiKey) {
    next.apiKey = normalized.apiKey;
  }

  if (!Array.isArray(next.models) || next.models.length === 0) {
    next.models = [buildModelDefinition(normalized.modelId)];
  } else if (!next.models.some((entry) => String(entry?.id || "") === normalized.modelId)) {
    next.models = [...next.models, buildModelDefinition(normalized.modelId)];
  }

  return next;
}
