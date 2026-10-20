import { useTranslation } from "react-i18next";
import { Settings2, Shuffle } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/hover-tip";

export interface RouteControlsProps {
  disabled?: boolean;
  status?: { lead: string; value: string };
  failover?: {
    enabled: boolean;
    disabled?: boolean;
    hint?: string;
    onChange: (enabled: boolean) => void;
  };
  onOpenRouteSettings?: () => void;
  searchSlotRef?: (node: HTMLDivElement | null) => void;
}

/** Shared by the ordinary route and each isolated matrix route. */
export function RouteControls({
  disabled,
  status,
  failover,
  onOpenRouteSettings,
  searchSlotRef,
}: RouteControlsProps) {
  const { t } = useTranslation();
  return (
    <>
      {status && (status.lead || status.value) ? (
        <div className="flex min-w-0 flex-1 items-center gap-1 text-caption text-fg-2">
          {status.lead && <span className="truncate">{status.lead}</span>}
          <span className="max-w-full shrink-0 truncate" title={status.value}>
            {status.value}
          </span>
        </div>
      ) : (
        <div className="flex-1" />
      )}
      {searchSlotRef && (
        <div
          ref={searchSlotRef}
          className="flex min-w-0 shrink items-center empty:hidden"
        />
      )}
      {failover && (
        <HoverTip content={failover.hint ?? t("mode.failover")}>
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
            <Shuffle
              className="h-4 w-4 text-fg-2"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <Switch
              checked={failover.enabled}
              disabled={failover.disabled}
              onCheckedChange={failover.onChange}
              aria-label={t("mode.failover")}
            />
          </label>
        </HoverTip>
      )}
      {onOpenRouteSettings && (
        <HoverTip content={t("mode.routeSettings")}>
          <Button
            disabled={disabled}
            variant="quiet"
            size="compact"
            className="h-8 w-8 shrink-0 px-0"
            aria-label={t("mode.routeSettings")}
            onClick={onOpenRouteSettings}
          >
            <Settings2 className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </HoverTip>
      )}
    </>
  );
}
