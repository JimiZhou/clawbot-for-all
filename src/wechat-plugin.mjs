export const WECHAT_PLUGIN_SPEC = "@tencent-weixin/openclaw-weixin";
export const WECHAT_CHANNEL_ID = "openclaw-weixin";

export function withWechatPluginEnabled(plugins = {}) {
  const allow = Array.isArray(plugins?.allow) ? [...plugins.allow] : [];
  const sourceEntries =
    plugins?.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries)
      ? plugins.entries
      : {};
  const currentWechatEntry = sourceEntries[WECHAT_CHANNEL_ID];

  return {
    allow,
    entries: {
      ...sourceEntries,
      [WECHAT_CHANNEL_ID]:
        currentWechatEntry && typeof currentWechatEntry === "object" && !Array.isArray(currentWechatEntry)
          ? { ...currentWechatEntry, enabled: currentWechatEntry.enabled ?? true }
          : { enabled: true },
    },
  };
}
