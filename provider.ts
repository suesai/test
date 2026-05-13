/**
 * 联通局点 实现：调用 getUnionAiKeyByResourceId，将 apiKey、llmName、llmUrl 存入凭证（内存加密）并使用 config.patch 写入 openclaw.json
 */
import type { SsoJsonConfig } from "../../config.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { SsoConfigError, SsoRuntimeError } from "../../errors.js";
import { addCredentialData } from "../../credential.js";
import { error, info, warn, debug } from "../../log.js";
import { getUnionAiKey } from "./get-union-ai-key.js";
import { aesGcmEncrypt, getGlobalAesGcmKey } from "openclaw/plugin-sdk/coclaw";

export async function runUnicomSso(params: {
  cfg: SsoJsonConfig;
  runtime: OpenClawPluginApi["runtime"];
}): Promise<void> {
  const { cfg, runtime } = params;

  const { apiKey, llmName, llmUrl } = await getUnionAiKey({
    baseUrl: cfg.baseUrl!,
    httpTimeoutMs: cfg.httpTimeoutMs!,
    httpRetryCount: cfg.httpRetryCount!,
    rsaPublicKey: cfg.rsaPublicKey!,
    rsaPrivateKey: cfg.rsaPrivateKey!,
  });

  // 联通局点失败时不退出，仅记录日志
  if (!apiKey || !llmName || !llmUrl) {
    warn("[unicom] API returned empty apiKey/llmName/llmUrl, continuing without SSO");
    return;
  }

  // 将凭证存入内存（加密）
  addCredentialData({
    apiKey,
    llmName,
    llmUrl,
  });

  // 写入 openclaw.json（仅联通局点需要）
  await writeUnicomConfig(runtime, { apiKey, llmName, llmUrl });
}

/**
 * 联通局点：重新执行认证逻辑，更新内存凭证和 openclaw.json
 */
export async function updateUnicomModelConfig(params: {
  cfg: SsoJsonConfig;
  runtime: OpenClawPluginApi["runtime"];
}): Promise<void> {
  const { cfg, runtime } = params;
  await runUnicomSso({ cfg, runtime });
}

/**
 * 辅助函数：确保对象存在
 */
function upsertObject(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = root[key];
  if (existing && typeof existing === "object" && existing !== null) {
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  root[key] = next;
  return next;
}

/**
 * 将联通 AI 配置写入 openclaw.json
 */
async function writeUnicomConfig(
  runtime: OpenClawPluginApi["runtime"],
  config: { apiKey: string; llmName: string; llmUrl: string },
): Promise<void> {
  if (!runtime?.config) {
    warn("[unicom] runtime.config not available, skipping openclaw.json write");
    return;
  }

  try {
    // 1. 加载当前配置
    const cfg = JSON.parse(JSON.stringify(runtime.config.loadConfig())) as Record<string, unknown>;

    // 2. 提取 provider baseUrl
    const providerBaseUrl = normalizeOpenAiBaseUrl(config.llmUrl);

    // 3. 加密 apiKey
    const encryptedApiKey = aesGcmEncrypt(config.apiKey);
    // 打印加密后的 apiKey（info 日志）
    info(`[unicom] Encrypted API Key: ${encryptedApiKey}`);
    // 打印 AES 密钥（debug 日志）
    debug(`[unicom] AES Key: ${getGlobalAesGcmKey()}`);

    // 4. 构建配置对象
    const modelsRoot = upsertObject(cfg, "models");
    const providers = upsertObject(modelsRoot, "providers");
    providers["default-model"] = {
      baseUrl: providerBaseUrl,
      apiKey: encryptedApiKey,
      models: [
        {
          id: config.llmName,
          name: config.llmName,
        },
      ],
    };

    const agentsRoot = upsertObject(cfg, "agents");
    const defaults = upsertObject(agentsRoot, "defaults");
    const model = upsertObject(defaults, "model");
    model.primary = `default-model/${config.llmName}`;

    // 4. 写入配置文件
    await runtime.config.writeConfigFile(cfg);

    // 5. 读取验证
    const readBack =
      typeof runtime.config.readConfigFileSnapshot === "function"
        ? await runtime.config.readConfigFileSnapshot()
        : null;

    if (readBack && !readBack.valid) {
      warn(`[unicom] config invalid after write: ${JSON.stringify(readBack.issues)}`);
      throw new SsoRuntimeError(
        `[unicom] config validation failed after write: ${readBack.issues[0]?.message ?? "unknown"}`,
      );
    }

    const persisted = (readBack?.valid ? readBack.config : runtime.config.loadConfig()) as Record<
      string,
      unknown
    >;

    // 6. 验证持久化结果
    const persistedProviders =
      persisted.models &&
      typeof persisted.models === "object" &&
      "providers" in persisted.models
        ? ((persisted.models as Record<string, unknown>).providers as Record<string, unknown>)
        : undefined;

    const persistedProvider = persistedProviders?.["default-model"];
    const persistedPrimary =
      persisted.agents &&
      typeof persisted.agents === "object" &&
      "defaults" in persisted.agents &&
      (persisted.agents as Record<string, unknown>).defaults &&
      typeof (persisted.agents as Record<string, unknown>).defaults === "object" &&
      "model" in ((persisted.agents as Record<string, unknown>).defaults as Record<string, unknown>) &&
      (((persisted.agents as Record<string, unknown>).defaults as Record<string, unknown>).model as Record<
        string,
        unknown
      >)?.primary;

    const expectedPrimary = `default-model/${config.llmName}`;
    const providerOk = Boolean(persistedProvider);
    const primaryOk = typeof persistedPrimary === "string" && persistedPrimary === expectedPrimary;

    if (!providerOk || !primaryOk) {
      warn(`[unicom] persistence check failed: llmName=${config.llmName}, expectedPrimary=${expectedPrimary}, providerOk=${providerOk}, primaryOk=${primaryOk}, persistedPrimary=${typeof persistedPrimary === "string" ? persistedPrimary : JSON.stringify(persistedPrimary)}`);
      throw new SsoRuntimeError(
        `[unicom] config persistence check failed: provider/default model missing after write`,
      );
    }

    info(`[unicom] config written successfully (provider=default-model, model=${config.llmName})`);
    info(`[unicom] persistence check ok: expectedPrimary=${expectedPrimary}, configPath=${readBack?.path ?? "unknown"}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    warn(`[unicom] failed to write openclaw.json: ${errMsg}`);
    throw new SsoRuntimeError(`[unicom] config write failed: ${errMsg}`, { cause: err });
  }
}

function normalizeOpenAiBaseUrl(value: string): string {
  const raw = value.trim();
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  return withProtocol.endsWith("/v1")
    ? withProtocol
    : `${withProtocol.replace(/\/+$/, "")}/v1`;
}
