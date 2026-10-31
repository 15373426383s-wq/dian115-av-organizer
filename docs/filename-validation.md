# 文件名识别验证

最新补充：1.2.3 已修复 HEYZO 点号分隔，3,039 条文件名全部通过；HEYZO-1048、HEYZO-2000 已在三个来源完成真实刮削。详见 [刮削验证记录](scrape-validation-1.2.3.md)。以下保留 1.2.1 的原始记录。

验证日期：2026-10-31。用户要求使用公开番号并生成混乱文件名；本轮没有读取或处理用户媒体文件。

## 结果

- 9 个番号经插件现有 `runSource` 规则引擎从公开页面/API 实际取到元数据，不下载视频或图片。
- 10 种编号样本（上述 9 个与 1 个 HEYZO 格式样例）生成 3,019 条文件名，用独立填写的期望值核对番号、三个标记与分段。
- 同一组样本在旧代码中有 345 条不符；修复后 3,019 / 3,019 通过。这个比例只代表本组样本，不能外推为任意文件名的识别率。
- 完整自动回归 262 项通过，页面冒烟检查通过。联网探测单列，不算进这 262 项。

## 本轮成功取到资料的公开编号

| 番号 | 实际来源 | 标题 | 封面地址 | 演员数 |
| --- | --- | --- | --- | --- |
| SSIS-001 | [JAV Database](https://www.javdatabase.com/movies/ssis-001/) | 有 | 有 | 2 |
| IPX-177 | [JAV Database](https://www.javdatabase.com/movies/ipx-177/) | 有 | 有 | 1 |
| ABP-001 | [JAV Database](https://www.javdatabase.com/movies/abp-001/) | 有 | 有 | 1 |
| MIDE-500 | [JAV Database](https://www.javdatabase.com/movies/mide-500/) | 有 | 有 | 1 |
| 259LUXU-1000 | [AV-Wiki](https://av-wiki.net/259luxu-1000/) | 有 | 有 | 1 |
| 123120_001 | [1Pondo 官方 JSON](https://www.1pondo.tv/dyn/phpauto/movie_details/movie_id/123120_001.json) | 有 | 有 | 1 |
| 010120-001 | [Caribbeancom 官方](https://www.caribbeancom.com/moviepages/010120-001/index.html) | 有 | 有 | 1 |
| FC2-PPV-1292936 | [FC2 官方](https://adult.contents.fc2.com/article/1292936/) | 有 | 有 | 0 |
| N1234 | [Tokyo-Hot 官方](https://my.tokyo-hot.com/product/n1234/) | 有 | 有 | 1 |

“有封面地址”仅表示解析出 URL，没有证明图片下载/裁剪成功。FC2 本次没有演员字段，不补造演员。文件名周围的广告、乱码和文字是合成数据，不是实际作品标题。

共进行了 18 次“来源＋番号”探测，9 次成功，9 次未成功：JavBus 的 4 个样本被年龄验证阻挡；HEYZO 维护；FC2PPVDB 返回 HTTP 526；AVSOX 对 HEYZO 无结果；JavDB 对 HEYZO 返回地区限制；JAV Database 对 ABP-123 无结果（因此改用成功取到资料的 ABP-001）。没有绕过年龄/地区验证、使用登录凭据或重试提交媒体任务。HEYZO-2000 仅保留为格式回归样例，不计入联网确认的 9 个番号。

## 生成内容与修复

| 类别 | 条数 | 检查点 |
| --- | ---: | --- |
| 广告前缀、大小写、后缀和扩展名组合 | 2,880 | 8 种前缀 × 12 种后缀 × 3 种扩展名 × 10 个编号 |
| 全角字符、不可见字符 | 20 | 不改变原始输入，仅在识别时归一化 |
| 括号标记、组合标记、字幕缩写 | 30 | `[C]`、`-U-C`、`.chs` |
| 分段前标签 | 20 | `-4K-1`、`-UC-8K-2`；4K/8K 本身不能成为分段 |
| 父目录回退、点号目录 | 14 | `video-CD2.mp4`、目录 `IPX.177` |
| 分隔符、DMM 内容编号、FC2 点分隔 | 38 | 空格包围连字符、重复下划线、厂商前缀、`FC2.PPV.1292936` |
| 不得确定单一番号 | 17 | 普通文件、编码标签、站点广告、多个番号 |

额外断言覆盖相邻番号/增加数字不能等同、消息中的多番号完整保留、编码标签不创建订阅，以及清理后不残留番号/字幕标签作为标题线索。

## 复测与导出

```bash
node --test test/messy-names.test.mjs
node test/filename-audit.mjs /tmp/filename-report.json
```

第二条命令导出 JSON 与同名 CSV，逐条包含合成文件名、父目录、预期、实际结果、差异；文件已存在时拒绝覆盖。只处理字符串，不创建媒体文件。

联网复测（jsdom 仅为开发依赖）：

```bash
JSDOM_DIR=/path/to/node_modules LIVE_NUMBERS=SSIS-001,IPX-177,ABP-001,MIDE-500 LIVE_REPORT=/tmp/filename-live.json node test/live-sources.mjs javdatabase
JSDOM_DIR=/path/to/node_modules LIVE_NUMBERS=259LUXU-1000 node test/live-sources.mjs avwiki
JSDOM_DIR=/path/to/node_modules LIVE_NUMBERS=123120_001 node test/live-sources.mjs 1pondo
JSDOM_DIR=/path/to/node_modules LIVE_NUMBERS=010120-001 node test/live-sources.mjs caribbeancom
JSDOM_DIR=/path/to/node_modules LIVE_NUMBERS=FC2-PPV-1292936 node test/live-sources.mjs fc2
JSDOM_DIR=/path/to/node_modules LIVE_NUMBERS=N1234 node test/live-sources.mjs tokyohot
```

联网结果会随站点和网络变化。此记录不代表移动真实文件、视频探测、图片处理、AI 翻译或向下载器提交任务的端到端验证。
