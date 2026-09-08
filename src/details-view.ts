import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type DetailDecision = "apply" | "reject" | "later";

export interface DetailViewOptions {
  decision?: boolean;
  applyLabel?: string;
  rejectLabel?: string;
  laterLabel?: string;
  signal?: AbortSignal;
}

function wrappedLines(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const source of text.split("\n")) {
    if (!source) lines.push("");
    else lines.push(...wrapTextWithAnsi(source, Math.max(1, width)));
  }
  return lines;
}

export async function showReadOnlyDetails(
  ctx: ExtensionCommandContext,
  title: string,
  text: string,
  options: DetailViewOptions = {},
): Promise<DetailDecision> {
  if (ctx.mode !== "tui") throw new Error("详情查看需要交互式 TUI");
  return ctx.ui.custom<DetailDecision>((tui, theme, _keybindings, done) => {
    let offset = 0;
    let settled = false;
    const finish = (decision: DetailDecision) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      done(decision);
    };
    const abort = () => finish("later");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let cachedWidth = 0;
    let cachedLines: string[] = [];

    function body(width: number): string[] {
      if (cachedWidth !== width) {
        cachedWidth = width;
        cachedLines = wrappedLines(text, width);
      }
      return cachedLines;
    }

    function viewportHeight(): number {
      return Math.max(1, (Number(tui.terminal?.rows) || 24) - 3);
    }

    function move(delta: number, width: number): void {
      const maximum = Math.max(0, body(width).length - viewportHeight());
      offset = Math.max(0, Math.min(maximum, offset + delta));
      tui.requestRender();
    }

    return {
      render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const content = body(safeWidth);
        const height = viewportHeight();
        const maximum = Math.max(0, content.length - height);
        offset = Math.min(offset, maximum);
        const visible = content.slice(offset, offset + height);
        while (visible.length < height) visible.push("");
        const help = options.decision
          ? `↑↓/PgUp/PgDn 滚动 · A ${options.applyLabel ?? "应用"} · R ${options.rejectLabel ?? "拒绝"} · Esc ${options.laterLabel ?? "稍后"}`
          : "↑↓/PgUp/PgDn 滚动 · Esc 退出";
        return [
          truncateToWidth(theme.fg("accent", theme.bold(title)), safeWidth, "…"),
          ...visible.map((line) => truncateToWidth(line, safeWidth, "")),
          truncateToWidth(theme.fg("dim", `${help} · ${offset + 1}-${Math.min(content.length, offset + height)}/${content.length}`), safeWidth, "…"),
        ];
      },
      handleInput(data: string): void {
        const width = Math.max(1, Number(tui.terminal?.columns) || 80);
        const page = Math.max(1, viewportHeight() - 1);
        if (matchesKey(data, Key.up)) move(-1, width);
        else if (matchesKey(data, Key.down)) move(1, width);
        else if (matchesKey(data, Key.pageUp)) move(-page, width);
        else if (matchesKey(data, Key.pageDown)) move(page, width);
        else if (matchesKey(data, Key.home)) {
          offset = 0;
          tui.requestRender();
        } else if (matchesKey(data, Key.end)) {
          offset = Math.max(0, body(width).length - viewportHeight());
          tui.requestRender();
        } else if (options.decision && (data === "a" || data === "A")) finish("apply");
        else if (options.decision && (data === "r" || data === "R")) finish("reject");
        else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) finish("later");
      },
      invalidate(): void {
        cachedWidth = 0;
        cachedLines = [];
      },
    };
  });
}
