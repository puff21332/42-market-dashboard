export function compactNumber(value: number | null | undefined, digits = 1) {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: digits,
  }).format(n);
}

export function money(value: number | null | undefined, digits = 0) {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(n);
}

export function percent(value: number | null | undefined, digits = 1) {
  const n = Number(value ?? 0);
  return `${n.toFixed(digits)}%`;
}

export function signedMoney(value: number | null | undefined) {
  const n = Number(value ?? 0);
  const prefix = n > 0 ? "+" : "";
  return `${prefix}${money(n)}`;
}

export function shortDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function fullTime(value: string | null | undefined) {
  if (!value) return "尚未采集";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}
