# MyBatis 工具箱（DBX 插件）

> 把 MyBatis 调试日志或 mapper XML 一步转换成可直接执行的 SQL。

`dbx-mybatis-tool` 是 DBX 的纯前端插件。它不连接数据库、不依赖后端服务，所有解析和 SQL 生成都在浏览器沙箱内完成：粘贴日志或 XML，即时得到展开后的 SQL，并可一键复制到 SQL 编辑器执行。

- **零权限**：`manifest.json` 中 `permissions` 为空，不访问文件系统、网络或数据库。
- **零依赖**：无第三方运行时依赖、无构建步骤，原生 ES Module。
- **跨平台**：声明 `engines.host_api = 1`，构建为 universal 包，一个 `.dbxp` 通用于所有平台。

---

## 目录

- [1. 项目简介](#1-项目简介)
- [2. 功能总览](#2-功能总览)
- [3. 快速开始](#3-快速开始)
- [4. 使用指南](#4-使用指南)
- [5. 解析引擎设计](#5-解析引擎设计)
- [6. 插件集成与界面](#6-插件集成与界面)
- [7. 项目结构](#7-项目结构)
- [8. 开发与测试](#8-开发与测试)
- [9. 构建与发布](#9-构建与发布)
- [10. 边界与限制](#10-边界与限制)
- [11. 安全说明](#11-安全说明)
- [12. 常见问题](#12-常见问题)

---

## 1. 项目简介

### 1.1 背景

MyBatis / MyBatis-Plus 在 DEBUG 日志中输出的是 `Preparing:`（带 `?` 占位符的 SQL）和 `Parameters:`（参数列表）两部分，二者是分开的。排查问题时，需要手动把参数逐个代回 SQL；参数一多、类型一杂，很容易出错。

另一方面，mapper XML 中的 SQL 往往包含 `<if>`、`<foreach>`、`<where>` 等动态标签，实际执行的 SQL 与源码差异很大，复制出来也不能直接运行。

### 1.2 目标

本项目提供两种互相独立的转换路径，并共享同一套参数渲染逻辑：

1. **日志回填**：从日志中提取 SQL 与参数，按顺序回填 `?`。
2. **XML 转 SQL**：解析 mapper XML，求值动态标签，内联 `#{}` 参数。
3. **自定义日志格式**：当内置日志解析不匹配时，用模板描述日志结构并解析。

输出目标是**语法完整、可直接在 DBX SQL 编辑器中执行**的 SQL，而不是 ORM 的中间表示。

---

## 2. 功能总览

| 能力 | 输入 | 输出 | 适用场景 |
| --- | --- | --- | --- |
| 日志回填 | MyBatis DEBUG 日志、JSON 日志、自定义格式 | 参数已替换的 SQL | 复现线上/测试环境实际执行的 SQL |
| XML 转 SQL | mapper XML + 参数 JSON | 动态标签展开、`#{}` 已内联的 SQL | 调试 mapper、验证动态条件分支 |
| 自定义日志格式 | 格式模板 + 现有日志 | 同上 | 公司内部日志框架、非标准日志格式 |

其他特性：

- 同时粘贴多条日志或多条 mapper 语句，逐条生成结果卡片。
- 参数数量与占位符数量不一致时给出警告，而不是静默生成错误 SQL。
- `?` 的识别和替换会跳过 SQL 字符串字面量（如 `'a?b'` 不会被替换）。
- 类型感知渲染：数字/布尔原样，字符串转义，Java 时间类型输出 ANSI 字面量。
- XML 模式支持 `#{}` 缺失参数以 `NULL` 代替，保证 SQL 语法完整。
- 支持“所有参数加单引号”开关（数字 `1` → `'1'`）。
- 跟随 DBX 明暗主题，剪贴板优先走 DBX 桥接。

---

## 3. 快速开始

### 3.1 安装

从 GitHub Release 下载 `dbx-mybatis-tool-<version>-universal.dbxp`，在 DBX 中安装该插件包，然后打开 **MyBatis工具箱** 工作台。

> 本地自行打包的 `.dbxp` 为未签名候选包；正式 Release 由 CI 生成并作为 Release 资源发布。

### 3.2 30 秒示例

日志回填模式粘贴：

```text
==>  Preparing: select * from t_user where id = ? and name = ?
==> Parameters: 42(Long), 张三(String)
```

得到：

```sql
select * from t_user where id = 42 and name = '张三'
```

XML 模式粘贴 `<select>` 片段和参数 `{"name": "张%"}`：

```xml
<select id="search">
  select * from t_user
  <where>
    <if test="name != null and name != ''">and name like #{name}</if>
  </where>
</select>
```

得到：

```sql
select * from t_user WHERE name like '张%'
```

---

## 4. 使用指南

### 4.1 日志回填

#### 支持的标准日志

- 完整日志行或仅 `Preparing:` / `Parameters:` 两行均可。
- 行首 `==>` / `<==` 箭头可缺失。
- 一次粘贴多组日志，按顺序生成多个结果卡片。
- 关联 `Total:` 行；提取 mapper 方法名、时间戳、TRACEID。
- 无 `Parameters:` 行时保留 `?` 并提示。

参数格式为 MyBatis 的 `值(类型)` 序列：

```text
2026-10-06 00:00:00(String), 0(Long), null, 950321300499333120(Long)
```

- 裸 `null` → SQL `NULL`；`null(String)` 是字符串 `'null'`。
- 参数值内部的逗号不会导致错误切分。
- 全类名（`java.lang.String`）与短类名（`String`）都支持。

#### 支持的 JSON 日志

兼容 logstash / 自定义 `SqlLogger` 输出的单行 JSON，例如：

```json
{"Time":"4","SqlId":"com.x.IUserMapper.selectOne","ExecuteSql":"SELECT ... WHERE (user_name = ?) LIMIT 1","Success":"true","Parameters":"[admin01]"}
```

- `ExecuteSql`、`SqlId`、`Parameters` 自动提取；行首 Spring/logback 前缀被忽略。
- `Parameters` 支持 Java `List.toString()` 风格 `[1, admin, null]`，也支持真正的 JSON 数组 `["x", 2]`。
- 无类型参数按字面量推断：数字、`true/false` 原样；`null` → `NULL`；其余加引号。

### 4.2 XML 转 SQL

#### 输入

- 完整 mapper XML，或单条 `<select>` / `<insert>` / `<update>` / `<delete>` 片段。
- 可选参数 JSON 对象，用于求值动态标签并内联 `#{}`。

```json
{"name": "张%", "statuses": [1, 2], "createdAt": null}
```

#### 支持的动态标签

| 标签 | 支持情况 |
| --- | --- |
| `<if test="...">` | 支持 OGNL 子集求值 |
| `<choose>/<when>/<otherwise>` | 支持 |
| `<where>` | 自动去除前导 `AND` / `OR` |
| `<set>` | 自动去除末尾逗号 |
| `<trim prefix suffix prefixOverrides suffixOverrides>` | 支持，空格行为与 MyBatis 一致 |
| `<foreach collection item index open separator close>` | 支持数组与对象，无 separator 时不插入分隔符 |
| `<include refid="...">` | 支持同文件 `<sql id>` 片段，带嵌套深度保护 |
| `<bind name value>` | 支持，值按 OGNL 子集求值 |
| `<selectKey>`、`<sql>` | 不参与 SQL 渲染 |
| XML 注释、CDATA、DOCTYPE、实体 | 支持 |

#### 参数渲染

| 写法 | 行为 |
| --- | --- |
| `#{name}` | 按参数 JSON 内联；字符串加引号并转义，数字/布尔原样，`null` → `NULL` |
| `#{name,jdbcType=...}` | 取属性名 `name`，`jdbcType` 等后缀忽略 |
| `#{missing}` | 参数未提供时输出 `NULL`，并告警，保证 SQL 语法完整 |
| `${table}` | 原样替换；`null` 输出空串（与 MyBatis 一致） |
| `${missing}` | 原样保留并告警（多用于表名/列名，替换成 NULL 会破坏语法） |

#### 表达式子集

`test`、`bind`、`#{}/${}` 中的表达式支持：

- 字面量：字符串、数字、`null`、`true` / `false`
- 逻辑：`and` / `or` / `not`、`&&` / `||` / `!`
- 比较：`==` `!=` `>` `>=` `<` `<=`、`eq` `ne` `gt` `ge` `lt` `le`
- 运算：`+ - * /`（`+` 在任一操作数为字符串时做拼接）
- 属性路径：`user.name`、`item.id`
- 常用方法：`.size()` / `.length`、`.isEmpty()`、`.contains(x)`、`.equals(x)`、`.toString()`

表达式无法解析时，`<if>` 按“条件成立”处理并告警，避免静默丢掉查询条件。

### 4.3 自定义日志格式

内置解析无法匹配公司内部日志时，点「格式配置」新建一条格式模板。可保存多条，但**只有选中的一条生效**；选择「默认解析」则回到内置解析。

#### 占位符

| 占位符 | 含义 |
| --- | --- |
| `{sql}` | **必填**，提取 SQL |
| `{parameters}` | 参数列表，自动识别带类型与无类型两种格式 |
| `{mapper}` | mapper / SqlId |
| `{time}` | 时间戳；省略时从行首自动提取 |
| `{其他名字}` | 不取值，仅用于跳过中间字段 |

模板按**行**匹配，仅占位符外的文本按字面量匹配，且不要求覆盖整行。示例格式：

```text
"SqlId":"{mapper}","ExecuteSql":"{sql}","Success":"{success}","Parameters":"{parameters}"
```

其中 `{success}` 只是跳过 `ExecuteSql` 与 `Parameters` 之间的字段。对 MyBatis 标准日志也可以写：

```text
Preparing: {sql}
```

但注意这是单行匹配，`Parameters:` 在下一行时无法配对；这种情况下应使用内置解析，或把两行合并后再匹配。

### 4.4 参数加引号

配置表单中的「所有参数都加单引号」：

- 勾选后立即作用于当前选中项（自定义配置或默认解析），无需重新添加。
- 数字 `1` → `'1'`，布尔 `true` → `'true'`，字符串照常转义。
- `null` 保持 `NULL`，不会变成 `'null'`。
- 每个配置独立保存该选项；默认解析有独立的全局选项。
- 适合目标列是字符类型、但日志中参数未带类型或类型推断不符合预期的场景。

---

## 5. 解析引擎设计

### 5.1 模块分层

`ui/app.js` 同时包含纯解析引擎和浏览器 UI：

```
┌─────────────────────────────────────────────────────┐
│ ui/index.html + ui/style.css                        │
│  工作台布局、模式切换、结果卡片、配置弹窗           │
├─────────────────────────────────────────────────────┤
│ ui/app.js · 浏览器 UI（typeof document !== undefined）│
│  事件绑定、渲染、剪贴板、localStorage 配置           │
├─────────────────────────────────────────────────────┤
│ ui/app.js · 解析引擎（纯函数，export 供 Node 测试）  │
│  日志解析 / XML 解析 / OGNL 子集 / 参数渲染 / 回填   │
├─────────────────────────────────────────────────────┤
│ 无第三方依赖、无网络、无文件系统                     │
└─────────────────────────────────────────────────────┘
```

UI 代码通过 `typeof document !== 'undefined'` 隔离，因此在 Node 中导入 `app.js` 只会加载纯函数，不会触碰 DOM。

### 5.2 对外 API

| 导出函数 | 用途 |
| --- | --- |
| `renderParam(param)` | 按类型把单个参数渲染为 SQL 字面量 |
| `parseParams(text)` | 解析 MyBatis `值(类型)` 参数列表 |
| `countPlaceholders(sql)` | 统计字面量外的 `?` 数量 |
| `fillSql(sql, params)` | 按顺序回填 `?`，跳过字符串字面量 |
| `parseLog(text, options)` | 解析内置支持的日志，返回语句列表与警告 |
| `parseMapperXml(xmlText, params)` | 解析 mapper XML，返回每条语句的 SQL 与告警 |
| `parseLogWithFormat(text, format, options)` | 按自定义格式模板解析日志 |

日志语句对象：

```text
{ sql, params, filledSql, placeholders, mapper, mapperShort,
  timestamp, traceId, total, hasParametersLine, warnings }
```

XML 语句对象：

```text
{ tag, id, sql, warnings, inlined, unresolved }
```

### 5.3 日志解析流水线

```
输入文本
  │
  ├─ 逐行扫描
  │    ├─ JSON 日志（含 "ExecuteSql"）→ JSON.parse → 语句
  │    ├─ Preparing: → 新建语句
  │    ├─ Parameters: → 配对并结束语句
  │    └─ Total: → 回填上一条语句
  │
  └─ 或：自定义格式 → 模板编译为正则 → 逐行捕获字段
        │
        ▼
   finalizeStatements()
        ├─ parseParams / parseParamsAuto
        ├─ countPlaceholders
        ├─ fillSql（跳过 '...' 字面量）
        └─ 数量不一致 → 警告
```

### 5.4 类型渲染规则

| Java 类型（短名或全类名） | SQL 输出 |
| --- | --- |
| `Integer` `Long` `Short` `Byte` `Double` `Float` `BigDecimal` `BigInteger` `Number` 及小写 | 原样 |
| `Boolean` `boolean` | 原样 |
| `Date` `LocalDate` `Year` `YearMonth` `MonthDay` | `DATE 'yyyy-MM-dd'` |
| `Timestamp` `LocalDateTime` `OffsetDateTime` `ZonedDateTime` `Instant` | `TIMESTAMP '...'`（ISO `T` 与时区偏移归一化） |
| `Time` `LocalTime` | `TIME 'HH:mm:ss'` |
| `String` 及未知类型 | `'value'`，内部 `'` 转义为 `''` |
| `null` | `NULL` |

时间类型输出 ANSI 字面量，是为了兼容 Oracle 在函数参数位置（如 `trunc(?)`）不会隐式把字符串转为 `DATE` 的情况；`String` 类型仍输出普通引号，`to_date(?, 'fmt')` 等场景不受影响。

### 5.5 XML 解析与动态 SQL

1. **容错 XML 解析**：扫描 `<`…`>`，处理注释、CDATA、DOCTYPE、自闭合标签、实体解码；不要求文档严格合法。
2. **片段收集**：先收集全部 `<sql id>`，供 `<include>` 引用。
3. **语句收集**：只解析 `<select>/<insert>/<update>/<delete>`，可一次处理多条。
4. **渲染**：递归遍历子节点，按标签语义拼接；`<where>/<set>/<trim>/<foreach>` 在拼接时处理前缀、后缀和分隔符。
5. **占位符**：文本节点的 `#{}` / `${}` 就地求值；结果再用 `squashSpaces` 合并空白，但保留单引号字面量内部原样。
6. **告警去重**：同一语句内相同告警只出现一次；`include` 嵌套超过 10 层会中断。

### 5.6 自定义格式编译

模板 `"SqlId":"{mapper}","ExecuteSql":"{sql}"` 的编译过程：

1. 把占位符外的文本逐段做正则转义（引号、括号、`.`、`{`、`}` 等都按字面量处理）。
2. 占位符替换为捕获组；末尾占位符使用贪婪捕获，避免匹配为空。
3. 每行日志在任意位置搜索该正则，捕获到的字段按名称映射。
4. 参数捕获值经 `parseParamsAuto` 自动选择“带类型”或“无类型”解析器。
5. `quoteAll` 选项在最终回填前把所有非 null 参数类型改为 `String`。

---

## 6. 插件集成与界面

### 6.1 DBX 集成

`manifest.json` 关键字段：

| 字段 | 值 |
| --- | --- |
| `manifest_version` | `1` |
| `id` | `dbx-mybatis-tool` |
| `version` | `1.0.0` |
| `engines.host_api` | `1` |
| `entrypoints.ui` | `ui` / `ui/index.html` |
| `contributions` | `workbench`：MyBatis工具箱 |
| `permissions` | `[]` |
| `localizations` | `zh-CN` |

插件提供一个沙箱化前端工作台，无原生 Sidecar。`dbx-plugin.toml` 规定打包内容只包含 `assets` 和 `ui`，测试代码不会进入发布包。

### 6.2 界面结构

- 顶部分段按钮：**日志回填** / **XML 转 SQL**。
- 输入区：日志文本框，或 XML 文本框 + 参数 JSON 文本框。
- 结果区：每条 SQL 一张卡片，包含标题、元信息、警告、SQL 正文和「复制 SQL」按钮。
- 配置弹窗：格式列表（单选启用）、名称/格式输入、示例填充、参数加引号开关。

### 6.3 剪贴板与主题

- 复制优先调用 `window.dbxPlugin.clipboard.writeText`，其次 `window.dbxPlugin.copy`，最后回退到隐藏 `textarea + execCommand`。
- 样式使用 DBX 注入的 `--color-*`、`--radius-*`、`--font-*` 主题变量，并提供 fallback，脱离宿主也能正常显示。
- 所有动态内容经 HTML 转义后再写入 `innerHTML`，避免日志/SQL 内容注入页面。

---

## 7. 项目结构

```text
.
├── manifest.json                # 插件身份、入口、workbench 贡献点、中文本地化
├── dbx-plugin.toml              # 打包范围：assets + ui
├── .dbx-store.json              # 插件仓库元数据（标签、许可证、release notes）
├── assets/
│   └── plugin.svg               # 插件图标
├── ui/
│   ├── index.html               # 工作台入口与页面结构
│   ├── style.css                # 基于 DBX 主题 tokens 的样式
│   └── app.js                   # 解析引擎 + 浏览器 UI
├── test/
│   └── run.mjs                  # 引擎测试（Node，无测试框架）
├── .github/workflows/
│   └── plugin-release.yml       # GitHub Release 自动打包
└── dist/                        # 本地打包产物（gitignore）
```

---

## 8. 开发与测试

### 8.1 环境

- Node.js（ES Module 支持；用于运行测试与打包）
- DBX 插件 CLI（`@dbx-app/plugin-cli`）

无需安装项目依赖，也没有编译步骤。

### 8.2 运行测试

```bash
node test/run.mjs
```

测试覆盖：

- 真实 MyBatis-Plus 日志（Oracle `to_date`、rownum 分页、`IN` 批量查询）
- 参数值含逗号、引号、`null`、布尔、`BigDecimal`
- Java 日期/时间类型渲染
- JSON SqlLogger 日志与 Sleuth traceId
- 自定义格式、`quoteAll`、默认解析加引号
- XML 动态标签、表达式、实体/CDATA、缺失参数 → `NULL`
- 错误与边界：参数数量不匹配、无 `Parameters` 行、非法格式

测试脚本不依赖任何测试框架，断言失败以非零码退出，适合本地和 CI 直接调用。

### 8.3 本地预览

插件是静态页面，可用任意静态服务器预览（无 DBX 桥接时会走剪贴板回退）：

```bash
cd ui
python3 -m http.server 8080
# 浏览器访问 http://localhost:8080
```

### 8.4 修改引擎的约定

1. 解析逻辑保持纯函数并 `export`，便于 Node 测试。
2. 新增日志/XML 语法时，同时补充 `test/run.mjs` 用例。
3. 影响用户可见行为的改动，同步更新 `manifest.json` 的 `version` 与 `.dbx-store.json` 的 `releaseNotes`。
4. 不要引入第三方运行时依赖；当前包体只有数十 KB。

---

## 9. 构建与发布

### 9.1 本地打包

```bash
DBX_PLUGIN_TARGET=universal \
  npx -y @dbx-app/plugin-cli@0.1.10 package .
```

产物：

```text
dist/dbx-mybatis-tool-1.0.0-universal.dbxp
dist/dbx-mybatis-tool-1.0.0-universal.artifact.json
```

`.dbxp` 是 zip 格式，包含 `manifest.json`、`assets/`、`ui/` 和 `checksums.json`。本地产物为未签名候选包，仅用于自测/评审。

### 9.2 GitHub Release

`.github/workflows/plugin-release.yml` 在发布 Release 时调用 `t8y2/dbx` 的复用工作流：

- 构建矩阵：`universal`（单个跨平台包）。
- 打包命令：`dbx-plugin package .`。
- 上传 `dist/*.dbxp` 与 `dist/*.artifact.json` 作为 Release 资源。

正式发版流程：

1. 修改 `manifest.json` 的 `version` 和 `.dbx-store.json` 的 `releaseNotes`。
2. 运行测试 `node test/run.mjs`。
3. 提交并推送。
4. 在 GitHub 创建并发布对应 tag 的 Release，等待 CI 完成打包与资源上传。

---

## 10. 边界与限制

| 限制 | 说明 |
| --- | --- |
| 不执行 SQL | 只生成文本，不连接或校验数据库 |
| 日志按行解析 | 一条日志/一条 SQL 对应一行；跨行 SQL 不支持 |
| 自定义格式按行匹配 | 不能用一个模板跨行配对 `Preparing:` 与 `Parameters:` |
| OGNL 仅子集 | 不支持 `in (...)`、静态方法调用、`#this` 等完整 OGNL 语法 |
| `<include>` 属性 | 不展开 `<property>` 子标签，片段中的 `${}` 可能保留并告警 |
| JSON 大整数 | `JSON.parse` 对超过 2^53 的整数会丢精度，建议写成字符串 |
| XML 解析容错 | 不校验文档合法性，畸形 XML 可能得到不完整结果 |
| `${}` 缺失 | 原样保留（表名/列名场景无法安全替换） |
| 一次生效一个配置 | 多条自定义格式仅选中的一条参与解析 |
| 不做 SQL 注入防护 | 参数会被直接内联，属于调试工具行为 |

---

## 11. 安全说明

- **零权限、零网络**：插件不发起网络请求，不读取文件系统，不访问数据库。
- **本地存储**：自定义格式配置保存在浏览器 `localStorage`（键 `mybatis-sql-fill.log-formats`）；存储不可用时退化为仅当前会话生效。
- **敏感数据**：生成的 SQL 会包含真实参数值。复制、截图或上报前请确认数据合规；日志文本本身可能包含个人信息。
- **执行前复核**：工具只保证生成 SQL 的语法结构，不保证业务语义、权限或执行计划正确。请先在测试环境验证。
- **不可信输入**：参数值会被转义为 SQL 字面量，但该工具不是安全边界；不要用它处理不可信用户输入后直接在生产执行。

---

## 12. 常见问题

**Q：XML 里的 `#{}` 参数没有传，为什么生成的是 `NULL` 而不是 `?`？**
A：为了保证 SQL 语法完整，缺失参数统一输出 `NULL` 并告警。日志回填模式下仍会保留 `?`。

**Q：想生成 `'1'` 这样的字符串参数怎么办？**
A：打开「格式配置」，勾选「所有参数都加单引号」。该选项对日志回填/自定义格式生效，XML 模式请直接在参数 JSON 中传字符串。

**Q：JSON 日志能解析，但自定义格式匹配不到？**
A：模板只需写日志中稳定出现的片段，不必从行首开始；字段顺序必须与日志一致，中间字段用 `{任意名字}` 跳过。

**Q：配置勾选后不生效？**
A：勾选框作用于当前选中项。未选中自定义配置时作用于默认解析；列表中有「全部加引号」标签才表示已开启。

**Q：超大 ID 变成科学计数法/末位变了？**
A：JSON 数字超过 2^53 会丢精度，请把 ID 写成字符串（`"950321300499333120"`）。

**Q：会支持完整的 MyBatis/OGNL 语义吗？**
A：定位是常用调试场景的子集。遇到不支持的语法会给出警告，而不是静默生成错误 SQL。

---

## 13. 相关链接

- 源码 / 问题反馈：<https://github.com/Tycoon-HJ/dbx-mybatis-tool>
- DBX：<https://github.com/t8y2/dbx>
- 插件清单规范：<https://raw.githubusercontent.com/t8y2/dbx/main/plugins/manifest.schema.json>
- 许可证：Apache-2.0

---
