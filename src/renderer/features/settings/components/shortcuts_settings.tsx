import { shortcutLabel, shortcuts, zoomShortcuts } from "../../../app/logic/shortcuts.ts";

export function ShortcutsSettings() {
  return (
    <section className="settings-section shortcut-list" aria-label="常用快捷键">
      {[...shortcuts, ...zoomShortcuts].map((shortcut) => (
        <div className="shortcut-row" key={shortcut.id}>
          <span>{shortcut.label}</span>
          <kbd>{shortcutLabel(shortcut.id)}</kbd>
        </div>
      ))}
      <div className="shortcut-row">
        <span>发送消息 / 换行</span>
        <kbd>Enter / Shift Enter</kbd>
      </div>
      <div className="shortcut-row">
        <span>关闭菜单或弹窗</span>
        <kbd>Esc</kbd>
      </div>
      <p className="small muted">
        快捷键仅在当前应用窗口内生效。输入法组词或弹窗打开时，不触发工作台切换。
        字体缩放使用原生内容缩放，控件同步调整，范围 60%–120%；输入框和弹窗中也可使用。
      </p>
    </section>
  );
}
