import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type RoutingPolicyKey =
  | "maxRetries"
  | "failureThreshold"
  | "firstByteTimeout"
  | "idleTimeout"
  | "requestTimeout"
  | "cooldownSeconds";
export type RoutingPolicyValues = Record<RoutingPolicyKey, string | number>;
type Limits = Record<RoutingPolicyKey, { min: number; max: number }>;
const defaultLimits: Limits = {
  maxRetries: { min: 0, max: 10 },
  failureThreshold: { min: 1, max: 20 },
  firstByteTimeout: { min: 1, max: 120 },
  idleTimeout: { min: 0, max: 600 },
  requestTimeout: { min: 60, max: 1200 },
  cooldownSeconds: { min: 0, max: 300 },
};
const fields: Record<
  RoutingPolicyKey,
  { id: string; key: string; label: string; hint: string }
> = {
  maxRetries: {
    id: "maxRetries",
    key: "maxRetries",
    label: "最大重试次数",
    hint: "请求失败时的重试次数（0-10）",
  },
  failureThreshold: {
    id: "failureThreshold",
    key: "failureThreshold",
    label: "失败阈值",
    hint: "连续失败多少次后打开熔断器（建议: 3-10）",
  },
  firstByteTimeout: {
    id: "streamingFirstByte",
    key: "streamingFirstByte",
    label: "流式首字节超时（秒）",
    hint: "等待首个数据块的最大时间，范围 1-120 秒，默认 60 秒",
  },
  idleTimeout: {
    id: "streamingIdle",
    key: "streamingIdle",
    label: "流式静默超时（秒）",
    hint: "数据块之间的最大间隔，范围 60-600 秒，填 0 禁用（防止中途卡住）",
  },
  requestTimeout: {
    id: "nonStreaming",
    key: "nonStreaming",
    label: "非流式超时（秒）",
    hint: "非流式请求的总超时时间，范围 60-1200 秒，默认 600 秒（10 分钟）",
  },
  cooldownSeconds: {
    id: "timeoutSeconds",
    key: "timeout",
    label: "恢复等待时间（秒）",
    hint: "熔断器打开后，等待多久后尝试恢复（建议: 30-120）",
  },
};

/** Pure fields: the owning route supplies state and persistence. */
export function RoutingPolicyFields({
  idPrefix,
  values,
  onChange,
  disabled,
  manual = false,
  limits,
  circuitBefore,
  circuitAfter,
}: {
  idPrefix: string;
  values: RoutingPolicyValues;
  onChange: (key: RoutingPolicyKey, value: string) => void;
  disabled?: boolean;
  manual?: boolean;
  limits?: Limits;
  circuitBefore?: ReactNode;
  circuitAfter?: ReactNode;
}) {
  const { t } = useTranslation();
  const field = (key: RoutingPolicyKey) => {
    const f = fields[key];
    const range = (limits ?? defaultLimits)[key];
    return (
      <div key={key} className="space-y-2">
        <Label htmlFor={`${f.id}-${idPrefix}`}>
          {t(`proxy.autoFailover.${f.key}`, f.label)}
        </Label>
        <Input
          id={`${f.id}-${idPrefix}`}
          type="number"
          {...range}
          value={values[key]}
          onChange={(event) => onChange(key, event.target.value)}
          disabled={disabled}
        />
        <p className="text-xs text-fg-2">
          {limits
            ? `${range.min}–${range.max}`
            : t(`proxy.autoFailover.${f.key}Hint`, f.hint)}
        </p>
      </div>
    );
  };
  return (
    <>
      {!manual && (
        <div className="space-y-4 rounded-lg border border-white/10 bg-subtle p-4">
          <h4 className="text-sm font-semibold">
            {t("proxy.autoFailover.retrySettings", "重试与超时设置")}
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {field("maxRetries")}
            {field("failureThreshold")}
          </div>
        </div>
      )}
      <div className="space-y-4 rounded-lg border border-white/10 bg-subtle p-4">
        <h4 className="text-sm font-semibold">
          {t("proxy.autoFailover.timeoutSettings", "超时配置")}
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {field("firstByteTimeout")}
          {field("idleTimeout")}
          {field("requestTimeout")}
        </div>
      </div>
      {!manual && (
        <div className="space-y-4 rounded-lg border border-white/10 bg-subtle p-4">
          <h4 className="text-sm font-semibold">
            {t("proxy.autoFailover.circuitBreakerSettings", "熔断器配置")}
          </h4>
          <div
            className={`grid grid-cols-2 gap-4 ${circuitBefore || circuitAfter ? "md:grid-cols-4" : ""}`}
          >
            {circuitBefore}
            {field("cooldownSeconds")}
            {circuitAfter}
          </div>
        </div>
      )}
    </>
  );
}
