# 1.2.3 刮削验证记录

验证日期：2026-10-31。此次验证针对 `HEYZO-1048` 识别正确但刮削失败的问题。请求使用插件实际规则引擎、默认来源选择和普通 HTTP；没有导入用户 Cookie、开启年龄确认或调用下载器。没有真实媒体文件；文件名测试使用合成输入。

## 原因与修复

原默认 HEYZO 来源只有 JavBus、JavDB 和 HEYZO 官方，当前网络分别遇到年龄确认、地区限制和维护。AVSOX 旧规则仍读取 HTML，但站点已改为网页调用 JSON 接口。AirAV Wiki 和 Airav.io 为独立来源。

- AVSOX：取得页面 CSRF，使用同一宿主会话调用搜索和详情接口；核对业务状态和番号；解析演员、头像、日期、时长、厂商、系列、分类、封面及剧照。并发初始化共用一次正在进行的请求，随后重新读取令牌。
- 新增 FreeJavBT、7mmtv、Airav.io，保留来源开关。HEYZO 默认优先查询已验证的备用源；已有显式配置可用“启用 HEYZO 备用源”按钮补上前三者。
- JavBus：`existmag` 不是年龄确认 Cookie。改为仅在用户开启年龄确认后提交同站确认表单；出现重复验证或跨站表单时停止。此分支通过模拟响应测试，本轮没有将其计为联网成功。
- 缓存：指纹包含有效来源规则、开关、地址、访问配置、字段要求和合并策略；旧指纹自动失效。不长期缓存缺封面的结果，失败请求不占据本批去重记录，缓存不包含认证信息原文。
- 正常页面上的 Cloudflare 统计脚本不再触发渲染。真正的 HTTP 200 防护页仍明确报错。JSON-LD 支持多个脚本和 `@graph` 中的影片节点。
- 新增 `HEYZO.2000`、点号/空格/括号/目录回退的专项识别回归。

## 真实站点

| 番号 | 来源 | 番号/标题/封面 | 演员 | 日期 |
| --- | --- | --- | --- | --- |
| HEYZO-1048 | AVSOX | 通过 | 1 | 2016-01-02 |
| HEYZO-1048 | FreeJavBT | 通过 | 1 | 2016-01-02 |
| HEYZO-1048 | 7mmtv | 通过 | 1 | 2016-01-02 |
| HEYZO-2000 | AVSOX | 通过 | 1 | 2019-05-26 |
| HEYZO-2000 | FreeJavBT | 通过 | 1 | 2019-05-26 |
| HEYZO-2000 | 7mmtv | 通过 | 1 | 2019-05-26 |

HEYZO-1048 的演员为波多野結衣，AVSOX 返回时长 60 分钟。7mmtv 返回 01:01:24，规整为 61 分钟，保留来源差异。FreeJavBT 一次连续快速请求未返回可核验编号；按插件默认同站间隔 1.5 秒复测通过，没有用标题或请求参数伪造番号。

Airav.io 当前返回 Cloudflare 防护页：规则使用公开页面结构构造样例测试通过，但未通过本轮联网刮削，状态如实标为“防护验证”。JavDB 和 HEYZO 官方的外部访问限制仍存在，由已启用的备用源继续查询。

## 整条流程与图片

默认快速模式下，以下五组输入均经过实际 `identify → scrape → mergeMeta → buildNFO`，没有使用预填元数据：

- `heyzo-1048.mp4`
- `[site.test]heyzo_1048_乱名[2160P][中字]-CD2.mkv`
- `HEYZO.2000-1080p.mp4`
- `www.example.com@SSIS-001_4K-UC.mp4`
- `FC2-PPV-1292936 [1080P].mkv`

全部正确识别、取得标题和封面并生成包含番号的 NFO。HEYZO 三组均命中三个来源并取得演员头像；普通番号使用 R18.dev，FC2 使用 FC2 官方。每组约 1.3–4.5 秒，为本机网络耗时，不是性能保证。

以下 HEYZO-1048 图片已实际下载，用与宿主一致的 Go 图片解码器展开全部像素，不仅检查 URL 或文件头：

| 来源与图片 | HTTP | 格式 | 尺寸 | 字节数 |
| --- | --- | --- | --- | --- |
| AVSOX 封面 | 200 | JPEG | 800×450 | 104590 |
| AVSOX 演员头像 | 200 | WebP | 250×250 | 5912 |
| FreeJavBT 封面 | 200 | JPEG | 434×268 | 24303 |
| 7mmtv 封面 | 200 | JPEG | 800×450 | 86115 |

图片仅用于临时解码验证，不随插件分发。没有验证实际视频搬移、FFP、服务器安装或所有网络出口的可用性。

## 回归与复测

288 项自动测试通过，0 失败、0 跳过；3,039 条合成文件名逐项核对通过；页面冒烟测试通过。新增测试覆盖 CSRF 并发、精确番号匹配、API 错误、手工详情、备用源、年龄确认、正常统计脚本、JSON-LD、缓存变化及 Cookie 优先级。复用宿主 API 3.5，无新增运行时依赖。

```sh
JSDOM_DIR=/path/to/node_modules node --test test/*.test.mjs
JSDOM_DIR=/path/to/node_modules node test/ui-smoke.mjs
node test/filename-audit.mjs /tmp/filename-report.json
JSDOM_DIR=/path/to/node_modules LIVE_NUMBERS=HEYZO-1048,HEYZO-2000 node test/live-sources.mjs avsox freejavbt mmtv
JSDOM_DIR=/path/to/node_modules LIVE_REPORT=/tmp/scrape-report.json node test/live-scrape.mjs
```

联网测试依赖开发环境的 `jsdom` / `tough-cookie`；插件生产运行直接使用宿主 HTTP、Cookie 和 HTML，无需安装这些 Node 包。
