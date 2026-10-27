/**
 * 原生右键菜单：把纯数据 [`MenuSpec`] 装配成 Tauri 原生菜单并弹出。
 *
 * 为什么用原生菜单而不是自绘：原生菜单自带键盘导航、系统主题、屏幕边缘避让，
 * 并且和托盘菜单同一套渲染。
 *
 * 资源与竞态：
 * - 每次弹出使用自增 `seq` 与全新 id（`ctx:<n>`），不会和托盘的 `session:` /
 *   `mode:` / 固定 id 相撞（托盘路由的 `_ => {}` 会忽略它们）；
 * - 构建期间若有更新的弹出请求，本菜单直接关闭（最多只有一个存活）；
 * - 弹出成功后关闭上一个存活菜单，避免资源泄漏。
 */
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";

export type MenuSpec =
  | {
      kind: "item";
      text: string;
      enabled?: boolean;
      run: () => void | Promise<void>;
    }
  | {
      kind: "check";
      text: string;
      checked: boolean;
      enabled?: boolean;
      run: () => void | Promise<void>;
    }
  | { kind: "separator" }
  | { kind: "submenu"; text: string; enabled?: boolean; items: MenuSpec[] };

type NativeItem = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu;

let seq = 0;
let live: Menu | null = null;

/** 动作异常只记控制台：菜单回调里 throw 会变成未处理拒绝。 */
function wrapRun(run: () => void | Promise<void>): () => void {
  return () => {
    void Promise.resolve()
      .then(run)
      .catch((e: unknown) => console.error("menu action", e));
  };
}

async function buildItems(
  specs: MenuSpec[],
  nextId: () => string,
): Promise<NativeItem[]> {
  const out: NativeItem[] = [];
  for (const spec of specs) {
    switch (spec.kind) {
      case "separator":
        out.push(await PredefinedMenuItem.new({ item: "Separator" }));
        break;
      case "item":
        out.push(
          await MenuItem.new({
            id: nextId(),
            text: spec.text,
            enabled: spec.enabled ?? true,
            action: wrapRun(spec.run),
          }),
        );
        break;
      case "check":
        out.push(
          await CheckMenuItem.new({
            id: nextId(),
            text: spec.text,
            enabled: spec.enabled ?? true,
            checked: spec.checked,
            action: wrapRun(spec.run),
          }),
        );
        break;
      case "submenu":
        out.push(
          await Submenu.new({
            id: nextId(),
            text: spec.text,
            enabled: spec.enabled ?? true,
            items: await buildItems(spec.items, nextId),
          }),
        );
        break;
    }
  }
  return out;
}

/**
 * 在光标处弹出原生菜单。空数组什么都不做（避免弹出空菜单）。
 * 分辨率失败只记控制台：右键菜单弹出失败不该影响页面其它交互。
 */
export async function popupMenu(items: MenuSpec[]): Promise<void> {
  if (items.length === 0) return;
  const mine = ++seq;
  let menu: Menu | null = null;
  try {
    let counter = 0;
    const nextId = (): string => {
      counter += 1;
      return `ctx:${mine}:${counter}`;
    };
    menu = await Menu.new({ items: await buildItems(items, nextId) });
  } catch (e: unknown) {
    console.error("menu build", e);
    return;
  }
  if (mine !== seq) {
    // 已有更新的弹出请求：放弃本菜单。
    void menu.close().catch(() => {});
    return;
  }
  const previous = live;
  live = menu;
  if (previous) void previous.close().catch(() => {});
  try {
    await menu.popup();
  } catch (e: unknown) {
    console.error("menu popup", e);
    if (live === menu) live = null;
    void menu.close().catch(() => {});
  }
}
