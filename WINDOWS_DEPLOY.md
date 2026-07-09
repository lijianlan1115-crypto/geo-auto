# GEO 自动化插件 Windows 部署说明

## 目录结构

推荐把整个项目文件夹放到一个没有中文空格问题的位置，例如：

```text
D:\geo-auto
```

正式运行时，至少需要这些内容：

```text
geo-auto
├─ input.xlsx
├─ start_windows.bat
├─ python_service
│  ├─ server.py
│  ├─ config.py
│  ├─ requirements.txt
│  └─ 启动服务_windows.bat
└─ chrome_extension
   ├─ background.js
   ├─ content_script.js
   ├─ content_script_geo_patch.js
   └─ content_script_platform_patch.js
```

输出会自动保存到：

```text
geo-auto\output\result.xlsx
geo-auto\output\ai返回内容临时表.xlsx
geo-auto\output\progress.sqlite
geo-auto\output\screenshots
```

## 方式一：普通 Windows 运行

适合自己电脑或已允许安装环境的电脑。

1. 把 `input.xlsx` 放到项目根目录。
2. 双击：

```text
start_windows.bat
```

脚本会自动做这些事：

```text
检查 Python
没有 Python 时尝试用 winget 安装 Python 3.11
创建 .venv 虚拟环境
安装 requirements.txt
启动 http://127.0.0.1:8765
```

启动成功后，命令窗口不要关闭。

## 方式二：打包成 exe，给没有 Python 的电脑用

先在一台有 Python 的 Windows 电脑上运行：

```text
build_windows_exe.bat
```

生成目录：

```text
dist\geo-python-service
```

把整个 `geo-python-service` 文件夹压缩发给别人。对方使用时：

1. 解压 `geo-python-service`。
2. 把 `input.xlsx` 放进这个文件夹。
3. 双击：

```text
start_windows_exe.bat
```

这种方式目标电脑不需要安装 Python。

## Chrome 插件加载

1. 打开 Chrome。
2. 地址栏输入：

```text
chrome://extensions
```

3. 打开右上角“开发者模式”。
4. 点“加载已解压的扩展程序”。
5. 选择：

```text
geo-auto\chrome_extension
```

如果使用 exe 打包目录，则选择：

```text
geo-python-service\chrome_extension
```

## 正式运行顺序

```text
1. 启动 Python 服务
2. Chrome 加载插件
3. 插件里检查服务
4. 使用真实AI平台
5. 打开登录页，把豆包/千问/DeepSeek/元宝/文心都登录好
6. 保存配置
7. 重置所有任务
8. 开始
```

## 常见问题

### 1. 打开后提示连接不上 Python 服务

先确认命令窗口里有：

```text
服务地址：http://127.0.0.1:8765
```

如果没有，重新双击 `start_windows.bat` 或 `start_windows_exe.bat`。

### 2. 端口 8765 被占用

在 Windows 终端运行：

```bat
netstat -ano | findstr :8765
```

找到 PID 后：

```bat
taskkill /PID 进程ID /F
```

### 3. 元宝/千问每次都要求登录

登录状态不是 URL 保存的，是 Chrome Cookie 保存的。

需要在同一个 Chrome 里先登录成功，再开始任务。平台 URL 建议使用正常聊天页，例如：

```text
https://yuanbao.tencent.com/chat/
https://tongyi.aliyun.com/qianwen/
```

不要使用扫码登录页、回调链接、临时跳转链接。

### 4. OCR 报错

OCR 是备用能力。Windows 没安装 Tesseract 时，OCR 兜底可能不可用，但主要 DOM 定位、滚动截图、图片二次拉框仍然可以运行。

### 5. 结果保存在哪里

```text
output\result.xlsx
output\ai返回内容临时表.xlsx
```

`result.xlsx` 是最终表，`ai返回内容临时表.xlsx` 是中间过程表。
