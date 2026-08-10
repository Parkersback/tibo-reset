# Tibo Reset

`Tibo Reset` 是一个非官方的 ChatGPT/Codex 额度重置预测仪表盘。它把第三方项目公开的 JSON 镜像到本地静态站点，以中英双语界面展示 5h / 24h / 48h 概率、信号与历史。

> 本站关注的是可能发生的**额外全局 hard reset**。常规的 `weekly reset`、`banked reset` 与 `boost/unlock` 是不同机制，不能当作同一种事件解读。

本站不自研概率模型，不使用 OpenAI API，也不使用 X API；页面展示的是上游公开预测与指标的镜像，并非实时读取 X。

## 当前状态与截图

功能代码和本地启动器已经包含在仓库中。截图尚未生成，待 Task 7 完成桌面端与移动端视觉验收后补充；这里不放置伪造的成品图或线上状态。

计划中的 GitHub Pages 地址是 <https://parkersback.github.io/tibo-reset/>。在 Task 7 实际创建仓库、部署并验证 HTTP 200 前，此地址只代表计划入口，不表示已经上线。

## 功能

- 展示 5h / 24h / 48h 三档预测、预计时间、倒计时与行动提示。
- 展示预测因素、当前信号、概率历史、模型表现与历史重置记录。
- 默认中文，可切换英文；语言偏好保存在当前浏览器。
- 支持复制/系统分享摘要，以及由用户主动授权的浏览器通知。
- 数据过期或同步失败时展示缓存与降级状态。
- 全部前端资源和数据使用相对路径，不依赖外部字体或 CDN，可在 localhost 与 GitHub Pages 仓库子路径运行。

## 本地运行

项目默认位于 `D:\桌面\Tibo-Reset`，需要可用的 Python 3.10+。

最简单的方法是在资源管理器中双击 `启动 Tibo Reset.cmd`。启动器会检查 `http://127.0.0.1:4178/health.json`：如果已有正确站点就复用；否则先同步数据，再启动本地静态服务器，通过健康检查后才打开浏览器。

CMD 启动器会把参数转交给 PowerShell 脚本：

```powershell
# 更换端口
.\启动 Tibo Reset.cmd -Port 4180

# 启动但不打开浏览器，适合自动检查
.\启动 Tibo Reset.cmd -NoBrowser

# 两个参数可以组合
.\启动 Tibo Reset.cmd -Port 4180 -NoBrowser
```

也可以直接运行启动脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-site.ps1 -Port 4178 -NoBrowser
```

需要分步操作时，先同步公开数据，再直接启动静态服务器：

```powershell
python scripts/sync_data.py --output-dir site/data --timeout 20
python -m http.server 4178 --bind 127.0.0.1 --directory site
```

随后访问 <http://127.0.0.1:4178/>。同步命令退出码非零时不要继续发布；这表示至少一个必需来源既未成功刷新，也没有通过结构校验的旧缓存。

## 数据同步架构

浏览器只读取 `site/data/` 中的本站镜像，不会让每位访问者直接请求参考站：

```text
公开 JSON -> scripts/sync_data.py -> 下载并校验 -> 临时文件 -> 原子替换 site/data/*.json
                                                     -> 写入 sync-status.json
site/app.js <- 相对路径 ./data/*.json <- 本地服务器或 GitHub Pages
```

五个确切的公开来源是：

1. [prediction.json](https://willtiboreset.xyz/data/prediction.json)
2. [prediction_history.json](https://willtiboreset.xyz/data/prediction_history.json)
3. [tweets.json](https://willtiboreset.xyz/data/tweets.json)
4. [model_performance.json](https://willtiboreset.xyz/data/model_performance.json)
5. [reset_history.json](https://raw.githubusercontent.com/EvanProgramming/willtiboreset/main/data/reset_history.json)

同步器逐个下载并校验 JSON 结构，只在新数据有效时原子替换旧镜像。单个来源暂时不可用时，会保留通过校验的上一份缓存，并在 `site/data/sync-status.json` 标记 `degraded` 降级和具体错误；它不会用空文件或坏数据覆盖缓存。若失败来源没有有效缓存，同步器返回失败，GitHub Actions 也会停止而不部署不完整数据。

这些端点属于上游公开数据来源，本仓库只做镜像、结构校验和展示。推文信号是上游已经公开的 JSON，不是本站调用实时 X API 获得的内容。

### 第三方内容与许可边界

完整权利与来源说明见根目录的 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；部署产物内同时包含纯文本版 [site/NOTICE.txt](site/NOTICE.txt)。第三方短摘录及数据的权利归原作者或权利人，本站不主张其权利，也不授予第三方内容许可。

参考数据的上游仓库目前无可核验的 LICENSE 文件，因此本项目不依赖上游代码许可，也未复制、修改或再分发上游代码或视觉资产。

## 浏览器通知限制

浏览器通知必须由用户点击按钮主动授权，并要求浏览器支持 Notification API，页面运行在 HTTPS 或 localhost。拒绝权限、浏览器/系统关闭通知、隐私模式限制等情况都会让通知不可用。

当前实现不是服务器推送、邮件提醒或后台服务：只有页面保持打开并成功载入新镜像时，才可能按阈值触发本机通知；关闭页面后不会在后台持续轮询。触发状态保存在该浏览器本地，清除站点数据或换设备不会同步状态。

## 测试

在项目根目录运行：

```powershell
python -m unittest discover -s tests -p "test_*.py"
python tests/check_static.py
node --check site/app.js
```

第一条运行同步器、启动器、前端控制器和发布合同等单元测试；第二条验证静态文件、JSON、页面区块和相对数据路径；第三条检查浏览器 JavaScript 语法。

## GitHub Pages 部署与维护

`.github/workflows/pages.yml` 使用 GitHub Pages 官方 Actions。在推送到 `main`、手动触发，以及每小时 UTC 的 7、27、47 分运行；这相当于约每 20 分钟一次并避开整点。GitHub 计划任务可能排队或延迟，并不是实时调度保证。

工作流使用 Python 3.13，先执行同步命令，再读取 `site/data/sync-status.json`。只有 `overall_status` 严格等于 `ok` 才继续；即使同步器因存在旧缓存而返回成功，`degraded` 或 cached 降级也会让 job 非零退出，保留上一版 Pages，不允许仓库旧缓存覆盖更新的线上版本。fresh gate 通过后仍需完成单元测试、静态合同和 Node 语法检查，最后才上传 `./site`。工作流不提交数据、不执行 `git push`、不需要仓库 secrets，也不访问 X API。

首次公开发布需要在仓库 Pages 设置中选择 **GitHub Actions** 作为来源，实际建仓与线上验证属于 Task 7。GitHub 可能在仓库长期无活动后自动停用计划工作流；维护者应检查 Actions 状态，并可用 `workflow_dispatch` 手动刷新与部署。

## 免责声明与归属

本项目非官方，与 OpenAI、Thibault Sottiaux 及参考站 `willtiboreset.xyz` 无隶属或背书关系。预测仅供娱乐和信息参考，不构成服务可用性承诺、购买建议或操作保证。数据、文本和模型表现来自第三方公开项目；上游模型指标未独立验证，历史表现也不能保证未来事件。
