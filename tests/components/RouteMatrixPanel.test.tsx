import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "../utils/testQueryClient";
import type { Provider } from "@/types";
import { RouteMatrixPanel } from "@/components/route-matrix/RouteMatrixPanel";
import {
  matrixPolicy,
  routeMatrixApi,
  type MatrixConfig,
} from "@/lib/api/routeMatrix";
import { providersApi } from "@/lib/api/providers";
import { proxyApi } from "@/lib/api/proxy";
import { failoverApi } from "@/lib/api/failover";

vi.mock("@/lib/api/routeMatrix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/routeMatrix")>()),
  routeMatrixApi: { get: vi.fn(), save: vi.fn(), connect: vi.fn() },
}));
// Keep the real card actions and list: only quota/identity content is irrelevant here.
vi.mock("@/components/providers/ProviderCard", async () => {
  const { ProviderCardActions } = await import(
    "@/components/providers/ProviderCardActions"
  );
  return {
    ProviderCard: (props: any) => (
      <article aria-label={props.provider.name}>
        <h3>{props.provider.name}</h3>
        <ProviderCardActions
          providerName={props.provider.name}
          presentation={props.presentation}
          onEdit={() => props.onEdit(props.provider)}
          onDelete={() => props.onDelete(props.provider)}
        />
      </article>
    ),
  };
});
vi.mock("@/hooks/useStreamCheck", () => ({
  useStreamCheck: () => ({ checkProvider: vi.fn(), isChecking: () => false }),
}));
const official = (id: string): Provider => ({
  id,
  name: `账号 ${id.toUpperCase()}`,
  category: "official",
  settingsConfig: { auth: {}, config: "" },
  meta: {
    authBinding: {
      source: "managed_account",
      authProvider: "codex_oauth",
      accountId: `account-${id}`,
    },
  },
});
const providers: Record<string, Provider> = {
  a: official("a"),
  b: official("b"),
  c: official("c"),
  unbound: {
    id: "unbound",
    name: "未绑定官方账号",
    category: "official",
    settingsConfig: { auth: {}, config: "" },
  },
};
const globalSwitch = vi.spyOn(providersApi, "switch");
const globalSort = vi.spyOn(providersApi, "updateSortOrder");
const globalFailover = vi.spyOn(failoverApi, "setAutoFailoverEnabled");
const globalPolicy = vi.spyOn(proxyApi, "updateProxyConfigForApp");
const editProvider = vi.fn();
let config: MatrixConfig;
beforeEach(() => {
  config = {
    version: 1,
    enabled: true,
    primary: {
      id: "main",
      name: "主路由",
      prefix: "",
      activeProviderId: "a",
      failover: false,
      policy: matrixPolicy(),
      models: [
        {
          id: "gpt-test",
          targets: [
            { providerId: "a", model: "actual-a" },
            { providerId: "b", model: "actual-b" },
          ],
          catalog: {},
        },
      ],
    },
    secondary: [],
  };
  vi.mocked(routeMatrixApi.get).mockImplementation(async () =>
    structuredClone(config),
  );
  vi.mocked(routeMatrixApi.save).mockImplementation(async (next) => {
    config = structuredClone(next);
  });
  vi.mocked(routeMatrixApi.connect).mockImplementation(async (enabled) => {
    config.enabled = enabled;
  });
  Element.prototype.scrollIntoView = vi.fn();
});
async function open() {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RouteMatrixPanel
        providers={providers}
        onEdit={editProvider}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole("tabpanel", { name: "主路由" });
}
const card = (name: string) => within(screen.getByRole("article", { name }));
async function settled() {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "添加副路由" }),
    ).not.toBeDisabled(),
  );
}
async function cardClick(name: string, label: string) {
  fireEvent.click(card(name).getByRole("button", { name: label }));
  await settled();
}
async function settings() {
  fireEvent.click(screen.getByRole("button", { name: "mode.routeSettings" }));
  await screen.findByRole("dialog");
}
async function models() {
  fireEvent.click(screen.getByRole("button", { name: /模型映射 ·/ }));
  await screen.findByRole("dialog");
}
async function saveSettings() {
  fireEvent.click(screen.getByRole("button", { name: "保存路由设置" }));
  await settled();
}

describe("Route Matrix shared route UI", () => {
  it("uses route card actions to hot-switch accounts without touching the ordinary route", async () => {
    await open();
    expect(
      card("账号 A").getByText("providerCard.status.routing"),
    ).toBeInTheDocument();
    await cardClick("账号 B", "providerCard.action.routeHere");
    expect(config.primary.activeProviderId).toBe("b");
    expect(
      card("账号 B").getByText("providerCard.status.routing"),
    ).toBeInTheDocument();
    expect(globalSwitch).not.toHaveBeenCalled();
    expect(routeMatrixApi.connect).not.toHaveBeenCalled();
    expect(screen.getByText(/已保存，后续请求使用新配置/)).toBeInTheDocument();
  });
  it("adds several official members using the same cards, with same-name mappings", async () => {
    await open();
    expect(
      card("未绑定官方账号").getByRole("button", { name: "加入此路由" }),
    ).toHaveAttribute("aria-disabled", "true");
    await cardClick("账号 C", "加入此路由");
    expect(config.primary.providerIds).toEqual(["a", "b", "c"]);
    expect(config.primary.models[0].targets[2]).toEqual({
      providerId: "c",
      model: "gpt-test",
    });
    await models();
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.change(screen.getAllByLabelText("发布模型 ID")[1], {
      target: { value: "gpt-other" },
    });
    await saveSettings();
    expect(config.primary.models[1].targets).toEqual(
      ["a", "b", "c"].map((providerId) => ({ providerId, model: "gpt-other" })),
    );
  });
  it("removes a member through the shared card menu while keeping other accounts", async () => {
    await open();
    const user = userEvent.setup();
    await user.click(
      card("账号 A").getByRole("button", { name: "providerCard.action.more" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "从此路由移除" }));
    await settled();
    expect(config.primary.providerIds).toEqual(["b"]);
    expect(config.primary.activeProviderId).toBe("b");
    expect(config.primary.models[0].targets).toEqual([
      { providerId: "b", model: "actual-b" },
    ]);
  });
  it("keeps the main route manual and allows a model to pin a different account", async () => {
    await open();
    expect(
      screen.getByRole("switch", { name: "mode.failover" }),
    ).toBeDisabled();
    await models();
    fireEvent.change(screen.getByLabelText("此模型的供应商"), {
      target: { value: "b" },
    });
    await saveSettings();
    expect(config.primary.activeProviderId).toBe("a");
    expect(config.primary.models[0].activeProviderId).toBe("b");
  });
  it("keeps queue priority, failover and policy changes scoped to the selected secondary route", async () => {
    config.secondary = ["backup", "other"].map((id) => ({
      ...structuredClone(config.primary),
      id,
      name: id,
      prefix: id,
    }));
    const beforeMain = structuredClone(config.primary);
    const beforeOther = structuredClone(config.secondary[1]);
    await open();
    fireEvent.click(screen.getByRole("tab", { name: /backup/ }));
    fireEvent.click(screen.getByRole("switch", { name: "mode.failover" }));
    await settled();
    expect(
      screen.getByRole("heading", { name: "providerCard.section.queue" }),
    ).toBeInTheDocument();
    await cardClick("账号 B", "providerCard.action.moveUp");
    expect(config.secondary[0].providerIds).toEqual(["b", "a"]);
    expect(
      config.secondary[0].models[0].targets.map((target) => target.providerId),
    ).toEqual(["b", "a"]);
    expect(config.secondary[0].activeProviderId).toBe("b");
    await settings();
    fireEvent.change(screen.getByLabelText("恢复等待时间（秒）"), {
      target: { value: "30" },
    });
    await saveSettings();
    expect(config.secondary[0].policy.cooldownSeconds).toBe(30);
    expect(config.primary).toEqual(beforeMain);
    expect(config.secondary[1]).toEqual(beforeOther);
    expect(globalFailover).not.toHaveBeenCalled();
    expect(globalPolicy).not.toHaveBeenCalled();
    expect(globalSort).not.toHaveBeenCalled();
  });
  it("rolls back the displayed route when an immediate card operation fails", async () => {
    vi.mocked(routeMatrixApi.save).mockRejectedValueOnce("模型映射不完整");
    await open();
    await cardClick("账号 B", "providerCard.action.routeHere");
    expect(screen.getByRole("alert")).toHaveTextContent("模型映射不完整");
    expect(
      card("账号 A").getByText("providerCard.status.routing"),
    ).toBeInTheDocument();
    expect(config.primary.activeProviderId).toBe("a");
    expect(routeMatrixApi.connect).not.toHaveBeenCalled();
  });
  it("does not reconnect if activation cannot save", async () => {
    config.enabled = false;
    vi.mocked(routeMatrixApi.save).mockRejectedValueOnce("模型映射不完整");
    await open();
    fireEvent.click(
      screen.getByRole("button", { name: "保存并切换到路由矩阵" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "模型映射不完整",
    );
    expect(routeMatrixApi.connect).not.toHaveBeenCalled();
  });
  it("adds a secondary route and configures its prefix in the shared settings drawer", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "添加副路由" }));
    await settled();
    await screen.findByRole("tabpanel", { name: /副路由/ });
    await settings();
    fireEvent.change(screen.getByLabelText("模型前缀"), {
      target: { value: "backup" },
    });
    await saveSettings();
    expect(config.secondary[0].prefix).toBe("backup");
    expect(config.primary.failover).toBe(false);
  });
  it("cancels settings without changing the saved route", async () => {
    await open();
    await settings();
    fireEvent.change(screen.getByLabelText("路由名称"), {
      target: { value: "unsaved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(config.primary.name).toBe("主路由");
    expect(routeMatrixApi.save).not.toHaveBeenCalled();
  });
  it("rejects invalid model capability JSON in the models drawer", async () => {
    await open();
    await models();
    const input = screen.getByLabelText("模型能力参数");
    fireEvent.change(input, { target: { value: "{invalid" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "保存路由设置" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请修正配置");
    expect(routeMatrixApi.save).not.toHaveBeenCalled();
  });
  it("opens the existing provider editor with the original global provider order", async () => {
    await open();
    await cardClick("账号 B", "providerCard.action.edit");
    expect(editProvider).toHaveBeenCalledWith(providers.b);
    expect(editProvider.mock.calls[0][0].sortIndex).toBeUndefined();
  });
});
