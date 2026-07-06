export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function badgeClass(kind: string): "good" | "warn" | "bad" | "neutral" {
  return kind === "good" || kind === "warn" || kind === "bad" ? kind : "neutral";
}

export function formatValue(value: unknown, fallback = "-"): string {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

export function formatToGmt7(dateInput: unknown): string {
  if (!dateInput || dateInput === "-") {
    return "-";
  }
  const date = new Date(String(dateInput));
  if (!Number.isFinite(date.getTime())) {
    return String(dateInput);
  }
  return dateParts(date, true);
}

export function formatDateGmt7(dateInput: unknown): string {
  if (!dateInput || dateInput === "-") {
    return "-";
  }
  const date = new Date(String(dateInput));
  if (!Number.isFinite(date.getTime())) {
    return String(dateInput);
  }
  return dateParts(date, false);
}

function dateParts(date: Date, includeTime: boolean): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime
      ? {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }
      : {}),
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  if (!includeTime) {
    return `${year}-${month}-${day}`;
  }
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const second = parts.find((part) => part.type === "second")?.value ?? "00";
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export function inferPlan(fileName: string): string {
  const stem = fileName.replace(/\.json(?:\.disabled)?$/, "");
  const parts = stem.split("-");
  return parts.length > 1 ? parts[parts.length - 1] ?? "free" : "free";
}

export function quotaStatusClass(status: string): "good" | "warn" | "bad" | "neutral" {
  if (status === "current") {
    return "good";
  }
  if (status === "blocked") {
    return "bad";
  }
  if (status === "unknown") {
    return "neutral";
  }
  return "warn";
}

export function quotaUsageClass(usedPercent: number | undefined): "good" | "warn" | "bad" | "neutral" {
  if (usedPercent === undefined) {
    return "neutral";
  }
  if (usedPercent >= 90) {
    return "bad";
  }
  if (usedPercent >= 70) {
    return "warn";
  }
  return "good";
}

export function relativeAge(observedAt: string | undefined, nowMs = Date.now()): string {
  const observedMs = observedAt ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(observedMs) || nowMs < observedMs) {
    return "";
  }
  const minutes = Math.round((nowMs - observedMs) / 60000);
  if (minutes < 1) {
    return "Observed just now";
  }
  if (minutes < 60) {
    return `Observed ${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `Observed ${hours}h ago`;
  }
  return `Observed ${Math.round(hours / 24)}d ago`;
}

export function resetLabel(resetAt: string | undefined, nowMs = Date.now()): string {
  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  if (!Number.isFinite(resetMs)) {
    return "";
  }
  if (nowMs > resetMs) {
    return "Reset passed";
  }
  return `Resets ${new Date(resetMs).toLocaleString("en-US", {
    timeZone: "Asia/Bangkok",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}
