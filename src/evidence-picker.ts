import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface EvidencePickerItem {
  id: string;
  createdAt: string;
  summary: string;
}

function displayText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export async function selectEvidence(
  ctx: ExtensionCommandContext,
  items: EvidencePickerItem[],
  signal: AbortSignal,
): Promise<string[] | null> {
  if (ctx.mode !== "tui") throw new Error("手动演化规则需要交互式 TUI");
  if (signal.aborted) return null;
  return ctx.ui.custom<string[] | null>((tui, theme, _keybindings, done) => {
    let cursor = 0;
    let settled = false;
    const selected = new Set<string>();
    const finish = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      done(value);
    };
    const abort = () => finish(null);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return {
      render(width: number): string[] {
        const lines = [
          truncateToWidth(theme.fg("accent", theme.bold("选择演化证据")), width),
          truncateToWidth(theme.fg("dim", "Space 勾选/取消 · ↑↓ 移动 · Enter 开始 · Left/Esc 取消"), width),
          "",
        ];
        const terminalRows = Math.max(4, Number(tui.terminal?.rows) || 24);
        const visibleCount = Math.max(1, terminalRows - lines.length);
        const start = Math.max(0, Math.min(
          cursor - Math.floor(visibleCount / 2),
          Math.max(0, items.length - visibleCount),
        ));
        const end = Math.min(items.length, start + visibleCount);
        for (let index = start; index < end; index += 1) {
          const item = items[index]!;
          const pointer = index === cursor ? theme.fg("accent", ">") : " ";
          const box = selected.has(item.id) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
          const label = `${pointer} ${box} ${index + 1}. ${displayText(item.createdAt)} · ${displayText(item.summary)}`;
          lines.push(truncateToWidth(label, width, "…"));
        }
        return lines;
      },
      handleInput(data: string): void {
        if (settled) return;
        if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
        else if (matchesKey(data, Key.down)) cursor = Math.min(items.length - 1, cursor + 1);
        else if (matchesKey(data, Key.space)) {
          const id = items[cursor]?.id;
          if (id) {
            if (selected.has(id)) selected.delete(id);
            else selected.add(id);
          }
        } else if (matchesKey(data, Key.enter)) {
          finish(items.filter((item) => selected.has(item.id)).map((item) => item.id));
          return;
        } else if (matchesKey(data, Key.left) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          finish(null);
          return;
        }
        tui.requestRender();
      },
      invalidate(): void {},
    };
  });
}
