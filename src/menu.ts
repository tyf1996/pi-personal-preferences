import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

export interface MenuItem {
  value: string;
  label?: string;
  description?: string;
}

export class MenuSession {
  private readonly selectedValues = new Map<string, string>();
  private readonly ctx: ExtensionCommandContext;

  constructor(ctx: ExtensionCommandContext) {
    this.ctx = ctx;
  }

  async select(key: string, title: string, items: MenuItem[], signal?: AbortSignal): Promise<string | undefined> {
    if (!items.length || signal?.aborted) return undefined;
    if (this.ctx.mode !== "tui") {
      const labels = items.map((item) => item.label ?? item.value);
      const selected = await this.ctx.ui.select(title, labels);
      const item = items.find((candidate) => (candidate.label ?? candidate.value) === selected);
      if (item) this.selectedValues.set(key, item.value);
      return item?.value;
    }
    return this.ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        done(value);
      };
      const abort = () => finish(undefined);
      signal?.addEventListener("abort", abort, { once: true });
      const selectItems: SelectItem[] = items.map((item) => ({
        value: item.value,
        label: item.label ?? item.value,
        description: item.description,
      }));
      const terminalRows = Math.max(6, Number(tui.terminal?.rows) || 24);
      const terminalColumns = Math.max(1, Number(tui.terminal?.columns) || 80);
      const selectList = new SelectList(selectItems, Math.max(1, Math.min(selectItems.length, terminalRows - 5)), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      const remembered = this.selectedValues.get(key);
      const initialIndex = remembered ? selectItems.findIndex((item) => item.value === remembered) : 0;
      selectList.setSelectedIndex(initialIndex >= 0 ? initialIndex : 0);
      const rememberCurrent = () => {
        const current = selectList.getSelectedItem();
        if (current) this.selectedValues.set(key, current.value);
      };
      selectList.onSelectionChange = rememberCurrent;
      selectList.onSelect = (item) => {
        this.selectedValues.set(key, item.value);
        finish(item.value);
      };
      selectList.onCancel = () => {
        rememberCurrent();
        finish(undefined);
      };

      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      container.addChild(selectList);
      const hint = terminalColumns < 50 ? "↑↓ 移动 · → 进入 · ← 返回" : "↑↓ 移动 · Right/Enter 进入 · Left/Esc 返回";
      container.addChild(new Text(theme.fg("dim", hint), 1, 0));
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      if (signal?.aborted) abort();

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (settled) return;
          if (matchesKey(data, Key.left)) {
            rememberCurrent();
            finish(undefined);
            return;
          }
          if (matchesKey(data, Key.right)) {
            const current = selectList.getSelectedItem();
            if (current) {
              this.selectedValues.set(key, current.value);
              finish(current.value);
            }
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }
}
