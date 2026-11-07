# Magpie Account Reauth Notify

一个独立的 Magpie Bun 插件：定时只读 `logins.json`，发现 Codex 账号已有“需要重新登录”的标记时发送通知。适用于 Docker 中的 Magpie。

不修改 Magpie 核心，不运行账号 CLI，不访问供应商的认证、额度或模型接口；不监听文件，不遍历目录。只有通知发送会访问你配置的外部渠道。

## 行为

- 启动后扫描一次，之后每轮结束等待 30 秒再扫描，可配置。
- 新的非空 `lapsed` 在约 2 秒后复读确认，然后入队。首次启动已有的失效标记也会提醒。
- 所有已保存的 Codex 账号默认纳入，包括 `on=false` 的当前账号。支持白名单、忽略列表和显示别名。
- A 账号失效、B 接替成功仍通知 A；不依赖请求最终是否失败。
- 同一故障去重，重启后保持。持续提醒、标记解除通知默认关闭。
- 只把 `codex-signin-gone.json` 的条目数作为诊断，不用可能属于旧凭据的记录直接报警。
- 文件损坏、读取失败或账号列表突然变空时显示未知，保留已有故障；移除账号不算恢复。
- 通知独立于扫描和模型请求；每个渠道独立记录结果并重试。

仅能发现 **Magpie 已经确认并保存** 的失效状态。被动读取不能发现核心尚未发现的撤销；文件中的标记清除也不等于实时验证了所有模型。两次扫描之间出现又自行清除的短暂标记可能看不到。

## 安装到 Docker

需要支持 Bun 服务端插件入口的 Magpie，Bun ≥ 1.4.2。已用 Bun 1.4.4 和 Magpie 源码 `8cbaeecae976d2a8561293c1abc5daf6aa89d77f` 的原版插件宿主验证；尚未在你的实际容器中测试。

下面假设容器名为 `magpie`，使用官方镜像和 `/config` 数据卷。可直接从本仓库安装，无需先发布到 npm：

```sh
docker exec magpie magpie plugin add github:onepiece-studio/magpie-auth-notify
```

然后在 Magpie 的插件选项中配置通知渠道。容器需要能够访问 GitHub；私有仓库还需要对应访问权限。

### 使用本地安装包

也可以在本仓库运行文末的打包命令，通过归档安装。解包后的插件目录必须持久化，不能只放在 `/tmp`。

```sh
docker cp dist/magpie-account-reauth-notify-0.1.0.tgz magpie:/tmp/account-reauth-notify.tgz

docker exec magpie mkdir -p /config/custom-plugins/account-reauth-notify

docker exec magpie tar -xzf /tmp/account-reauth-notify.tgz \
  -C /config/custom-plugins/account-reauth-notify --strip-components=1

docker exec magpie magpie plugin add /config/custom-plugins/account-reauth-notify
```

也可以把本项目的 `index.mjs`、`src/` 和 `package.json` 等发布文件复制到上述目录后添加。无需 npm install、构建或修改 Magpie 镜像。

插件使用 `input.directory` 查找数据。官方镜像默认读取：

```text
/config/magpie/logins.json
/config/magpie/codex-signin-gone.json
/config/magpie/plugins.json
```

官方运行用户为 UID/GID 65532。只要它能正常读写自己的 `/config` 数据卷，插件通常也具备相同权限；不需要 privileged 或 Docker socket。不要将 `logins.json` 单文件绑定挂载，Magpie 的原子替换写入需要正常目录语义。

## 配置通知

默认 `channels: []`，没有配置渠道就不会发消息。可以在 Magpie 的插件选项里编辑 JSON，也可通过插件 CLI 设置。**这个命令只配置插件，不是 `accounts` 查询。**

飞书示例（将占位值替换为你自己的值）：

```sh
docker exec magpie magpie plugin options github:onepiece-studio/magpie-auth-notify \
  '{"instanceName":"家用网关","channels":[{"type":"feishu","webhook":"https://open.feishu.cn/open-apis/bot/v2/hook/替换为你的地址","secret":"替换为签名密钥"}]}'
```

飞书机器人未启用签名时删除 `secret`。若通过本地归档安装，将上面命令的插件名称替换为 `/config/custom-plugins/account-reauth-notify`。渠道配置和别名由用户显式指定；以下配置示例不是可直接使用的真实凭据：

```json
{
  "instanceName": "家用网关",
  "pollIntervalSeconds": 30,
  "confirmSeconds": 2,
  "accountAllowlist": [],
  "accountIgnorelist": [],
  "accountAliases": {
    "id:某个账号ID": "工作备用号"
  },
  "notifyRecovery": false,
  "reminderHours": 0,
  "maxNotificationsPerHour": 20,
  "notificationTtlHours": 24,
  "maxPending": 1000,
  "channels": [
    {
      "type": "telegram",
      "token": "替换为机器人token",
      "chatId": "替换为chatId"
    }
  ]
}
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件内部开关；也可使用 Magpie 的插件开关 |
| `instanceName` | `Magpie` | 通知里显示的实例名称 |
| `pollIntervalSeconds` | `30` | 每轮完成后的等待时间，5–3600 秒；扫描不重叠 |
| `confirmSeconds` | `2` | 首次发现后的确认等待，1–60 秒，同一轮合并复读 |
| `accountAllowlist` | `[]` | 空表示全部；匹配账号 ID、`id:ID` 或完整 user 标识 |
| `accountIgnorelist` | `[]` | 同样匹配，优先于白名单 |
| `accountAliases` | `{}` | 显示名称映射，支持以上键；默认显示匿名账号引用 |
| `notifyRecovery` | `false` | 已成功提醒的故障解除标记后通知一次 |
| `reminderHours` | `0` | 0 关闭；大于 0 时按间隔提醒持续故障，最多 720 小时 |
| `maxNotificationsPerHour` | `20` | 全渠道每滚动小时的发送尝试数，包含失败和重试 |
| `notificationTtlHours` | `24` | 待发通知有效期，1–720 小时；过期记入诊断 |
| `maxPending` | `1000` | 队列上限，1–10000；超出时记录诊断，下轮继续安排 |

白名单/忽略列表不修改 Magpie 的路由。完整 user 标识可能包含工作区区分，不要自行截成邮箱。显示别名是用户主动提供的文字，会出现在通知中；默认不发送邮箱或原始错误文本。

### 渠道

每个渠道是 `channels` 数组中的一个对象；支持 `off: true`。可以同时配置不同渠道，同一配置的重复渠道会被拒绝。渠道发送逻辑改编自社区 notify，见 [第三方许可](THIRD_PARTY_NOTICES.md)。

| type | 必填字段 | 常用可选字段 |
| --- | --- | --- |
| `feishu` | `webhook` | `secret` |
| `dingtalk` | `webhook` | `secret` |
| `wecom` | `webhook` | — |
| `telegram` | `token`, `chatId` | `server`，默认 `https://api.telegram.org` |
| `ntfy` | `topic` | `server`, `token`, `priority`, `tags` |
| `bark` | `key` | `server`, `group`, `sound` |
| `gotify` | `server`, `token` | `priority`, `extras` |
| `serverchan` | `key` | 支持 SCT 和 sctp 格式 |
| `webhook` | `url` | `headers` |

通用 Webhook POST 内容为 `{title, body, event}`。`event` 包含稳定的事件 ID、实例标识、通知类型以及匿名账号引用/别名/首次观测时间，接收方可据事件 ID 去重。Webhook 以 HTTP 2xx 为成功；如果返回 JSON 中明确包含失败的 `code`、`errcode` 或 `ok: false`，仍算失败。机器人渠道额外验证各自业务成功码。

每个 HTTP 请求最多 10 秒，不跟随重定向。临时失败按约 30 秒、2 分钟、10 分钟（加随机偏移）重试，遵守 `Retry-After`。明确的 HTTP 鉴权/配置失败会阻塞该通知，修复选项或重新加载插件后可重试。部分机器人仅返回通用业务错误码，此时按临时失败退避。

## 状态和排查

插件只在自己的目录写入数据：

```text
/config/magpie/account-reauth-notify/
  owner.sqlite    单实例所有权锁
  state.sqlite    故障、去重和待发通知
  status.json     不含账号和密钥的运行诊断
```

SQLite 可能产生自己的 journal 文件。目录权限为 0700，数据库和诊断文件为 0600。保留整个目录即可跨容器重建去重。不要在运行中删除数据库或锁文件。

只查看插件自己的脱敏诊断：

```sh
docker exec magpie cat /config/magpie/account-reauth-notify/status.json
```

| 状态 | 含义 |
| --- | --- |
| `ready` | 最近采集成功；`enabledChannels: 0` 表示尚未配置渠道 |
| `accounts_empty_unknown` | 之前存在账号，现在列表为空，保留故障，不当成恢复 |
| `source_missing` / `source_unreadable` | 指定文件不存在或不可读 |
| `source_invalid_json` / `accounts_schema` | 文件结构不兼容或损坏；不会输出原文 |
| `config_unreadable` / `config_invalid` | 插件启停配置无法确认，暂停发送 |
| `plugin_disabled` / `plugin_removed` / `config_changed` | 旧实例停止，防止继续按旧配置发消息 |
| `standby`（日志） | 其他宿主已取得所有权，本实例等待接管 |
| `state_invalid` / `state_unavailable`（日志） | 状态库异常，停止运行并保留文件，不覆盖损坏数据 |

`lastSuccessAt`、`lastScanAt` 等为毫秒时间戳；`pending` / `blocked` 是队列计数，`channelResults` 是每个渠道最近一次发送结果。`gone` 仅表示未核实记录的数量，不能当成当前失效账号数。

如果插件状态库无法打开，诊断文件可能保留旧内容，应同时检查 Magpie 插件日志。插件仅输出固定诊断代码，不输出第三方错误正文、URL 或密钥。

## Docker 和存储限制

建议使用本地磁盘上的 Docker 数据卷或 bind mount。定时读取不依赖 inotify，适用于 Docker Desktop；网络卷的读缓存仍可能延迟看到更新。

**单实例保护及状态库要求文件系统正确支持 SQLite 的字节范围锁和原子文件操作。** 没有验证 NFS/SMB 的一致性，不能仅因源文件能读就承诺在这些卷上具备可靠去重。首版不支持多个容器/多台机器主动共享同一配置目录运行插件。

独占锁使用单独的 SQLite 写事务，由内核在进程退出/崩溃后释放，不用“心跳过期就抢锁”的方式。新宿主按扫描周期重试接管；旧宿主仍存活时可能延迟通知，避免重复发送。单进程中的扫描和发送也分别串行。

后台入口的加载时机由 Magpie 决定。插件已加载且宿主存活时不需要模型请求，主机或宿主停止后它不会继续运行。关闭插件只阻止后续发送，已到达远端的在途消息无法撤回。

外部服务收到消息、本地提交成功记录前崩溃，仍可能造成重发；普通聊天机器人不能保证恰好一次。使用 Webhook 事件 ID 可以在接收端额外去重。

## 隐私与源文件

源文件 `logins.json` 含凭据，读取和解析时这些字节会短暂进入插件进程。插件只提取账号身份和 `lapsed` 布尔状态，不使用凭据进行网络请求，不读取 Codex 的 `auth.json`，不保存 token 或原始 lapsed 文案。

账号引用使用插件随机盐做 HMAC，原始账号 ID/user 不落入插件状态库。通知和库中只保存匿名引用或你配置的别名。渠道凭据留在 Magpie 的插件选项中，不复制到插件状态库。不要把源账号文件用于排查分享。

## 开发与验证

无运行时 npm 依赖，Bun 自带 SQLite。

```sh
bun test
```

测试仅使用临时账号夹具和本机模拟通知服务。可另外指定已检出的 Magpie 原版宿主进行兼容性测试：

```sh
MAGPIE_TEST_HOST_JS=/path/to/magpie/internal/plugin/host.js bun test
```

没有指定时，宿主兼容性测试会跳过，其余测试照常运行。制作 npm 格式安装归档：

```sh
mkdir -p dist
npm pack --ignore-scripts --pack-destination dist
```

设计和覆盖边界见 [设计文档](docs/account-reauth-notify-design.md)。
