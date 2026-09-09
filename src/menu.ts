import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

export interface MenuItem {
  value: string;
  label?: string;
  description?: string;
}

export interface MenuSelection {
  value: string;
  action: "select" | "space";
}

export class MenuSession {
  private readonly selectedValues = new Map<string, string>();
  private readonly ctx: ExtensionCommandContext;

  constructor(ctx: ExtensionCommandContext) {
    this.ctx = ctx;
  }

  async select(key: string, title: string, items: MenuItem[], signal?: AbortSignal): Promise<string | undefined> {
    return (await this.selectResult(key, title, items, false, signal))?.value;
  }

  async selectAction(key: string, title: string, items: MenuItem[], signal?: AbortSignal): Promise<MenuSelection | undefined> {
    return this.selectResult(key, title, items, true, signal);
  }

  private async selectResult(
    key: string,
    title: string,
    items: MenuItem[],
    allowSpace: boolean,
    signal?: AbortSignal,
  ): Promise<MenuSelection | undefined> {
    if (!items.length || signal?.aborted) return undefined;
    if (this.ctx.mode !== "tui") {
      const labels = items.map((item) => item.label ?? item.value);
      const selected = await this.ctx.ui.select(title, labels);
      if (signal?.aborted) return undefined;
      const item = items.find((candidate) => (candidate.label ?? candidate.value) === selected);
      if (item) this.selectedValues.set(key, item.value);
      return item ? { value: item.value, action: "select" } : undefined;
    }
    return this.ctx.ui.custom<MenuSelection | undefined>((tui, theme, _keybindings, done) => {
      let settled = false;
      const finish = (value: MenuSelection | undefined) => {
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
      const selectCurrent = (action: MenuSelection["action"]) => {
        const current = selectList.getSelectedItem();
        if (!current) return;
        this.selectedValues.set(key, current.value);
        finish({ value: current.value, action });
      };
      selectList.onSelectionChange = rememberCurrent;
      selectList.onSelect = (item) => {
        this.selectedValues.set(key, item.value);
        finish({ value: item.value, action: "select" });
      };
      selectList.onCancel = () => {
        rememberCurrent();
        finish(undefined);
      };

      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      container.addChild(selectList);
      const hint = allowSpace
        ? terminalColumns < 50
          ? "Space编辑 · ↑↓移动"
          : "↑↓ 移动 · Space 编辑 · Right/Enter 查看 · Left/Esc 返回"
        : terminalColumns < 50 ? "↑↓ 移动 · → 进入 · ← 返回" : "↑↓ 移动 · Right/Enter 进入 · Left/Esc 返回";
      container.addChild(new Text(theme.fg("dim", hint), 1, 0));
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      if (signal?.aborted) abort();

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (settled) return;
          if (allowSpace && matchesKey(data, Key.space)) {
            selectCurrent("space");
            return;
          }
          if (matchesKey(data, Key.left)) {
            rememberCurrent();
            finish(undefined);
            return;
          }
          if (matchesKey(data, Key.right)) {
            selectCurrent("select");
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }
}
