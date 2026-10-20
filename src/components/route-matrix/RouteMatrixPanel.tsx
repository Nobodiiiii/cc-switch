import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Provider } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
  "h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm";

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
  const [open, setOpen] = useState(false);
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
    )
      return;
    setPending(true);
    setError("");
    setMessage("");
    try {
      if (connect !== false) await routeMatrixApi.save(draft);
      if (connect !== undefined) await routeMatrixApi.connect(connect);
      await Promise.all([
        client.invalidateQueries({ queryKey }),
        client.invalidateQueries({ queryKey: ["proxyStatus"] }),
        client.invalidateQueries({ queryKey: ["appMode"] }),
      ]);
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
    <>
      <div className="mx-6 mb-2 flex items-center justify-between rounded-lg border px-3 py-2">
        <div className="text-sm">
          <strong>路由矩阵</strong>
          <span className="ml-2 text-muted-foreground">
            路由 + 聚合{query.data?.enabled ? " · 已启用" : ""}
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setError("");
            setMessage("");
            if (query.data) setDraft(structuredClone(query.data));
            setOpen(true);
          }}
        >
          配置连接
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>路由矩阵 · Route Matrix</DialogTitle>
            <DialogDescription>
              主路由使用原始模型名，手动切换供应商；副路由使用独立前缀和故障转移。保存后，后续请求立即采用新配置。
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            官方供应商需先绑定 CC Switch 中的具体 ChatGPT 账号。首次接入需要
            Codex
            加载固定代理地址；模型选择器按客户端刷新节奏更新，可直接输入模型
            ID。
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
                        secondary: draft.secondary.filter(
                          (_, i) => i !== index,
                        ),
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
                    <Button
                      variant="outline"
                      onClick={() => void action(false)}
                    >
                      恢复原连接并停用
                    </Button>
                  )}
                  <Button onClick={() => void action(true)}>
                    {query.data?.enabled
                      ? "重新接入此连接"
                      : "保存并接入 Codex"}
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
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
          providers={providers}
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
          ? "不带前缀；每个模型必须配置当前供应商的映射。切换前先为相应模型补齐目标。"
          : `发布为 rm-${route.prefix}/模型名。先尝试当前供应商，再按下方映射顺序转移；不会进入其他路由。前缀移除后仍保留归属。`}
      </p>
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
                {Object.values(providers).map((p) => (
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
                onChange={(e) => update({ ...model, id: e.target.value })}
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
              <div key={targetIndex} className="flex gap-2">
                <ProviderSelect
                  label="映射供应商"
                  providers={providers}
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
                targets: [{ providerId: route.activeProviderId, model: "" }],
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
