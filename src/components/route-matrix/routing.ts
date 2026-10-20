import type { Provider } from "@/types";
import type { TFunction } from "i18next";
import type { MatrixRoute } from "@/lib/api/routeMatrix";
import { resolveCodexOfficialIdentity } from "@/utils/providerCapabilities";
import {
  buildSwitchSections,
  type ProviderSection,
} from "@/components/providers/presentation";

export function routeMembers(route: MatrixRoute): string[] {
  return (
    route.providerIds ?? [
      ...new Set([
        ...route.models.flatMap((model) =>
          model.targets.map((target) => target.providerId),
        ),
        ...(route.activeProviderId ? [route.activeProviderId] : []),
      ]),
    ]
  );
}

export function setRouteMembers(
  route: MatrixRoute,
  providerIds: string[],
): MatrixRoute {
  const previous = routeMembers(route);
  return {
    ...route,
    providerIds,
    activeProviderId: route.failover
      ? (providerIds[0] ?? "")
      : providerIds.includes(route.activeProviderId)
        ? route.activeProviderId
        : (providerIds[0] ?? ""),
    models: route.models.map((model) => ({
      ...model,
      activeProviderId:
        model.activeProviderId && providerIds.includes(model.activeProviderId)
          ? model.activeProviderId
          : undefined,
      targets: [
        ...model.targets.filter((target) =>
          providerIds.includes(target.providerId),
        ),
        ...providerIds
          .filter((id) => !previous.includes(id))
          .map((providerId) => ({ providerId, model: model.id })),
      ].sort(
        (a, b) =>
          providerIds.indexOf(a.providerId) - providerIds.indexOf(b.providerId),
      ),
    })),
  };
}

export function matrixRouteSections(
  route: MatrixRoute,
  primary: boolean,
  providers: Provider[],
  t: TFunction,
  actions: {
    choose: (provider: Provider) => void;
    add: (provider: Provider) => void;
    remove: (provider: Provider) => void;
    move: (provider: Provider, delta: -1 | 1) => void;
    models: () => void;
  },
  enabled = true,
): ProviderSection[] {
  const members = routeMembers(route);
  const blocked = (provider: Provider) =>
    resolveCodexOfficialIdentity("codex", provider) === "native_login";
  const noop = () => undefined;
  const sections = buildSwitchSections({
    app: "codex",
    t,
    providers,
    active: "route",
    view: "route",
    directId: null,
    routeId: route.activeProviderId,
    failoverOn: route.failover,
    queue: members,
    stackMembers: new Map(),
    serviceRunning: false,
    routingReason: () => "",
    routeCapabilities: {
      blocked,
      supportsFailover: (provider) => !blocked(provider),
    },
    actions: {
      routeTo: actions.choose,
      queueAdd: actions.add,
      queueRemove: actions.remove,
      queueMove: actions.move,
      switchDirect: noop,
      needsRouteDialog: noop,
      exitAndUse: noop,
      stackAdd: noop,
      stackRemove: noop,
      stackSetDefault: noop,
    },
  });
  const unboundReason =
    "请先为此官方供应商绑定 CC Switch 中的具体 ChatGPT 账号";
  const items = sections
    .flatMap((section) => section.items)
    .map((item) => {
      const member = members.includes(item.provider.id);
      const cannotRemove =
        member && members.length === 1 && route.models.length > 0;
      return {
        ...item,
        presentation: {
          ...item.presentation,
          status:
            item.presentation.status && !enabled
              ? { ...item.presentation.status, label: "默认供应商" }
              : item.presentation.status,
          // Matrix health is independent of the ordinary route's provider-health table.
          showHealth: false,
          buttons: item.presentation.buttons.map((button) => ({
            ...button,
            disabledReason: blocked(item.provider)
              ? unboundReason
              : button.key === "queueRemove" && cannotRemove
                ? "请先删除此路由的模型或加入其他供应商"
                : button.disabledReason,
          })),
          menuItems: member
            ? [
                {
                  key: "matrixModels",
                  label: "配置此路由模型",
                  onSelect: actions.models,
                },
                ...(!route.failover
                  ? [
                      {
                        key: "matrixRemove",
                        label: "从此路由移除",
                        disabledReason: cannotRemove
                          ? "请先删除此路由的模型或加入其他供应商"
                          : undefined,
                        onSelect: () => actions.remove(item.provider),
                      },
                    ]
                  : []),
              ]
            : [],
        },
      };
    });
  if (route.failover)
    return sections.map((section) => ({
      ...section,
      items: section.items.map(
        (item) => items.find((next) => next.provider.id === item.provider.id)!,
      ),
    }));
  return [
    {
      key: "members",
      title: `${primary ? "主路由供应商" : "路由供应商"}（${members.length}）`,
      emptyText: "从下方加入供应商，再配置此路由的模型。",
      items: members.flatMap((id) =>
        items.filter((item) => item.provider.id === id),
      ),
    },
    {
      key: "available",
      title: "可加入的供应商",
      items: items
        .filter((item) => !members.includes(item.provider.id))
        .map((item) => ({
          ...item,
          presentation: {
            ...item.presentation,
            buttons: [
              {
                key: "queueAdd",
                label: "加入此路由",
                disabledReason: blocked(item.provider)
                  ? unboundReason
                  : undefined,
                onClick: () => actions.add(item.provider),
              },
            ],
          },
        })),
    },
  ];
}
