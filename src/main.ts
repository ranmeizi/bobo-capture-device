/**
 * client 子工程引用根目录开发的 cdp-client-tool 模块
 * 使用前需在仓库根目录执行: pnpm run build
 */
import { Client, EVENTS } from "cdp-client-tool";

const client = new Client({
  deviceName: "lenovo L79031",
  gateways: [
    {
      name: "local",
      uri: "http://localhost:3000/cct_ws",
      opts:{
        transports: ['websocket'],
        path: '/socket.io',
      }
    },
  ],
});

console.log("Client 已创建，事件枚举:", EVENTS);
