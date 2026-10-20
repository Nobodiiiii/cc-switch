import type { MatrixRoute } from "@/lib/api/routeMatrix";

export const normalizeRoutePrefix = (prefix: string) =>
  prefix.trim().toLowerCase();

export function routePrefixError(
  route: MatrixRoute,
  secondary: MatrixRoute[],
): string {
  if (!route.prefix) return "请填写副路由的模型前缀，例如 any。";
  if (route.prefix.length > 48) return "副路由前缀最多 48 个字符。";
  if (!/^[a-z0-9-]+$/.test(route.prefix))
    return "副路由前缀只能包含小写字母、数字和短横线，例如 any，不含结尾的 /。";
  if (route.prefix.startsWith("ccs-"))
    return "副路由前缀不能以保留的 ccs- 开头。";
  const conflict = secondary.find(
    (other) => other.id !== route.id && other.prefix === route.prefix,
  );
  return conflict
    ? `前缀 ${route.prefix} 已被路由「${conflict.name || conflict.id}」使用，请换一个。`
    : "";
}
