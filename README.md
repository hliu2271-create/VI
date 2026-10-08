# Aegis / ComputeShield · VI

算力履约保障原型。首页保留既有蓝紫配色、装饰卡片、渐变与演示视频，业务在同一页工作区继续。VI 增加公开浏览器 Demo、移动端适配与脱敏源码交付；机制沿用 IV，不代表新完成了目标链部署。

公开演示：https://aegis-computeshield-demo-vi.jocund-tetra-6250.chatgpt.site

公开版使用源码中的保险规则和定价模块，在访客浏览器内独立运行。报价、出单、理赔实验、节点状态模拟和单证核验可交互；会话刷新后重置。演示金额是模拟数据，不发生真实资金交易。公开版未接入模型，资料留在浏览器内存，不上传服务器。页面提供的 IV 机制报告是历史本地验证记录，保留原日期和 SHA-256；不是本次线上测试或 BOT Chain 部署证据。

## 运行

安装 Node.js 24 LTS，在源码根目录运行：

```sh
npm install
npm run build:demo
npm run preview:demo
```

访问 http://127.0.0.1:34888/?demo=1 。预览服务只提供静态文件，浏览器运行演示规则。

保留的 Node 本地版可用 `npm start`，访问 http://127.0.0.1:8788 。请确保 8787、8788 端口空闲；配置说明见 `.env.example`。Node 不自动加载该模板，需在启动前设置环境变量。本地模式与公开浏览器模式不同，本地上传文件写入 `server/uploads`。目标靶机接入、模型及链上功能需要自行配置，源码包不包含密钥、钱包资金或用户材料。

## 手机

共享移动样式覆盖各业务页面：安全区、触控尺寸、输入字号、竖横屏和视频小窗。iOS 输入框至少 16px，降低自动放大；键盘打开时避让小窗。普通手机浏览器没有注入式钱包时提供钱包 App 浏览器引导；演示无需钱包。

已在 Chromium / Android 与 WebKit / iPhone 模拟环境检查 320px、390/412px 和 844px 横屏。结果见 `reports/mobile-demo-VI.json`，键盘转换由模拟视口回归验证。未宣称真机验收或所有手机钱包兼容。

## 验证与目录

```sh
npx playwright install chromium webkit
npm test
```

`npm test` 构建公开版，运行键盘与双浏览器检查，最后扫描隐私。也可通过 `PLAYWRIGHT_MODULE`、`CHROME_PATH`、`PLAYWRIGHT_BROWSERS_PATH` 指向自己已有的测试环境。

- `frontend/`：网页源码、移动适配、原有字体授权文件与优化视频。
- `server/`、`contracts/`、`scripts/`：本地业务与合约源码。
- `tools/`：公开版构建、预览与验证工具。
- `reports/`：VI 结果与明确标注 IV 的历史机制报告。
- `media/`：原始演示视频；不会进入公开静态部署。
- `docs/项目计划书.md`：原型机制和未完成项；输入假设不等于商业盈利结论。

源码 ZIP 排除 Git 历史、托管项目身份、依赖缓存、环境实值、上传资料和个人截图。交付目录使用 D:/cyka/VI，既有版本不覆盖。原型尚需目标链实部署、外部需求验证和精算样本支持；请以页面标注与机制报告为准。

公开部署已成功且权限为公开；当前验收连接被托管平台 Cloudflare 返回 403，外部可访问性尚未验证。详见 reports/public-demo-VI.json。
