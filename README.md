# ChatGPT 会不会重置？

`ChatGPT 会不会重置？` 是一个非官方的 ChatGPT/Codex 额度重置预测站。它把第三方项目公开的 JSON 镜像到本地静态站点，以中英双语界面展示 5h / 24h / 48h 概率、信号与历史；主视觉采用原创的“鎏金科技塔罗 × 重置神谕”设计。

> 本站关注的是可能发生的**额外全局 hard reset**。常规的 `weekly reset`、`banked reset` 与 `boost/unlock` 是不同机制，不能当作同一种事件解读。

本站不自研概率模型，不使用 OpenAI API，也不使用 X API；页面展示的是上游公开预测与指标的镜像，并非实时读取 X。Cloudflare 边缘同步启用后会缩短镜像延迟，但仍不承诺秒级实时。

## 当前状态与截图

功能代码、本地启动器与 GitHub Pages 部署均已完成。Playwright 桌面端与移动端截图已生成在本机 `output/playwright/`（该 QA 目录不进入发布包）；融合 Tibo 面部参考的原创主视觉随站点发布在 `site/assets/reset-oracle-card-tibo.webp`。

线上地址是 <https://parkersback.github.io/tibo-reset/>；每次发布仍需以 GitHub Actions 成功和线上 HTTP 200 验证为准。

Cloudflare Worker 已发布到 <https://tibo-reset-data-mirror.tibo-reset-data-worker.workers.dev/>；运行配置完成观测后使用 `primary`，任何超时、错误、坏结构或过期快照都会整份回退 Pages 镜像。紧急回滚只需把 `edgeMode` 改为 `off`。

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

网站采用两层同步：Cloudflare Worker + Workers KV 是低延迟主链路，`site/data/` 中的 GitHub Pages 镜像是独立兜底。浏览器和 Worker 都不会调用 X API，也不会把每位访问者直接转发到参考站。

```text
                         -> Cloudflare Worker 每 5 分钟校验 -> Durable Object 串行刷新
                                                           -> 单个 Workers KV 原子快照
5 个公开 JSON 来源 ----|                                      -> /v1/bundle.json
                         -> GitHub Actions 约每 20 分钟校验 -> site/data/*.json

浏览器 -> edge primary 快照
       -> Worker 超时、错误、结构无效或过期时，整份回退 Pages 兜底
```

五个确切的公开来源是：

1. [prediction.json](https://willtiboreset.xyz/data/prediction.json)
2. [prediction_history.json](https://willtiboreset.xyz/data/prediction_history.json)
3. [tweets.json](https://willtiboreset.xyz/data/tweets.json)
4. [model_performance.json](https://willtiboreset.xyz/data/model_performance.json)
5. [reset_history.json](https://raw.githubusercontent.com/EvanProgramming/willtiboreset/main/data/reset_history.json)

两条同步链路执行相同的关键安全边界：固定 HTTPS 来源、响应大小限制、JSON 结构/概率/时间校验，以及推文最小字段、账号路径和可信来源组合。Worker 用单例 Durable Object 串行化刷新，避免并发任务把旧结果写回；五类数据通过后写进同一个版本化 KV bundle。某个来源失败时只会短期沿用该来源上一份已验证数据并标记 `degraded`，过期缓存、坏数据和超过 KV 限额的快照都不会覆盖好版本。Pages 同步器逐个下载并校验，只在新数据有效时原子替换旧镜像；若失败来源没有有效缓存，GitHub Actions 会停止发布不完整数据。

前端运行配置在 `site/edge-config.json`，有三种 `edgeMode`：

- `off`：完全读取 Pages；用于紧急回滚，空地址绝不产生边缘请求。
- `shadow`：同时验证 Worker 和 Pages，但页面仍展示 Pages，用于切换前观测。
- `primary`：优先读取 Worker 的单个原子快照，任何异常都整份回退 Pages 兜底，不把两边的数据混在一起。

每 5 分钟 Cron 是同步目标，不是精确时钟；Cloudflare 调度、KV 跨区域传播、上游更新时间和浏览器轮询都会增加延迟。因此页面显示实际更新时间，本站不承诺秒级实时，也不能保证每次都在固定分钟更新。

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
Set-Location worker
npm ci
npm test
npm run check
```

Python 测试覆盖同步器、启动器、前端控制器和发布合同；静态合同验证发布文件、JSON 与页面区块；Node 命令检查浏览器代码和 Worker 的验证、降级、CORS、KV 快照行为。

## GitHub Pages 部署与维护

`.github/workflows/pages.yml` 使用 GitHub Pages 官方 Actions。在推送到 `main`、手动触发，以及每小时 UTC 的 7、27、47 分运行；这相当于约每 20 分钟一次并避开整点。GitHub 计划任务可能排队或延迟，并不是实时调度保证。

工作流使用 Python 3.13，先执行同步命令，再读取 `site/data/sync-status.json`。只有 `overall_status` 严格等于 `ok` 才继续；即使同步器因存在旧缓存而返回成功，`degraded` 或 cached 降级也会让 job 非零退出，保留上一版 Pages，不允许仓库旧缓存覆盖更新的线上版本。fresh gate 通过后仍需完成单元测试、静态合同和 Node 语法检查，最后才上传 `./site`。工作流不提交数据、不执行 `git push`、不需要仓库 secrets，也不访问 X API。

仓库 Pages 来源已使用 **GitHub Actions**。GitHub 可能在仓库长期无活动后自动停用计划工作流；维护者应检查 Actions 状态，并可用 `workflow_dispatch` 手动刷新与部署。

## Cloudflare Worker 启用与维护

Worker 代码和锁定依赖位于 `worker/`。当前生产 Worker、KV namespace 与 5 分钟 Cron 已创建；KV namespace ID 只是公开资源标识，不是密钥。仓库不包含 OAuth Token 或 API Token。本机维护时先完成身份验证：

```powershell
Set-Location 'D:\桌面\Tibo-Reset\worker'
npm ci
npx wrangler login --use-keyring
npx wrangler whoami
```

随后执行：

```powershell
npm test
npm run check
npm run deploy
```

只有重新创建 Cloudflare 资源时才运行 `npx wrangler kv namespace create DATA_MIRROR`，并把新的真实 namespace ID 写入 `worker/wrangler.jsonc`。Worker 地址发生变化时，依次执行无中断切换：

1. 把 `site/edge-config.json` 的地址填为 Worker `/v1/bundle.json`，`edgeMode` 先设为 `shadow`。
2. 从正式 Pages Origin 连续检查 `/health`、CORS、五类数据和更新时间；同时模拟 Worker 404/超时，确认页面稳定回到 Pages。
3. 验收通过后改为 `primary`；出现问题时把 `edgeMode` 改回 `off` 即可回滚，不需要停站。

自动部署工作流是 `.github/workflows/worker.yml`。在 GitHub 仓库中安全设置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 两个 Actions secrets，并将仓库变量 `CLOUDFLARE_WORKER_ENABLED` 设为 `true` 后，Worker 目录的后续 `main` 更新才会触发部署。Token 应限定到目标 Cloudflare 账户和最小 Worker/KV 权限；不要写入配置、日志或提交历史。

## 免责声明与归属

本项目非官方，与 OpenAI、Thibault Sottiaux 及参考站 `willtiboreset.xyz` 无隶属或背书关系。预测仅供娱乐和信息参考，不构成服务可用性承诺、购买建议或操作保证。数据、文本和模型表现来自第三方公开项目；上游模型指标未独立验证，历史表现也不能保证未来事件。
