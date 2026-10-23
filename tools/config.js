/* ============================================================
 *  Neon 连接配置。
 *
 *  这个文件**不含任何密钥**，只有两个公开端点地址，
 *  可以且必须提交到 Git —— GitHub Pages 靠它才能连上 Neon。
 *  （JWT 不在这里：登录时由 Neon Auth 现场签发，约 15 分钟有效。）
 *
 *  1) url —— Data API REST 地址（控制台 Data API 页面原文，勿改）
 *
 *  2) authUrl —— Neon Auth 地址，用控制台「Better Auth」页面显示的原文，
 *     末尾的 /auth 是路由前缀，必须保留。
 *     正确：https://ep-purple-surf-b3n0of19.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth
 *     错误：.../neondb        ← 会变成 /neondb/sign-in/email，404
 *     错误：.../neondb/auth/  ← 会变成 /neondb/auth//sign-in/email
 *
 *  JWT 分两步签发，登录页自动完成，无需手工复制：
 *     ① POST {authUrl}/sign-in/email   body: {email, password}
 *        → 返回会话 token，同时种下会话 cookie
 *     ② GET  {authUrl}/token           → 返回 JWT（Data API 要的就是这个）
 *
 *  ★ 部署到 GitHub Pages 后必须做的一步 ★
 *  Neon Auth 有来源白名单，默认只信任 localhost。
 *  上线后访问地址是 https://<你的用户名>.github.io，
 *  会被拒（403 INVALID_ORIGIN）。请到
 *     Neon 控制台 → Better Auth → Trusted Origins → Add Origin
 *  添加你的 Pages 地址，例如 https://yourname.github.io
 * ============================================================ */

window.NEON_CONFIG = {
  url:     "https://ep-purple-surf-b3n0of19.apirest.c-4.ap-southeast-1.aws.neon.tech/neondb/rest/v1",
  authUrl: "https://ep-purple-surf-b3n0of19.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth"
};

/* ============================================================
 *  盐田船期取数服务地址（线上版独立运行用）。
 *
 *  船期数据来自易物流盐田 www.156yt.cn（公众查询）。
 *  该站实测**不返回任何 Access-Control-* 头**，且有 JS 反爬挑战页、
 *  必须先建会话才能 POST 查询 —— 所以浏览器无法直接取，必须有服务端代理。
 *
 *  ★ 两条路径（页面会实时优先、快照兜底）：
 *  ① 实时接口：点「🔄 刷新」或「查询」时立刻取最新船期。
 *     推荐 Cloudflare Worker（worker-voyage.js）—— 部署快、出口 IP 信誉好、
 *     内置会话池与限流退避。部署完把地址填到下面 apiBase 的第一项：
 *         "https://ansud-voyage.<你的子域>.workers.dev"
 *     （结尾不要加 /api/voyage，页面会自动拼）
 *
 *  ② 静态快照：GitHub Actions 定时抓取后提交的 voyage-cache.json，
 *     与页面同域、零后端。实时接口不可用时自动顶上（页面会提示"实时暂不可用"）。
 *
 *  多个 apiBase 地址会按顺序尝试，第一个通的即生效；
 *  末尾自动回退同源 /api/voyage（需本机跑 start-server.cmd）。
 * ============================================================ */
window.VOYAGE_CONFIG = {
  /* 静态快照（兜底通道 ③）：GitHub Actions 定时抓取后提交的 voyage-cache.json。
     与页面同域，GitHub Pages 上直接可达。 */
  snapshot: "voyage-cache.json",

  /* 准实时触发器（可选，通道 ②）：实时接口不通时，POST 到这个地址，
     它去触发 GitHub Actions 抓一次盐田船期，1~3 分钟后页面轮询到新数据。
     —— 触发器源码见 trigger-worker.js（token 放服务端，页面不持有凭据）。
     留空 = 不用这条通道。 */
  trigger: "",

  /* 实时接口（首选，通道 ①）：点「🔄 刷新」或「查询」时走这里，按顺序尝试，
     第一个通的即生效。留空数组 = 只用快照。

     ★ 已填：你的 Cloudflare Worker（2026-10-23 部署并验证通过：
       /ping 200、/api/voyage 真实取数 542ms 返回 003W|YM WORTHINESS|外代）
         "https://ansud-voyage.song-687.workers.dev"

     ★ 国内网络环境提示：workers.dev 在部分网络下可能不稳。
       若给 Worker 绑了自定义域名（如 api.ansud.cn），
       把它加到**列表最前面**，页面会优先用它。

     ★ 不要填 Neon Functions 的 *.compute.*.aws.neon.tech 地址：
       2026-10-23 实测该域名一律返回 403（网关层拦截），填了只会白白等超时。 */
  apiBase: [
    "https://ansud-voyage.song-687.workers.dev"
  ]
};
