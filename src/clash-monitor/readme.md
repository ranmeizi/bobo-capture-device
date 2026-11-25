可以的。FlClash 底层的 mihomo 内核暴露了完整的 RESTful API（External Controller），你完全可以沿用现有的 ADB 通道，通过 HTTP 请求来读取代理节点的实时状态、延迟，甚至执行切换操作。

🔑 前置条件：确认 API 地址与密钥
FlClash 的外部控制器默认监听在 127.0.0.1:9090，地址和 secret 可以在 App 的“设置 → 外部控制”中找到。所有 API 请求都需要携带 Authorization: Bearer <secret> 请求头进行认证。

📡 核心端点：获取代理节点状态
1. 获取全量节点与代理组信息：GET /proxies

这是最核心的端点，返回所有代理组、节点及其当前状态。在 AidLux 终端中执行：

bash
adb shell "curl -sS -H 'Authorization: Bearer <你的secret>' http://127.0.0.1:9090/proxies"
返回的 JSON 中，重点关注两类对象：

代理组（如 Proxy, Auto）：查看 now 字段，它告诉你该组当前选中的是哪个节点。

具体节点：查看 history 字段，里面记录了最近一次延迟测试的结果（delay 值，单位毫秒）。如果节点未被测试过，history 可能为空。

2. 查询单个节点详情：GET /proxies/{节点名称}

如果你只关心某个特定节点，可以直接查询：

bash
adb shell "curl -sS -H 'Authorization: Bearer <你的secret>' 'http://127.0.0.1:9090/proxies/节点名称'"
⏱️ 主动测速：获取节点的实时延迟
history 中的延迟是历史数据，要获取实时延迟，需要调用延迟测试端点：

bash
adb shell "curl -sS -G -H 'Authorization: Bearer <你的secret>' \
  --data-urlencode 'url=https://www.gstatic.com/generate_204' \
  --data-urlencode 'timeout=5000' \
  'http://127.0.0.1:9090/proxies/节点名称/delay'"
url 建议使用稳定的轻量地址（如 https://www.gstatic.com/generate_204）。

timeout 单位为毫秒，可根据网络状况调整（5000ms 是个合理的起点）。

成功时返回的 JSON 中会包含 delay 字段。注意：如果节点不可用或超时，请求可能返回错误状态，在脚本中需要区分“延迟高”和“完全不可用”两种情况。

🔄 甚至可以直接切换节点
对于 selector 类型的代理组（手动选择），你可以通过 PUT /proxies/{组名} 来切换当前节点：

bash
adb shell "curl -sS -X PUT -H 'Authorization: Bearer <你的secret>' \
  -H 'Content-Type: application/json' \
  -d '{\"name\":\"目标节点名称\"}' \
  'http://127.0.0.1:9090/proxies/Proxy'"
🛠️ 整合到你的 ADB 监控脚本中
你之前的自检脚本已经在用 curl 探测 /version 来判断内核存活，现在可以更进一步，定期拉取 /proxies 并解析关键字段，让监控从“内核在不在”升级为“节点状态健不健康”。

一个轻量的判断逻辑示例（在 AidLux 的 bash 中，借助 jq 解析 JSON）：

bash
# 检查指定代理组的当前选中节点及其延迟
GROUP="Proxy"  # 替换为你实际的代理组名称
RESPONSE=$(adb shell "curl -sS -H 'Authorization: Bearer <secret>' http://127.0.0.1:9090/proxies")

CURRENT_NODE=$(echo "$RESPONSE" | jq -r ".proxies[\"$GROUP\"].now")
DELAY=$(echo "$RESPONSE" | jq -r ".proxies[\"$CURRENT_NODE\"].history[-1].delay // \"untested\"")

echo "代理组 $GROUP 当前节点: $CURRENT_NODE, 延迟: ${DELAY}ms"
如果 DELAY 为 null 或 untested，可以考虑触发一次主动测速；如果延迟持续过高或节点名发生意外变化（比如 url-test 组自动切换了），都可以作为告警或触发进一步动作（如重启 FlClash）的信号。

总结：你不需要图形界面，/proxies 端点就是你查看代理节点状态的“仪表盘”，配合 /proxies/{name}/delay 可以按需测速。把这些 HTTP 调用包装进现有的 ADB 自检脚本里，就能实现对 FlClash 代理层状态的自动化监控。