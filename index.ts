import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { aesGcmEncrypt } from "openclaw/plugin-sdk/coclaw";

import { fetchWithSsrFGuard, formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { getStrings } from "./i18n/index.js";
import {
  generatePkce,
  requestDeviceCode,
  pollDeviceToken,
  type QwenOAuthToken,
} from "./qwen-oauth.js";
import { getGlobalAesGcmKey } from "openclaw/plugin-sdk/coclaw";

/** Config shape for RPC (providerKey, baseUrl, apiKey, modelName) */
type ConfigShape = {
  providerKey?: string;
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
};

const DEFAULT_CONFIG: ConfigShape = {
  providerKey: "zte",
  baseUrl: "",
  apiKey: "",
  modelName: "",
};

const QWEN_PROVIDER_ID = "qwen-portal";
const UNICOM_PROVIDER_ID = "cloudpc-unicom";
const QWEN_OAUTH_PLACEHOLDER = "qwen-oauth";
const QWEN_DEFAULT_BASE_URL = "https://portal.qwen.ai/v1";
const DEFAULT_AGENT_ID = "main";
const AUTH_PROFILE_FILENAME = "auth-profiles.json";

type ActiveAuthMode = "qwen-oauth" | "unicom-provision" | "api-key" | "none";

function normalizeBaseUrl(value: string | undefined): string {
  const raw = (value ?? "").trim() || QWEN_DEFAULT_BASE_URL;
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  return withProtocol.endsWith("/v1") ? withProtocol : `${withProtocol.replace(/\/+$/, "")}/v1`;
}

function readErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code.trim()) {
    return code.trim();
  }
  if (typeof code === "number" && Number.isFinite(code)) {
    return String(code);
  }
  return null;
}

function formatModelTestErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) {
    const fallback = formatErrorMessage(err).trim();
    return fallback || "unknown error";
  }
  const message = err.message.trim();
  if (message.toLowerCase() !== "fetch failed") {
    return message || "unknown error";
  }
  const causeCode = readErrorCode(err.cause);
  const causeMessage = formatErrorMessage(err.cause).trim();
  if (causeCode && causeMessage && !causeMessage.includes(causeCode)) {
    return `${causeCode}: ${causeMessage}`;
  }
  if (causeMessage) {
    return causeMessage;
  }
  if (causeCode) {
    return causeCode;
  }
  return message || "unknown error";
}

/** Preset model id + baseUrl + optional helpUrl for "Get API Key" link; display name comes from i18n. */
const PRESET_MODELS_BASE: Array<{
  id: string;
  baseUrl: string;
  helpUrl?: string;
}> = [
  {
    id: "qwen-turbo",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    helpUrl: "https://bailian.console.aliyun.com/?apiKey=1#/api-key",
  },
  {
    id: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    helpUrl: "https://bailian.console.aliyun.com/?apiKey=1#/api-key",
  },
  {
    id: "kimi-k2.5",
    baseUrl: "https://api.moonshot.cn/v1",
    helpUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    helpUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "glm-4",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    helpUrl: "https://bigmodel.cn/usercenter/apikeys",
  },
];

function getConfig(config: unknown): ConfigShape {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const c = config as Record<string, unknown>;
    return {
      providerKey: typeof c.providerKey === "string" ? c.providerKey : DEFAULT_CONFIG.providerKey,
      baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : DEFAULT_CONFIG.baseUrl,
      apiKey: typeof c.apiKey === "string" ? c.apiKey : DEFAULT_CONFIG.apiKey,
      modelName: typeof c.modelName === "string" ? c.modelName : DEFAULT_CONFIG.modelName,
    };
  }
  return { ...DEFAULT_CONFIG };
}

/** In-memory OAuth poll sessions (pollId -> session) */
type OAuthPollSession = {
  deviceCode: string;
  verifier: string;
  expiresAt: number;
  status: "pending" | "success" | "error";
  token?: QwenOAuthToken;
  error?: string;
};

const oauthPollSessions = new Map<string, OAuthPollSession>();
const STALE_SESSION_MS = 15 * 60 * 1000;

function purgeStaleOAuthSessions(): void {
  const now = Date.now();
  for (const [id, session] of oauthPollSessions) {
    if (now > session.expiresAt + STALE_SESSION_MS) {
      oauthPollSessions.delete(id);
    }
  }
}

async function applyQwenOAuthResult(
  runtime: NonNullable<OpenClawPluginApi["runtime"]>,
  token: QwenOAuthToken,
): Promise<void> {
  const profileId = `${QWEN_PROVIDER_ID}:default`;
  if (runtime.auth?.upsertProfile) {
    runtime.auth.upsertProfile({
      profileId,
      credential: {
        type: "oauth",
        provider: QWEN_PROVIDER_ID,
        access: token.access,
        refresh: token.refresh,
        expires: token.expires,
      },
    });
  }
  let cfg = runtime.config.loadConfig();
  const existingProfiles = (cfg.auth as Record<string, unknown>)?.profiles as
    | Record<string, unknown>
    | undefined;
  const existingProviders =
    cfg.models && typeof cfg.models === "object" && "providers" in cfg.models
      ? (cfg.models.providers as Record<string, unknown>)
      : {};
  const baseUrl = normalizeBaseUrl(token.resourceUrl);
  cfg = {
    ...cfg,
    auth: {
      ...(cfg.auth as object),
      profiles: {
        ...existingProfiles,
        [profileId]: { provider: QWEN_PROVIDER_ID, mode: "oauth" as const },
      },
      order: {
        ...((cfg.auth as Record<string, unknown>)?.order as Record<string, unknown> | undefined),
        [QWEN_PROVIDER_ID]: [profileId],
      },
    },
    models: {
      ...(cfg.models as object),
      providers: {
        ...existingProviders,
        [QWEN_PROVIDER_ID]: {
          baseUrl,
          apiKey: QWEN_OAUTH_PLACEHOLDER,
          api: "openai-completions",
          models: [
            {
              id: "coder-model",
              name: "Qwen Coder",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8192,
            },
            {
              id: "vision-model",
              name: "Qwen Vision",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    agents: {
      ...(cfg.agents as object),
      defaults: {
        ...((cfg.agents as Record<string, unknown>)?.defaults as
          | Record<string, unknown>
          | undefined),
        models: {
          ...((
            (cfg.agents as Record<string, unknown>)?.defaults as Record<string, unknown> | undefined
          )?.models as Record<string, unknown> | undefined),
          "qwen-portal/coder-model": { alias: "qwen" },
          "qwen-portal/vision-model": {},
        },
        model: {
          ...((
            (cfg.agents as Record<string, unknown>)?.defaults as Record<string, unknown> | undefined
          )?.model as Record<string, unknown> | undefined),
          primary: "qwen-portal/coder-model",
        },
      },
    },
  } as typeof cfg;
  runtime.config.writeConfigFile(cfg);
}

const plugin = {
  id: "model-config-generic",
  name: "Model Config (Generic)",
  description:
    "Generic model config strategy, validation and top prompt for cloud PC / external use.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const runtime = api.runtime;

    const TEST_CONNECTION_MAX_RETRIES = 2;
    const TEST_CONNECTION_RETRY_DELAY_MS = 800;

    async function testConnectionWithRetry(
      testFn: () => Promise<{ response: Response; release: () => Promise<void> }>,
    ): Promise<{ response: Response; release: () => Promise<void> }> {
      let lastError: unknown;
      for (let attempt = 0; attempt <= TEST_CONNECTION_MAX_RETRIES; attempt++) {
        try {
          return await testFn();
        } catch (err) {
          lastError = err;
          const isDnsError =
            err instanceof Error &&
            (err.message.includes("ENOTFOUND") ||
              err.message.includes("getaddrinfo") ||
              err.message.includes("EAI_AGAIN"));
          if (!isDnsError || attempt === TEST_CONNECTION_MAX_RETRIES) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, TEST_CONNECTION_RETRY_DELAY_MS));
        }
      }
      throw lastError;
    }
    // ======== [CO-CLAW-END] feature: oauth-test-connection-retry ========

    api.registerGatewayMethod("model-config.getStrategy", async ({ params, respond }) => {
      const s = getStrings(typeof params?.locale === "string" ? params.locale : undefined);
      const presetModels = PRESET_MODELS_BASE.map((p) => ({
        ...p,
        name: (s.presetModels as Record<string, string>)[p.id] ?? p.id,
      }));
      // 从插件配置中获取 supportOAuth、disableSelectModel、providerKey 配置项
      const pluginConfig = api.pluginConfig as { supportOAuth?: boolean; disableSelectModel?: boolean; providerKey?: string } | undefined;
      const disableSelectModel = pluginConfig?.disableSelectModel === true;
      // supportOAuth 显式配置优先，否则保持向后兼容（!disableSelectModel）
      const showQwenOAuth = pluginConfig?.supportOAuth ?? !disableSelectModel;
      const defaultConfig = {
        ...DEFAULT_CONFIG,
        ...(typeof pluginConfig?.providerKey === "string" && pluginConfig.providerKey.trim()
          ? { providerKey: pluginConfig.providerKey.trim() }
          : {}),
      };
      respond(true, {
        ok: true,
        defaultConfig,
        presetModels,
        showQwenOAuth,
        baseUrlEditable: true,
        oauthCardLabel: s.oauthCardLabel,
        manualConfigCardLabel: showQwenOAuth
          ? s.manualConfigCardLabel
          : s.manualConfigCardLabelAlias,
        disableSelectModel,
      });
    });

    api.registerGatewayMethod("model-config.validate", async ({ params, respond }) => {
      const s = getStrings(typeof params?.locale === "string" ? params.locale : undefined);
      const config = getConfig(params?.config);
      const modelName = (config.modelName ?? "").trim();
      const baseUrl = (config.baseUrl ?? "").trim();
      const apiKey = (config.apiKey ?? "").trim();
      if (!modelName) {
        respond(true, { ok: false, error: s.validate.modelNameRequired });
        return;
      }
      if (!baseUrl) {
        respond(true, { ok: false, error: s.validate.baseUrlRequired });
        return;
      }
      // 从插件配置中获取 enc 和 providerKey 配置项：启动加密或者为联通集团模型，则加密 apiKey
      const pluginConfig = api.pluginConfig;
      const shouldEncrypt = pluginConfig?.enc || pluginConfig?.providerKey === "cloudpc-unicom-manual";
      // 查看当前使用的 AES 密钥（调试用）
      const currentAesKey = getGlobalAesGcmKey();
      const encryptedApiKey = shouldEncrypt ? aesGcmEncrypt(apiKey) : undefined;
      console.log("[model-config-generic] AES Key Debug:", {
        aesKey: currentAesKey,
        apiKeyBefore: apiKey || "empty",
        apiKeyAfter: encryptedApiKey || "not encrypted",
        shouldEncrypt,
        pluginConfigEnc: pluginConfig?.enc,
        providerKey: pluginConfig?.providerKey,
      });
      respond(true, { ok: true, apiKey: encryptedApiKey });
    });

    api.registerGatewayMethod("model-config.getTopPrompt", async ({ params, respond }) => {
      const s = getStrings(typeof params?.locale === "string" ? params.locale : undefined);
      const cfg = runtime?.config?.loadConfig?.();
      const primary = (
        cfg?.agents as { defaults?: { model?: { primary?: string } } } | undefined
      )?.defaults?.model?.primary?.trim();
      if (!primary) {
        respond(true, {
          ok: true,
          status: "unconfigured",
          text: s.topPrompt.unconfigured,
        });
        return;
      }
      const isOAuthModel = primary.startsWith(`${QWEN_PROVIDER_ID}/`);
      // Only way 1 (pull-key → `cloudpc-unicom/...`) shows "联通"; way 2 uses `cloudpc-unicom-manual/...` → manual label.
      const isUnicomProvisionModel = primary.startsWith(`${UNICOM_PROVIDER_ID}/`);
      const authLabel = isOAuthModel
        ? s.topPrompt.authOAuth
        : isUnicomProvisionModel
          ? s.topPrompt.authUnicom
          : s.topPrompt.authManual;
      // 顶部提示只展示模型名，不展示 provider 前缀（如 zte/qwen-turbo → qwen-turbo）
      const modelDisplay = primary.includes("/")
        ? primary.slice(primary.indexOf("/") + 1)
        : primary;
      respond(true, {
        ok: true,
        status: "configured",
        text: s.topPrompt.configured
          .replace("{auth}", authLabel)
          .replace("{primary}", modelDisplay),
      });
    });

    api.registerGatewayMethod("model-config.getActiveAuthMode", async ({ respond }) => {
      const cfg = runtime?.config?.loadConfig?.();
      const primary = (
        cfg?.agents as { defaults?: { model?: { primary?: string } } } | undefined
      )?.defaults?.model?.primary?.trim();

      const modelsRoot = cfg?.models as Record<string, unknown> | undefined;
      const providers = modelsRoot?.providers as Record<string, unknown> | undefined;

      // Resolve qwen-portal provider with case-insensitive key (JSON keys may differ in casing)
      const qwenPortalKey =
        providers &&
        Object.keys(providers).find((k) => k.toLowerCase() === QWEN_PROVIDER_ID.toLowerCase());
      const qwenPortalRaw = qwenPortalKey ? (providers[qwenPortalKey] ?? null) : null;
      const qwenPortal =
        qwenPortalRaw && typeof qwenPortalRaw === "object"
          ? (qwenPortalRaw as Record<string, unknown>)
          : null;
      const rawApiKey =
        qwenPortal && typeof qwenPortal.apiKey === "string" ? qwenPortal.apiKey : null;
      const apiKey = rawApiKey != null ? rawApiKey.trim() : null;

      // Unicom provision: primary is cloudpc-unicom/*.
      const isUnicomProvisionPrimary =
        typeof primary === "string" && primary.trim().startsWith(`${UNICOM_PROVIDER_ID}/`);

      const mode: ActiveAuthMode =
        isUnicomProvisionPrimary
          ? "unicom-provision"
          : apiKey === QWEN_OAUTH_PLACEHOLDER
            ? "qwen-oauth"
            : typeof primary === "string" && primary.trim()
              ? "api-key"
              : "none";

      respond(true, { ok: true, mode, activeModel: primary ?? null });
    });

    api.registerGatewayMethod("models.auth.login", async ({ params, respond }) => {
      const provider = (params as { provider?: string })?.provider;
      if (provider !== QWEN_PROVIDER_ID) {
        respond(true, { error: `Unsupported provider for OAuth: ${provider ?? "missing"}` });
        return;
      }
      purgeStaleOAuthSessions();
      try {
        const { verifier, challenge } = generatePkce();
        const device = await requestDeviceCode({ challenge });
        const pollId = randomUUID();
        const session: OAuthPollSession = {
          deviceCode: device.device_code,
          verifier,
          expiresAt: Date.now() + device.expires_in * 1000,
          status: "pending",
        };
        oauthPollSessions.set(pollId, session);
        const verificationUri = device.verification_uri_complete || device.verification_uri;
        respond(true, {
          verificationUri,
          userCode: device.user_code,
          expiresIn: device.expires_in,
          pollId,
        });
      } catch (err) {
        const locale =
          params &&
          typeof params === "object" &&
          "locale" in params &&
          typeof (params as { locale?: string }).locale === "string"
            ? (params as { locale: string }).locale
            : undefined;
        const s = getStrings(locale);
        
        let errorMessage = String(err);
        if (err instanceof Error) {
          const cause = (err as Error & { cause?: { code?: string; message?: string } })?.cause;
          if (err.message === "fetch failed" && cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
            errorMessage = (s as any).oauthLoginErrors.connectTimeout;
          } else if (err.message === "fetch failed" && cause?.code) {
            errorMessage = (s as any).oauthLoginErrors.networkErrorWithCode.replace("{code}", cause.code);
          } else if (err.message === "fetch failed") {
            errorMessage = (s as any).oauthLoginErrors.networkError;
          }
        }
        respond(true, { error: errorMessage });
      }
    });

    api.registerGatewayMethod("models.auth.poll", async ({ params, respond }) => {
      const pollId = (params as { pollId?: string })?.pollId;
      if (!pollId) {
        respond(true, { status: "error", error: "pollId is required" });
        return;
      }
      const session = oauthPollSessions.get(pollId);
      if (!session) {
        respond(true, { status: "error", error: "Poll session not found or expired" });
        return;
      }
      if (session.status === "success" && session.token) {
        oauthPollSessions.delete(pollId);
        respond(true, {
          status: "success",
          provider: QWEN_PROVIDER_ID,
          defaultModel: "qwen-portal/coder-model",
        });
        return;
      }
      if (session.status === "error") {
        oauthPollSessions.delete(pollId);
        respond(true, { status: "error", error: session.error ?? "OAuth failed" });
        return;
      }
      if (Date.now() > session.expiresAt) {
        session.status = "error";
        session.error = "OAuth timed out waiting for authorization.";
        oauthPollSessions.delete(pollId);
        respond(true, { status: "error", error: session.error });
        return;
      }
      try {
        const result = await pollDeviceToken({
          deviceCode: session.deviceCode,
          verifier: session.verifier,
        });
        if (result.status === "success") {
          session.status = "success";
          session.token = result.token;
          if (runtime?.config && result.token) {
            await applyQwenOAuthResult(runtime, result.token);
          }
          oauthPollSessions.delete(pollId);
          respond(true, {
            status: "success",
            provider: QWEN_PROVIDER_ID,
            defaultModel: "qwen-portal/coder-model",
          });
          return;
        }
        if (result.status === "error") {
          session.status = "error";
          session.error = result.message;
          oauthPollSessions.delete(pollId);
          respond(true, { status: "error", error: result.message });
          return;
        }
        respond(true, { status: "pending" });
      } catch (err) {
        session.status = "error";
        session.error = String(err);
        oauthPollSessions.delete(pollId);
        respond(true, { status: "error", error: String(err) });
      }
    });

    /**
     * Test OAuth model connectivity using stored credentials (qwen-portal only).
     * Reads config + auth store, then POSTs to chat/completions with the OAuth access token.
     */
    api.registerGatewayMethod("models.testOAuthModelConnection", async ({ params, respond }) => {
      const locale =
        params &&
        typeof params === "object" &&
        "locale" in params &&
        typeof (params as { locale?: string }).locale === "string"
          ? (params as { locale: string }).locale
          : undefined;
      const s = getStrings(locale);

      if (!runtime?.config || !runtime?.state) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: s.testOAuthConnection.runtimeNotAvailable,
        });
        return;
      }
      try {
        const cfg = runtime.config.loadConfig();
        const providers =
          cfg.models && typeof cfg.models === "object" && "providers" in cfg.models
            ? (cfg.models.providers as Record<string, unknown>)
            : {};
        const provider = providers[QWEN_PROVIDER_ID] as Record<string, unknown> | undefined;
        if (!provider) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: s.testOAuthConnection.oauthModelNotConfigured,
          });
          return;
        }
        const baseUrl = normalizeBaseUrl(
          typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
        );
        const models = Array.isArray(provider.models) ? provider.models : [];
        const firstModel = models[0];
        const modelName =
          firstModel &&
          typeof firstModel === "object" &&
          firstModel !== null &&
          "id" in firstModel &&
          typeof (firstModel as Record<string, unknown>).id === "string"
            ? ((firstModel as Record<string, unknown>).id as string)
            : "coder-model";

        const stateDir = runtime.state.resolveStateDir();
        const authPath = path.join(
          stateDir,
          "agents",
          DEFAULT_AGENT_ID,
          "agent",
          AUTH_PROFILE_FILENAME,
        );
        let store: { version?: number; profiles?: Record<string, unknown> };
        try {
          const raw = await fs.readFile(authPath, "utf8");
          store = JSON.parse(raw) as typeof store;
        } catch {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: s.testOAuthConnection.noOAuthCredentials,
          });
          return;
        }
        const profileId = `${QWEN_PROVIDER_ID}:default`;
        const cred = store.profiles?.[profileId] as
          | { type?: string; access?: string; expires?: number }
          | undefined;
        if (!cred || cred.type !== "oauth" || !cred.access?.trim()) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: s.testOAuthConnection.noOAuthCredentials,
          });
          return;
        }
        if (typeof cred.expires === "number" && Date.now() >= cred.expires) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: s.testOAuthConnection.oauthTokenExpired,
          });
          return;
        }

        const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl.replace(/\/+$/, "") : baseUrl;
        const endpoint = `${normalizedBaseUrl}/chat/completions`;
        const timeoutMs = 10_000;

        try {
          const { response, release } = await testConnectionWithRetry(async () =>
            fetchWithSsrFGuard({
              url: endpoint,
              timeoutMs,
              mode: "trusted_env_proxy",
              auditContext: "model-config-generic.oauth-test-connection",
              init: {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${cred.access.trim()}`,
                },
                body: JSON.stringify({
                  model: modelName,
                  messages: [
                    { role: "system", content: "You are a helpful assistant." },
                    { role: "user", content: "Hello!" },
                  ],
                  stream: false,
                }),
              },
            }),
          );

          try {
            if (!response.ok) {
              let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
              try {
                const errorText = await response.text();
                if (errorText) {
                  try {
                    const errorJson = JSON.parse(errorText) as { error?: { message?: string } };
                    errorMessage = errorJson.error?.message ?? errorText.slice(0, 200);
                  } catch {
                    errorMessage = errorText.slice(0, 200);
                  }
                }
              } catch {
                // ignore
              }
              respond(false, undefined, {
                code: "UNAVAILABLE",
                message: `Model connection test failed: ${errorMessage}`,
              });
              return;
            }
            const data = (await response.json()) as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            if (!data.choices || data.choices.length === 0) {
              respond(false, undefined, {
                code: "UNAVAILABLE",
                message: "Model connection test succeeded but received invalid response format",
              });
              return;
            }
            respond(true, { ok: true, provider: QWEN_PROVIDER_ID, model: modelName }, undefined);
          } finally {
            await release();
          }
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            respond(false, undefined, {
              code: "UNAVAILABLE",
              message: s.testOAuthConnection.connectionTimeout,
            });
          } else {
            const detail = formatModelTestErrorDetail(err);
            respond(false, undefined, {
              code: "UNAVAILABLE",
              message: `Model connection test failed: ${detail}`,
            });
          }
        }
      } catch (err) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: String(err),
        });
      }
    });
  },
};

export default plugin;
