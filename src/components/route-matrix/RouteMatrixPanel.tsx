import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, SlidersHorizontal } from "lucide-react";
import type { Provider } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ProviderList } from "@/components/providers/ProviderList";
import { RouteControls } from "@/components/providers/mode/RouteControls";
import { RoutingPolicyFields } from "@/components/proxy/RoutingPolicyFields";
import { providersApi } from "@/lib/api/providers";
import {
  routeMatrixApi,
  matrixPolicy,
  type MatrixConfig,
  type MatrixRoute,
} from "@/lib/api/routeMatrix";
import { extractErrorMessage } from "@/utils/errorUtils";
import { cn } from "@/lib/utils";
import { MatrixModelsEditor } from "./MatrixModelsEditor";
import { matrixRouteSections, routeMembers, setRouteMembers } from "./routing";

type ProviderActions = Pick<
  ComponentProps<typeof ProviderList>,
  | "onEdit"
  | "onDelete"
  | "onDuplicate"
  | "onConfigureUsage"
  | "onOpenWebsite"
  | "onOpenTerminal"
  | "onCreate"
  | "searchOpen"
  | "onSearchOpenChange"
>;
const queryKey = ["route-matrix"];
const policyLimits = {
  maxRetries: { min: 0, max: 20 },
  failureThreshold: { min: 1, max: 86400 },
  firstByteTimeout: { min: 0, max: 86400 },
  idleTimeout: { min: 0, max: 86400 },
  requestTimeout: { min: 0, max: 86400 },
  cooldownSeconds: { min: 0, max: 86400 },
};

export function RouteMatrixPanel({
  providers,
  ...providerActions
}: { providers: Record<string, Provider> } & ProviderActions) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: routeMatrixApi.get,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [config, setConfig] = useState<MatrixConfig>();
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<MatrixRoute>();
  const [editorTab, setEditorTab] = useState<"policy" | "models">("policy");
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (query.data) setConfig(structuredClone(query.data));
  }, [query.data]);
  const routes = config ? [config.primary, ...config.secondary] : [];
  const route = routes.find((item) => item.id === selected) ?? config?.primary;
  const primary = route?.id === config?.primary.id;
  const members = route ? routeMembers(route) : [];

  async function persist(
    next: MatrixConfig,
    connect?: boolean,
  ): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      if (connect !== false) await routeMatrixApi.save(next);
      if (connect !== undefined) await routeMatrixApi.connect(connect);
      setConfig({ ...next, enabled: connect ?? next.enabled });
      await Promise.all([
        client.invalidateQueries({ queryKey }),
        client.invalidateQueries({ queryKey: ["proxyStatus"] }),
        client.invalidateQueries({ queryKey: ["providers", "codex"] }),
        client.invalidateQueries({ queryKey: ["proxyTakeoverStatus"] }),
      ]);
      providersApi.updateTrayMenu().catch(() => undefined);
      setMessage(
        connect === undefined
          ? next.enabled
            ? "已保存，后续请求使用新配置；进行中的请求保持原路由。"
            : "已保存路由配置，启用路由矩阵后生效。"
          : connect
            ? "已接入。首次使用请让 Codex 加载新连接，后续切换无需重启。"
            : "已恢复接入前的 Codex 配置。",
      );
      return true;
    } catch (e) {
      setError(extractErrorMessage(e) || String(e));
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function replaceRoute(next: MatrixRoute) {
    if (!config) return Promise.resolve(false);
    return persist({
      ...config,
      primary: next.id === config.primary.id ? next : config.primary,
      secondary: config.secondary.map((item) =>
        item.id === next.id ? next : item,
      ),
    });
  }
  const openSettings = (tab: "policy" | "models") => {
    if (!route) return;
    setError("");
    setEditorTab(tab);
    setEditor(structuredClone(route));
  };
  const saveSettings = async () => {
    if (!editor || !formRef.current?.reportValidity()) {
      setError("请修正配置中无效的数字或模型能力 JSON 后再保存。");
      return;
    }
    if (await replaceRoute(editor)) setEditor(undefined);
  };
  if (!config || !route)
    return (
      <div>
        {query.error ? (
          <p role="alert">{extractErrorMessage(query.error)}</p>
        ) : (
          "正在加载配置…"
        )}
      </div>
    );
  const scopedProviders = Object.fromEntries(
    Object.values(providers).map((provider, index) => [
      provider.id,
      {
        ...provider,
        sortIndex: members.includes(provider.id)
          ? members.indexOf(provider.id)
          : members.length + index,
      },
    ]),
  );
  const original = (provider: Provider) => providers[provider.id] ?? provider;

  return (
    <div className="space-y-3" aria-label="路由矩阵配置">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <div
          role="tablist"
          aria-label="矩阵路由"
          className="flex min-w-0 flex-1 flex-wrap gap-1"
        >
          {routes.map((item, index) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.id === route.id}
              className={cn(
                "rounded-control px-3 py-2 text-body",
                item.id === route.id
                  ? "bg-selected font-semibold text-fg-1"
                  : "text-fg-2 hover:bg-subtle",
              )}
              onClick={() => {
                setSelected(item.id);
                setError("");
              }}
              disabled={pending}
            >
              {index === 0 ? "主路由" : item.name || "副路由"}
              {index > 0 && (
                <span className="ml-2 text-xs text-fg-3">
                  rm-{item.prefix}/
                </span>
              )}
            </button>
          ))}
        </div>
        <Button
          variant="quiet"
          size="compact"
          disabled={pending}
          onClick={async () => {
            const id = `route-${crypto.randomUUID().slice(0, 8)}`;
            const next: MatrixRoute = {
              id,
              prefix: id,
              name: "副路由",
              providerIds: [],
              activeProviderId: "",
              failover: false,
              policy: matrixPolicy(),
              models: [],
            };
            if (
              await persist({
                ...config,
                secondary: [...config.secondary, next],
              })
            )
              setSelected(id);
          }}
        >
          <Plus className="h-4 w-4" />
          添加副路由
        </Button>
        {!config.enabled ? (
          <Button
            size="compact"
            disabled={pending}
            onClick={() => void persist(config, true)}
          >
            保存并切换到路由矩阵
          </Button>
        ) : (
          <Button
            size="compact"
            variant="quiet"
            disabled={pending}
            onClick={() => void persist(config, false)}
          >
            恢复原连接并停用
          </Button>
        )}
      </div>
      {(query.error || error) && !editor && (
        <p role="alert" className="text-sm text-destructive">
          {error || extractErrorMessage(query.error)}
        </p>
      )}
      {message && (
        <p role="status" className="text-xs text-fg-2">
          {message}
        </p>
      )}
      <section
        role="tabpanel"
        aria-label={primary ? "主路由" : `副路由 ${route.prefix}`}
        className="space-y-3"
      >
        <div className="flex min-h-9 items-center gap-3">
          <RouteControls
            disabled={pending}
            status={{
              lead: config.enabled ? t("mode.status.routeLead") : "路由目标",
              value: `→ ${providers[route.activeProviderId]?.name ?? "未选择供应商"}`,
            }}
            failover={{
              enabled: route.failover,
              disabled: primary || pending,
              hint: primary ? "主路由使用手动切换" : undefined,
              onChange: (enabled) =>
                void replaceRoute({
                  ...route,
                  failover: enabled,
                  activeProviderId: enabled
                    ? (members[0] ?? "")
                    : route.activeProviderId,
                }),
            }}
            onOpenRouteSettings={() => openSettings("policy")}
            searchSlotRef={setSearchSlot}
          />
        </div>
        <div className="flex items-center justify-between gap-3 text-caption text-fg-2">
          <span>
            {primary
              ? "原始模型名 · 手动切换"
              : `rm-${route.prefix}/模型名 · 此路由独立故障转移`}
          </span>
          <Button
            variant="quiet"
            size="compact"
            disabled={pending}
            onClick={() => openSettings("models")}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            模型映射 · {route.models.length}
          </Button>
        </div>
        {members.some((id) => !providers[id]) && (
          <div className="flex items-center justify-between gap-3 rounded-panel border border-border px-4 py-3 text-caption">
            <span>此路由引用了已删除的供应商。</span>
            <Button
              variant="neutral"
              size="compact"
              onClick={() => openSettings("models")}
            >
              修复模型映射
            </Button>
          </div>
        )}
        <fieldset disabled={pending} className="min-w-0">
          <ProviderList
            key={route.id}
            {...providerActions}
            appId="codex"
            providers={scopedProviders}
            currentProviderId={route.activeProviderId}
            searchSlot={searchSlot}
            onEdit={(provider) => providerActions.onEdit(original(provider))}
            onDelete={(provider) =>
              providerActions.onDelete(original(provider))
            }
            onDuplicate={(provider) =>
              providerActions.onDuplicate(original(provider))
            }
            onConfigureUsage={
              providerActions.onConfigureUsage
                ? (provider) =>
                    providerActions.onConfigureUsage!(original(provider))
                : undefined
            }
            onOpenTerminal={
              providerActions.onOpenTerminal
                ? (provider) =>
                    providerActions.onOpenTerminal!(original(provider))
                : undefined
            }
            onSwitch={(provider) =>
              void replaceRoute({ ...route, activeProviderId: provider.id })
            }
            onSort={(ids) =>
              void replaceRoute(
                setRouteMembers(route, [
                  ...ids.filter((id) => members.includes(id)),
                  ...members.filter((id) => !ids.includes(id)),
                ]),
              )
            }
            buildSections={(visible) =>
              matrixRouteSections(
                route,
                primary,
                visible,
                t,
                {
                  choose: (provider) =>
                    void replaceRoute({
                      ...route,
                      activeProviderId: provider.id,
                    }),
                  add: (provider) =>
                    void replaceRoute(
                      setRouteMembers(route, [...members, provider.id]),
                    ),
                  remove: (provider) =>
                    void replaceRoute(
                      setRouteMembers(
                        route,
                        members.filter((id) => id !== provider.id),
                      ),
                    ),
                  move: (provider, delta) => {
                    const ids = [...members];
                    const at = ids.indexOf(provider.id);
                    const to = at + delta;
                    if (at < 0 || to < 0 || to >= ids.length) return;
                    ids.splice(to, 0, ...ids.splice(at, 1));
                    void replaceRoute(setRouteMembers(route, ids));
                  },
                  models: () => openSettings("models"),
                },
                config.enabled,
              )
            }
          />
        </fieldset>
      </section>
      <Sheet
        open={!!editor}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setEditor(undefined);
            setError("");
          }
        }}
      >
        <SheetContent width={560} closeLabel={t("common.close")}>
          <SheetHeader>
            <SheetTitle>{t("mode.routeSettingsTitle")}</SheetTitle>
            <SheetDescription>
              {primary ? "主路由" : editor?.name}
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            {editor && (
              <form ref={formRef} onSubmit={(event) => event.preventDefault()}>
                <fieldset disabled={pending} className="space-y-4">
                  <div
                    className="flex gap-2"
                    role="tablist"
                    aria-label="路由设置分类"
                  >
                    {(["policy", "models"] as const).map((tab) => (
                      <button
                        type="button"
                        role="tab"
                        key={tab}
                        aria-selected={editorTab === tab}
                        className={cn(
                          "rounded-control px-3 py-2 text-body",
                          editorTab === tab
                            ? "bg-selected font-semibold"
                            : "text-fg-2",
                        )}
                        onClick={() => {
                          if (formRef.current?.reportValidity())
                            setEditorTab(tab);
                        }}
                      >
                        {tab === "policy" ? "路由设置" : "模型映射"}
                      </button>
                    ))}
                  </div>
                  {error && (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  )}
                  {editorTab === "policy" ? (
                    <>
                      <label className="block space-y-2 text-sm">
                        路由名称
                        <Input
                          aria-label="路由名称"
                          value={editor.name}
                          onChange={(event) =>
                            setEditor({ ...editor, name: event.target.value })
                          }
                        />
                      </label>
                      {!primary && (
                        <label className="block space-y-2 text-sm">
                          模型前缀
                          <Input
                            aria-label="模型前缀"
                            required
                            pattern="[a-z0-9-]+"
                            value={editor.prefix}
                            onChange={(event) =>
                              setEditor({
                                ...editor,
                                prefix: event.target.value,
                              })
                            }
                          />
                        </label>
                      )}
                      <RoutingPolicyFields
                        idPrefix={`matrix-${editor.id}`}
                        values={editor.policy}
                        limits={policyLimits}
                        manual={primary}
                        disabled={pending}
                        onChange={(key, value) =>
                          setEditor({
                            ...editor,
                            policy: { ...editor.policy, [key]: Number(value) },
                          })
                        }
                      />
                    </>
                  ) : (
                    <MatrixModelsEditor
                      route={editor}
                      providers={providers}
                      onChange={setEditor}
                    />
                  )}
                </fieldset>
              </form>
            )}
          </SheetBody>
          <SheetFooter>
            {!primary && editor && (
              <Button
                variant="quiet"
                disabled={pending}
                className="mr-auto"
                onClick={async () => {
                  if (
                    await persist({
                      ...config,
                      secondary: config.secondary.filter(
                        (item) => item.id !== editor.id,
                      ),
                    })
                  ) {
                    setEditor(undefined);
                    setSelected(config.primary.id);
                  }
                }}
              >
                删除此路由
              </Button>
            )}
            <Button
              variant="neutral"
              disabled={pending}
              onClick={() => {
                setEditor(undefined);
                setError("");
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button disabled={pending} onClick={() => void saveSettings()}>
              保存路由设置
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
