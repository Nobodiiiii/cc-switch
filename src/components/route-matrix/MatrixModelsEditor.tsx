import type { Provider } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MatrixRoute } from "@/lib/api/routeMatrix";
import { routeMembers, setRouteMembers } from "./routing";
const selectClass =
  "h-9 w-52 max-w-full shrink-0 rounded-md border border-input bg-background px-2 text-sm";
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

export function MatrixModelsEditor({
  route,
  providers,
  onChange,
}: {
  route: MatrixRoute;
  providers: Record<string, Provider>;
  onChange: (route: MatrixRoute) => void;
}) {
  const memberIds = routeMembers(route);
  const mappingProviders = Object.fromEntries(
    Object.entries(providers).filter(([id]) => memberIds.includes(id)),
  );
  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-2">
        模型映射为选填。留空时使用官方模型目录，按原始模型名转发给此路由的供应商；副路由自动添加自己的前缀。填写后仅发布这里配置的模型和映射。
      </p>
      {memberIds
        .filter((id) => !providers[id])
        .map((id) => (
          <div
            key={id}
            className="flex items-center justify-between gap-2 rounded border border-border p-3 text-sm"
          >
            <span>供应商已删除：{id}</span>
            <Button
              variant="neutral"
              size="compact"
              onClick={() =>
                onChange(
                  setRouteMembers(
                    route,
                    memberIds.filter((member) => member !== id),
                  ),
                )
              }
            >
              移除失效供应商
            </Button>
          </div>
        ))}
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
                    targets: model.targets.map((target) => ({
                      ...target,
                      model:
                        !target.model || target.model === model.id
                          ? e.target.value
                          : target.model,
                    })),
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
            <Button
              size="sm"
              variant="outline"
              disabled={memberIds.every((id) =>
                model.targets.some((target) => target.providerId === id),
              )}
              onClick={() =>
                update({
                  ...model,
                  targets: [
                    ...model.targets,
                    {
                      providerId:
                        memberIds.find(
                          (id) =>
                            !model.targets.some(
                              (target) => target.providerId === id,
                            ),
                        ) ?? "",
                      model: model.id,
                    },
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
        disabled={memberIds.length === 0}
        onClick={() =>
          onChange({
            ...route,
            models: [
              ...route.models,
              {
                id: "",
                targets: memberIds.map((providerId) => ({
                  providerId,
                  model: "",
                })),
                catalog: {},
              },
            ],
          })
        }
      >
        添加模型
      </Button>
    </div>
  );
}
