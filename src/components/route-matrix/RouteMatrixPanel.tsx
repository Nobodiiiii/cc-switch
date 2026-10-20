import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Provider } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { providersApi } from "@/lib/api/providers";
import { resolveCodexOfficialIdentity } from "@/utils/providerCapabilities";
import {
  routeMatrixApi,
  matrixPolicy,
  type MatrixConfig,
  type MatrixRoute,
  type MatrixPolicy,
} from "@/lib/api/routeMatrix";
import { extractErrorMessage } from "@/utils/errorUtils";

const queryKey = ["route-matrix"];
const selectClass =
  "h-9 w-52 max-w-full shrink-0 rounded-md border border-input bg-background px-2 text-sm";

export function RouteMatrixPanel({
  providers,
}: {
  providers: Record<string, Provider>;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: routeMatrixApi.get,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<MatrixConfig>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (query.data) setDraft(structuredClone(query.data));
  }, [query.data]);

  async function action(connect?: boolean) {
    if (!draft) return;
    if (
      connect !== false &&
      formRef.current &&
      !formRef.current.reportValidity()
    ) {
      setError("请修正配置中无效的数字或模型能力 JSON 后再保存。");
      return;
    }
    setPending(true);
    setError("");
    setMessage("");
    try {
      if (connect !== false) await routeMatrixApi.save(draft);
      if (connect !== undefined) await routeMatrixApi.connect(connect);
      await Promise.all([
        client.invalidateQueries({ queryKey }),
        client.invalidateQueries({ queryKey: ["proxyStatus"] }),
        client.invalidateQueries({ queryKey: ["providers", "codex"] }),
        client.invalidateQueries({ queryKey: ["proxyTakeoverStatus"] }),
      ]);
      providersApi.updateTrayMenu().catch(() => undefined);
      setMessage(
        connect === undefined
          ? "已保存，后续请求使用新配置；进行中的请求保持原路由。"
          : connect
            ? "已接入。首次使用请让 Codex 加载新连接，后续切换无需重启。"
            : "已恢复接入前的 Codex 配置。",
      );
    } catch (e) {
      setError(extractErrorMessage(e) || String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4" aria-label="路由矩阵配置">
      <div className="space-y-1">
        <h2 className="font-semibold">
          路由矩阵 · 路由 + 聚合 {query.data?.enabled ? "（当前生效）" : ""}
        </h2>
        <p className="text-sm text-muted-foreground">
          主路由使用原始模型名，手动切换供应商；副路由使用独立前缀和故障转移。保存后，后续请求立即采用新配置。
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        官方供应商需先绑定 CC Switch 中的具体 ChatGPT 账号。首次接入需要 Codex
        加载固定代理地址；模型选择器按客户端刷新节奏更新，可直接输入模型 ID。
      </p>
      {(query.error || error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || extractErrorMessage(query.error)}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {!draft ? (
        <p>正在加载配置…</p>
      ) : (
        <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
          <fieldset disabled={pending} className="min-w-0 space-y-4">
            <RouteEditor
              primary
              route={draft.primary}
              providers={providers}
              onChange={(primary) => setDraft({ ...draft, primary })}
            />
            {draft.secondary.map((route, index) => (
              <RouteEditor
                key={route.id}
                route={route}
                providers={providers}
                onRemove={() =>
                  setDraft({
                    ...draft,
                    secondary: draft.secondary.filter((_, i) => i !== index),
                  })
                }
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    secondary: draft.secondary.map((r, i) =>
                      i === index ? next : r,
                    ),
                  })
                }
              />
            ))}
            <Button
              variant="outline"
              onClick={() => {
                const id = `route-${crypto.randomUUID().slice(0, 8)}`;
                setDraft({
                  ...draft,
                  secondary: [
                    ...draft.secondary,
                    {
                      id,
                      prefix: id,
                      name: "副路由",
                      activeProviderId: Object.keys(providers)[0] ?? "",
                      failover: false,
                      policy: matrixPolicy(),
                      models: [],
                    },
                  ],
                });
              }}
            >
              添加副路由
            </Button>
            <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
              <Button variant="outline" onClick={() => void action()}>
                保存配置
              </Button>
              {query.data?.enabled && (
                <Button variant="outline" onClick={() => void action(false)}>
                  恢复原连接并停用
                </Button>
              )}
              {!query.data?.enabled && (
                <Button onClick={() => void action(true)}>
                  保存并切换到路由矩阵
                </Button>
              )}
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}

function ProviderSelect({
  providers,
  value,
  onChange,
  label,
}: {
  providers: Record<string, Provider>;
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      className={selectClass}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">选择供应商</option>
      {value && !providers[value] && (
        <option value={value}>已删除：{value}</option>
      )}
      {Object.values(providers).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

function RouteEditor({
  route,
  primary = false,
  providers,
  onChange,
  onRemove,
}: {
  route: MatrixRoute;
  primary?: boolean;
  providers: Record<string, Provider>;
  onChange: (route: MatrixRoute) => void;
  onRemove?: () => void;
}) {
  // Older configurations expressed membership only through model mappings.
  const memberIds = route.providerIds ?? [
    ...new Set([
      ...route.models.flatMap((model) =>
        model.targets.map((t) => t.providerId),
      ),
      ...(route.activeProviderId ? [route.activeProviderId] : []),
    ]),
  ];
  const members = Object.fromEntries(
    Object.entries(providers).filter(([id]) => memberIds.includes(id)),
  );
  const mappingProviders = primary ? members : providers;
  const toggleMember = (id: string, checked: boolean) => {
    const providerIds = checked
      ? [...memberIds, id]
      : memberIds.filter((p) => p !== id);
    onChange({
      ...route,
      providerIds,
      activeProviderId: providerIds.includes(route.activeProviderId)
        ? route.activeProviderId
        : (providerIds[0] ?? ""),
      models: route.models.map((model) => ({
        ...model,
        activeProviderId:
          model.activeProviderId && providerIds.includes(model.activeProviderId)
            ? model.activeProviderId
            : undefined,
        targets: checked
          ? [...model.targets, { providerId: id, model: model.id }]
          : model.targets.filter((target) => target.providerId !== id),
      })),
    });
  };
  const policyLabels: [keyof MatrixPolicy, string][] = [
    ["maxRetries", "最多额外尝试"],
    ["firstByteTimeout", "首包超时（秒）"],
    ["idleTimeout", "流静默超时（秒）"],
    ["requestTimeout", "普通请求超时（秒）"],
    ["failureThreshold", "熔断失败阈值"],
    ["cooldownSeconds", "熔断冷却（秒）"],
  ];
  return (
    <section
      aria-label={primary ? "主路由" : `副路由 ${route.prefix}`}
      className="space-y-3 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <strong>{primary ? "主路由" : "副路由"}</strong>
        <Input
          className="w-36"
          aria-label="路由名称"
          value={route.name}
          onChange={(e) => onChange({ ...route, name: e.target.value })}
        />
        {!primary && (
          <label className="flex items-center gap-2 text-sm">
            前缀
            <Input
              className="w-36"
              aria-label="模型前缀"
              value={route.prefix}
              onChange={(e) => onChange({ ...route, prefix: e.target.value })}
            />
          </label>
        )}
        <ProviderSelect
          providers={mappingProviders}
          label="当前供应商"
          value={route.activeProviderId}
          onChange={(activeProviderId) =>
            onChange({ ...route, activeProviderId })
          }
        />
        {!primary && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={route.failover}
              onChange={(e) =>
                onChange({ ...route, failover: e.target.checked })
              }
            />
            自动故障转移
          </label>
        )}
        {onRemove && (
          <Button size="sm" variant="ghost" onClick={onRemove}>
            删除路由
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {primary
          ? "可同时加入多个官方供应商，手动选择当前账号；不自动轮换。不带前缀的模型可跟随当前供应商，也可单独指定。"
          : `发布为 rm-${route.prefix}/模型名。先尝试当前供应商，再按下方映射顺序转移；不会进入其他路由。前缀移除后仍保留归属。`}
      </p>
      {primary && (
        <fieldset className="space-y-2 rounded-md bg-muted/40 p-3">
          <legend className="px-1 text-sm font-medium">
            主路由供应商（可多选）
          </legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[...new Set([...Object.keys(providers), ...memberIds])].map(
              (id) => {
                const provider = providers[id];
                const identity =
                  provider && resolveCodexOfficialIdentity("codex", provider);
                const unbound = identity === "native_login";
                return (
                  <label key={id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={`加入主路由：${provider?.name ?? id}`}
                      checked={memberIds.includes(id)}
                      disabled={unbound && !memberIds.includes(id)}
                      onChange={(e) => toggleMember(id, e.target.checked)}
                    />
                    <span>
                      {provider?.name ?? `已删除：${id}`}
                      {identity === "managed_account"
                        ? " · 官方账号"
                        : unbound
                          ? " · 请先绑定账号"
                          : ""}
                    </span>
                  </label>
                );
              },
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            加入供应商时自动为现有模型添加同名映射，实际模型名可在下方调整。官方账号请先在供应商卡片中绑定。
          </p>
        </fieldset>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {policyLabels
          .filter(
            ([key]) =>
              !primary ||
              ["firstByteTimeout", "idleTimeout", "requestTimeout"].includes(
                key,
              ),
          )
          .map(([key, label]) => (
            <label key={key} className="text-xs text-muted-foreground">
              {label}
              <Input
                aria-label={label}
                type="number"
                min={key === "failureThreshold" ? 1 : 0}
                max={key === "maxRetries" ? 20 : 86400}
                value={route.policy[key]}
                onChange={(e) =>
                  onChange({
                    ...route,
                    policy: { ...route.policy, [key]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
      </div>
      {route.models.map((model, index) => {
        const update = (next: typeof model) =>
          onChange({
            ...route,
            models: route.models.map((m, i) => (i === index ? next : m)),
          });
        return (
          <div key={index} className="space-y-2 rounded-md bg-muted/40 p-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              此模型的供应商
              <select
                className={selectClass}
                aria-label="此模型的供应商"
                value={model.activeProviderId ?? ""}
                onChange={(e) =>
                  update({
                    ...model,
                    activeProviderId: e.target.value || undefined,
                  })
                }
              >
                <option value="">跟随路由当前供应商</option>
                {Object.values(mappingProviders).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <Input
                aria-label="发布模型 ID"
                placeholder="发布模型 ID，如 gpt-6.1-sol"
                value={model.id}
                onChange={(e) =>
                  update({
                    ...model,
                    id: e.target.value,
                    targets: primary
                      ? model.targets.map((target) => ({
                          ...target,
                          model:
                            !target.model || target.model === model.id
                              ? e.target.value
                              : target.model,
                        }))
                      : model.targets,
                  })
                }
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange({
                    ...route,
                    models: route.models.filter((_, i) => i !== index),
                  })
                }
              >
                删除模型
              </Button>
            </div>
            {model.targets.map((target, targetIndex) => (
              <div
                key={targetIndex}
                className="flex flex-wrap gap-2 sm:flex-nowrap"
              >
                <ProviderSelect
                  label="映射供应商"
                  providers={mappingProviders}
                  value={target.providerId}
                  onChange={(providerId) =>
                    update({
                      ...model,
                      targets: model.targets.map((t, i) =>
                        i === targetIndex ? { ...t, providerId } : t,
                      ),
                    })
                  }
                />
                <Input
                  className="min-w-0 flex-1"
                  aria-label="上游模型 ID"
                  placeholder="该供应商实际使用的模型 ID"
                  value={target.model}
                  onChange={(e) =>
                    update({
                      ...model,
                      targets: model.targets.map((t, i) =>
                        i === targetIndex ? { ...t, model: e.target.value } : t,
                      ),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="删除上游映射"
                  onClick={() =>
                    update({
                      ...model,
                      targets: model.targets.filter(
                        (_, i) => i !== targetIndex,
                      ),
                    })
                  }
                >
                  移除
                </Button>
              </div>
            ))}
            {!primary && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  update({
                    ...model,
                    targets: [
                      ...model.targets,
                      { providerId: "", model: model.id },
                    ],
                  })
                }
              >
                添加上游映射
              </Button>
            )}
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                模型能力参数（Codex 原生 JSON）
              </summary>
              <textarea
                aria-label="模型能力参数"
                className="mt-2 min-h-20 w-full rounded border bg-background p-2 font-mono text-xs"
                defaultValue={JSON.stringify(model.catalog, null, 2)}
                onBlur={(e) => {
                  try {
                    const catalog: unknown = JSON.parse(e.target.value);
                    if (
                      !catalog ||
                      typeof catalog !== "object" ||
                      Array.isArray(catalog)
                    )
                      throw new Error();
                    update({
                      ...model,
                      catalog: catalog as Record<string, unknown>,
                    });
                    e.target.setCustomValidity("");
                  } catch {
                    e.target.setCustomValidity("请输入 JSON 对象");
                    e.target.reportValidity();
                  }
                }}
              />
            </details>
          </div>
        );
      })}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          onChange({
            ...route,
            models: [
              ...route.models,
              {
                id: "",
                targets: primary
                  ? memberIds.map((providerId) => ({ providerId, model: "" }))
                  : [{ providerId: route.activeProviderId, model: "" }],
                catalog: {},
              },
            ],
          })
        }
      >
        添加模型
      </Button>
    </section>
  );
}
