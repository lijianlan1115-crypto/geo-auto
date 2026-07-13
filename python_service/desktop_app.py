import json
import os
from pathlib import Path
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox
import urllib.request
import webbrowser


APP_NAME = "GEO反馈自动化"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def application_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def project_dir():
    if getattr(sys, "frozen", False):
        return application_dir().parent
    return application_dir().parent.parent


def settings_path():
    if os.name == "nt" and os.getenv("APPDATA"):
        base_dir = Path(os.environ["APPDATA"]) / APP_NAME
    else:
        base_dir = application_dir() / ".desktop"
    return base_dir / "settings.json"


def load_desktop_settings():
    path = settings_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_desktop_settings(data):
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def configure_windowed_logging():
    if sys.stdout is not None and sys.stderr is not None:
        return
    log_dir = project_dir() / "output"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = open(log_dir / "service.log", "a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = log_file
    if sys.stderr is None:
        sys.stderr = log_file


configure_windowed_logging()

DESKTOP_SETTINGS = load_desktop_settings()
if DESKTOP_SETTINGS.get("input_excel"):
    os.environ["GEO_INPUT_EXCEL"] = str(DESKTOP_SETTINGS["input_excel"])

import config as service_config  # noqa: E402
import server as service_server  # noqa: E402

HOST = service_config.HOST
OUTPUT_DIR = service_config.OUTPUT_DIR
PORT = service_config.PORT


class DesktopApp:
    def __init__(self, root):
        self.root = root
        self.http_server = None
        self.server_thread = None
        self.stopping = False
        self.input_excel = Path(service_config.INPUT_EXCEL)
        self.status_var = tk.StringVar(value="正在检查输入表格...")
        self.detail_var = tk.StringVar(value=f"服务地址：http://{HOST}:{PORT}")
        self.input_path_var = tk.StringVar()
        self.autostart_var = tk.BooleanVar(value=self.autostart_enabled())

        root.title(APP_NAME)
        root.geometry("560x440")
        root.minsize(540, 420)
        root.configure(bg="#f4f6f8")
        root.protocol("WM_DELETE_WINDOW", self.on_close)

        self.build_ui()
        self.refresh_input_path()
        root.after(220, self.initialize_service)
        root.after(1500, self.refresh_health)

    def build_ui(self):
        header = tk.Frame(self.root, bg="#17324d", padx=24, pady=20)
        header.pack(fill="x")
        tk.Label(
            header,
            text=APP_NAME,
            bg="#17324d",
            fg="white",
            font=("Microsoft YaHei UI", 18, "bold"),
        ).pack(anchor="w")
        tk.Label(
            header,
            text="本地服务与 Chrome 插件运行助手",
            bg="#17324d",
            fg="#c8d7e5",
            font=("Microsoft YaHei UI", 10),
        ).pack(anchor="w", pady=(4, 0))

        body = tk.Frame(self.root, bg="#f4f6f8", padx=24, pady=20)
        body.pack(fill="both", expand=True)

        status_row = tk.Frame(body, bg="white", padx=16, pady=15, highlightthickness=1, highlightbackground="#dfe4ea")
        status_row.pack(fill="x")
        self.status_dot = tk.Canvas(status_row, width=14, height=14, bg="white", highlightthickness=0)
        self.status_dot.pack(side="left", padx=(0, 11))
        self.dot = self.status_dot.create_oval(2, 2, 12, 12, fill="#d97706", outline="")
        status_text = tk.Frame(status_row, bg="white")
        status_text.pack(side="left", fill="x", expand=True)
        tk.Label(status_text, textvariable=self.status_var, bg="white", fg="#182230", font=("Microsoft YaHei UI", 11, "bold")).pack(anchor="w")
        tk.Label(status_text, textvariable=self.detail_var, bg="white", fg="#667085", font=("Microsoft YaHei UI", 9)).pack(anchor="w", pady=(3, 0))

        input_row = tk.Frame(body, bg="white", padx=16, pady=13, highlightthickness=1, highlightbackground="#dfe4ea")
        input_row.pack(fill="x", pady=(12, 0))
        input_text = tk.Frame(input_row, bg="white")
        input_text.pack(side="left", fill="x", expand=True, padx=(0, 12))
        tk.Label(input_text, text="输入 Excel", bg="white", fg="#182230", font=("Microsoft YaHei UI", 10, "bold")).pack(anchor="w")
        tk.Label(
            input_text,
            textvariable=self.input_path_var,
            bg="white",
            fg="#667085",
            anchor="w",
            justify="left",
            wraplength=370,
            font=("Microsoft YaHei UI", 9),
        ).pack(anchor="w", pady=(3, 0))
        self.add_button(input_row, "选择表格", self.choose_input_excel, "#e8eef5", "#17324d").pack(side="right")

        actions = tk.Frame(body, bg="#f4f6f8")
        actions.pack(fill="x", pady=(16, 8))
        self.add_button(actions, "重启服务", self.restart_service, "#2563eb", "white").pack(side="left", fill="x", expand=True, padx=(0, 6))
        self.add_button(actions, "打开输入表格", self.open_input_excel, "#e8eef5", "#17324d").pack(side="left", fill="x", expand=True, padx=6)
        self.add_button(actions, "打开输出目录", self.open_output_dir, "#e8eef5", "#17324d").pack(side="left", fill="x", expand=True, padx=(6, 0))

        options = tk.Frame(body, bg="#f4f6f8")
        options.pack(fill="x", pady=(12, 0))
        tk.Checkbutton(
            options,
            text="登录 Windows 后自动启动",
            variable=self.autostart_var,
            command=self.toggle_autostart,
            bg="#f4f6f8",
            activebackground="#f4f6f8",
            fg="#344054",
            selectcolor="white",
            font=("Microsoft YaHei UI", 10),
        ).pack(side="left")
        self.add_button(options, "Chrome 扩展管理", self.open_extensions, "#f4f6f8", "#2563eb", border=True).pack(side="right")

        tk.Label(
            body,
            text="保持此程序运行即可使用插件。关闭窗口将同时停止本地服务。",
            bg="#f4f6f8",
            fg="#667085",
            font=("Microsoft YaHei UI", 9),
        ).pack(anchor="w", pady=(18, 0))

    def add_button(self, parent, text, command, bg, fg, border=False):
        return tk.Button(
            parent,
            text=text,
            command=command,
            bg=bg,
            fg=fg,
            activebackground=bg,
            activeforeground=fg,
            relief="solid" if border else "flat",
            bd=1 if border else 0,
            highlightthickness=0,
            padx=12,
            pady=9,
            cursor="hand2",
            font=("Microsoft YaHei UI", 9, "bold"),
        )

    def set_status(self, state, title, detail):
        colors = {"ok": "#16a34a", "warn": "#d97706", "error": "#dc2626"}
        self.status_dot.itemconfigure(self.dot, fill=colors.get(state, "#98a2b3"))
        self.status_var.set(title)
        self.detail_var.set(detail)

    def refresh_input_path(self):
        if self.input_excel.exists():
            self.input_path_var.set(str(self.input_excel))
        else:
            self.input_path_var.set("尚未选择，或原文件已被移动")

    def service_detail(self):
        return f"输入表格：{self.input_excel.name}，现在可以在 Chrome 插件中开始运行"

    def initialize_service(self):
        if self.input_excel.exists():
            self.start_service()
            return
        self.set_status("warn", "请选择输入 Excel", "表格可以放在电脑上的任意位置")
        self.choose_input_excel()

    def start_service(self):
        if self.server_thread and self.server_thread.is_alive():
            return
        if not self.input_excel.exists():
            self.set_status("warn", "请选择输入 Excel", "找不到已配置的表格，请重新选择")
            return
        self.stopping = False
        self.set_status("warn", "正在启动本地服务...", f"服务地址：http://{HOST}:{PORT}")

        def run():
            try:
                self.http_server = service_server.create_service_server()
                self.root.after(0, lambda: self.set_status("ok", "服务运行中", self.service_detail()))
                self.http_server.serve_forever()
            except OSError as exc:
                message = "端口已被占用，可能已有服务正在运行" if getattr(exc, "errno", None) in {48, 98, 10048} else str(exc)
                self.root.after(0, lambda value=message: self.set_status("error", "服务启动失败", value))
            except Exception as exc:
                self.root.after(0, lambda value=str(exc): self.set_status("error", "服务启动失败", value))
            finally:
                if self.http_server:
                    self.http_server.server_close()
                self.http_server = None
                if not self.stopping:
                    self.root.after(0, lambda: self.set_status("error", "服务已停止", "点击“重启服务”可重新启动"))

        self.server_thread = threading.Thread(target=run, name="geo-local-service", daemon=True)
        self.server_thread.start()

    def stop_service(self, callback=None):
        self.stopping = True
        server = self.http_server
        if not server:
            if callback:
                callback()
            return

        def stop():
            server.shutdown()
            server.server_close()
            self.http_server = None
            if callback:
                self.root.after(0, callback)

        threading.Thread(target=stop, name="geo-service-stop", daemon=True).start()

    def restart_service(self):
        if not self.input_excel.exists():
            self.choose_input_excel()
            return
        self.set_status("warn", "正在重启本地服务...", "请稍候")
        self.stop_service(lambda: self.root.after(250, self.start_service))

    def refresh_health(self):
        if self.stopping:
            self.root.after(3000, self.refresh_health)
            return
        if not self.input_excel.exists():
            self.set_status("warn", "请选择输入 Excel", "找不到已配置的表格，请重新选择")
            self.root.after(3000, self.refresh_health)
            return
        try:
            with urllib.request.urlopen(f"http://{HOST}:{PORT}/health", timeout=0.8) as response:
                if response.status == 200:
                    self.set_status("ok", "服务运行中", self.service_detail())
        except Exception:
            if self.server_thread and self.server_thread.is_alive():
                self.set_status("warn", "服务正在准备...", f"服务地址：http://{HOST}:{PORT}")
        self.root.after(3000, self.refresh_health)

    def open_path(self, path):
        path = Path(path)
        if not path.exists():
            messagebox.showwarning(APP_NAME, f"文件或目录不存在：\n{path}")
            return
        if os.name == "nt":
            os.startfile(str(path))
        else:
            webbrowser.open(path.as_uri())

    def open_input_excel(self):
        self.open_path(self.input_excel)

    def validate_input_excel(self, path):
        from openpyxl import load_workbook

        workbook = load_workbook(path, read_only=True, data_only=True)
        try:
            worksheet = workbook.active
            headers = {
                str(cell.value).strip()
                for cell in worksheet[1]
                if cell.value is not None and str(cell.value).strip()
            }
        finally:
            workbook.close()
        if not any(name in headers for name in service_config.QUESTION_HEADERS):
            supported = "、".join(service_config.QUESTION_HEADERS)
            raise ValueError(f"Excel 第一行缺少问题列，支持的列名：{supported}")

    def choose_input_excel(self):
        initial_dir = self.input_excel.parent if self.input_excel.parent.exists() else Path.home()
        selected = filedialog.askopenfilename(
            title="选择 GEO 输入表格",
            initialdir=str(initial_dir),
            filetypes=[("Excel 工作簿", "*.xlsx"), ("所有文件", "*.*")],
        )
        if not selected:
            if not self.input_excel.exists():
                self.set_status("warn", "尚未选择输入 Excel", "点击“选择表格”后再启动服务")
            return

        new_path = Path(selected).resolve()
        try:
            self.validate_input_excel(new_path)
        except Exception as exc:
            messagebox.showerror(APP_NAME, f"无法使用这个表格：\n{exc}")
            return

        self.set_status("warn", "正在切换输入表格...", new_path.name)

        def apply_selection():
            try:
                result = service_server.configure_input_excel(new_path)
                service_config.INPUT_EXCEL = new_path
                self.input_excel = new_path
                save_desktop_settings({"input_excel": str(new_path)})
                self.refresh_input_path()
                if result.get("resumed_existing_progress"):
                    stats = result.get("stats") or {}
                    self.detail_var.set(f"已识别已有进度：完成 {int(stats.get('done', 0))}，待继续 {int(stats.get('pending', 0))}")
                elif result.get("archived_result"):
                    self.detail_var.set("旧结果已归档，正在读取新表格")
                self.root.after(250, self.start_service)
            except Exception as exc:
                self.set_status("error", "切换表格失败", str(exc))
                messagebox.showerror(APP_NAME, f"切换输入表格失败：\n{exc}")

        self.stop_service(apply_selection)

    def open_output_dir(self):
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        self.open_path(OUTPUT_DIR)

    def open_extensions(self):
        webbrowser.open("chrome://extensions/")

    def autostart_enabled(self):
        if os.name != "nt" or not getattr(sys, "frozen", False):
            return False
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
                winreg.QueryValueEx(key, APP_NAME)
            return True
        except OSError:
            return False

    def toggle_autostart(self):
        if os.name != "nt" or not getattr(sys, "frozen", False):
            self.autostart_var.set(False)
            messagebox.showinfo(APP_NAME, "开机自动启动只在打包后的 Windows 程序中生效。")
            return
        import winreg
        try:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
                if self.autostart_var.get():
                    winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, f'"{sys.executable}"')
                else:
                    try:
                        winreg.DeleteValue(key, APP_NAME)
                    except FileNotFoundError:
                        pass
        except OSError as exc:
            self.autostart_var.set(self.autostart_enabled())
            messagebox.showerror(APP_NAME, f"设置开机启动失败：{exc}")

    def on_close(self):
        if not messagebox.askokcancel(APP_NAME, "关闭后本地服务将停止，确定退出吗？"):
            return
        self.stopping = True
        if self.http_server:
            self.stop_service(self.root.destroy)
        else:
            self.root.destroy()


def main():
    root = tk.Tk()
    DesktopApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
