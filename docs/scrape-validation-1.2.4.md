# 1.2.4 全来源联网验证

验证日期：2026-10-31。本机网络，调用插件实际规则引擎，覆盖全部 26 个预设、45 组来源与番号组合。用户明确授权年龄确认后测试 JavBus、FANZA、MGStage；没有代答人工验证题，没有导入用户浏览器 Cookie 或 ThePornDB 令牌。

结果：17 个来源取得至少一组番号、标题、发行日期和封面；27 组元数据成功。27 张封面均 HTTP 200，并用 Go 图片解码器完整展开像素；新增验证的 3 张 FANZA 演员头像也全部通过。其余 9 个来源受访问条件限制，不能称为已修好或联网通过。各项计数和逐样本证据见 [JSON 报告](scrape-validation-1.2.4.json)。

## 修复内容

- FANZA：旧 DMM 详情地址跳转到新版站点，返回的 HTML 只是应用外壳。改用当前网页实际调用的公开 GraphQL 元数据接口。精确番号转换成内容编号搜索；搜索结果的厂商前缀不能当作作品番号，必须继续核对详情的 `makerContentId`。普通关键词保持原文。支持演员、头像、厂商、品牌、系列、导演、分类、简介、封面、剧照及手工详情链接。
- FANZA 日期：UTC 的 `2021-02-18T15:00:00Z` 按日本时区取 `2021-02-19`。秒数转分钟；封面取接口真实返回的地址。迁移旧官方地址配置，保留自定义代理地址；未开启年龄确认时不发起请求。API 错误、空详情、错号分别处理。
- 时长：加勒比 `00:59:29` 不再被读成 0 分钟；加勒比 Premium、Tokyo-Hot 的 `01:…` 不再被读成 1 分钟。统一支持时分秒、分钟、小时和 ISO duration，拒绝非法时钟。
- FreeJavBT：排除站点单独标记的男演员，保留女优列表；SSIS-001 返回两位女优，与 R18.dev、FANZA、Jav321 对照一致。
- JavBus：年龄确认后仍出现人工答题，立即明确提示并停止，不循环提交确认表单。ThePornDB 缺少令牌时直接说明原因。
- 来源页面：更新核对日期、真实状态和适用的测试番号。Pacopacomama 改用当前目录中的两个实际番号，两组均通过；原来用通用日期番号找不到，不能据此判断接口失效。

## 26 个来源的结果

“通过”表示下列样本取得元数据且封面完整解码，不能推定所有作品都收录或所有网络出口都能访问。

| 来源 | 本轮样本 | 结果 |
| --- | --- | --- |
| R18.dev | SSIS-001、IPX-177 | 2 组通过 |
| FANZA | SSIS-001、IPX-177、SDABP-001 | 3 组通过；含 `1sdabp00001` 厂商前缀 |
| MGStage | 259LUXU-1000、300MIUM-123 | 年龄确认后 2 组通过 |
| Jav321 | SSIS-001、IPX-177 | 2 组通过 |
| AVSOX | HEYZO-1048、010120-001 | 2 组通过 |
| FreeJavBT | SSIS-001、HEYZO-1048 | 2 组通过 |
| 7mmtv | SSIS-001、HEYZO-1048 | 2 组通过 |
| XCITY | FE620AI | 通过 |
| FC2 官方 | FC2-PPV-1292936、FC2-PPV-3061625 | 前者通过；后者未找到 |
| Caribbeancom | 010120-001 | 通过，59 分钟 |
| Caribbeancom Premium | 010120_001 | 通过，71 分钟 |
| 一本道 | 123120_001 | 通过，62 分钟 |
| 天然むすめ | 010120_01 | 通过，60 分钟 |
| Pacopacomama | 103126_100、102926_100 | 2 组通过，73 / 54 分钟 |
| Tokyo-Hot | N1234 | 通过，64 分钟 |
| JAV Database | SSIS-001、ABP-001 | 2 组通过；前者未取得时长 |
| AV-Wiki | 259LUXU-1000、300MIUM-123 | 前者通过；后者未找到 |
| JavBus | SSIS-001、HEYZO-1048 | 年龄确认后仍要求人工答题，未通过 |
| JavDB | SSIS-001、HEYZO-1048 | 当前网络地区受限 |
| JavLibrary | SSIS-001、ABP-001 | Cloudflare 验证 |
| AirAV | SSIS-001、IPX-177 | Cloudflare 验证 |
| Airav.io | SSIS-001、HEYZO-1048 | Cloudflare 验证 |
| AVBASE | SSIS-001、300MIUM-1461 | Cloudflare 验证 |
| HEYZO 官方 | HEYZO-1048、HEYZO-2000 | HTTP 403，维护页面 |
| FC2PPVDB | FC2-PPV-1292936 | HTTP 526 |
| ThePornDB | SSIS-001 | 未配置令牌；先前匿名探测另遇 Cloudflare，未验证认证接口 |

保留来源差异：SSIS-001 的时长在 FreeJavBT 为 150 分钟，R18.dev / FANZA / Jav321 为 147 分钟；7mmtv、JAV Database 的日期为 2021-02-18，FANZA 为日本日期 2021-02-19。没有用其他站点的数据覆盖单来源测试结果。FC2、AV-Wiki 这些样本未取得时长，不填造数值。

## 图片与回归

新增 FANZA 图片验证包括 2184×1468、800×538、800×537 的 JPEG 封面，以及 3 张 125×125 的演员头像。原始网页、图片、浏览器状态仅留在临时验证目录，不随插件分发。JSON 报告只保存中性测试编号、字段完整性、日期、时长、公开来源地址与解码结果。

- 自动测试：297 项通过，0 失败、0 跳过；覆盖新版接口、厂商前缀、错号与空响应、API 错误、时区边界、手工链接、年龄开关、人工验证和旧地址迁移。
- 合成文件名：3,039 条全部通过。
- 页面冒烟与插件平台检查：通过。
- 插件继续使用宿主 API 3.5，没有新增运行时依赖或常驻服务。

本轮没有真实媒体文件，没有执行视频搬移、FFP、Emby 写入或 115 / PT / 下载器提交，也没有安装到运行中的服务器。联网结果仅代表当前验证环境。

## 复测

```sh
JSDOM_DIR=/path/to/node_modules node --test test/*.test.mjs
JSDOM_DIR=/path/to/node_modules node test/ui-smoke.mjs
node test/filename-audit.mjs /tmp/filename-report.json
JSDOM_DIR=/path/to/node_modules LIVE_AUDIT_DIR=/tmp/source-audit node test/live-audit.mjs
```

只有已取得用户年龄确认授权时，才为最后一条命令增加 `LIVE_AGE_CONFIRM=1`。不设置时不自动确认年龄。可在命令末尾指定来源 ID 缩小复测范围，例如 `fanza mgstage javbus`。开发用 `jsdom` / `tough-cookie` 不会成为插件运行依赖。
