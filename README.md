# 库存记录本

给五金、批发等小生意用的桌面库存管理工具：管理产品规格、价格档、订单、账单、收款和补货。数据存在本地文件里，不联网、不上传，绿色免安装。

## 功能一览

- **产品与规格**：多档价格（批发 / VIP / 零售），下单按客户类型自动选价；批量 Excel 导入建产品
- **新建订单**：客户可搜索下拉、规格加减数量、自动算总价；库存可以卖成负数（货到未录入时先卖，红字提醒）
- **批量下单**：Excel 模板导入，一笔订单一行，依次确认成交
- **订单管理**：改单、删单（自动退库存）、付款状态、一键收款、合并生成账单（Excel 格式）
- **账单管理**：按客户开账单、多客户合并账单、导出文件名自动递增
- **补货**：手动补货 / Excel 模板导入，补货记录可搜索
- **微信订单识别**：截图识别 + 粘贴文字识别，OCR 完全在本机运行；识别歧义行会给出「疑似」候选按钮一键对应
- **统计**：销售汇总、客户收款汇总（已付/未付）、订单明细（可按品名规格搜索）、智能库存分析报告（含一页纸 PDF）
- **数据备份**：一键导出 / 导入 JSON 备份

详细操作见 [使用说明.txt](使用说明.txt)。

## 运行（开发模式）

需要 [Node.js](https://nodejs.org/) 18+ 和 npm。

```bash
npm install
npm start
```

国内网络下载 Electron 慢的话，装依赖前加国内镜像：

```bash
npm config set registry https://registry.npmmirror.com
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```

（macOS / Linux 把 `set` 换成 `export`。）

## 打包成绿色版（Windows）

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npx electron-builder --win --dir
```

打包结果在 `release/库存记录本/`，整个文件夹拷走就能用。项目根目录的 `make-zip.ps1` 可以一键打成发布用的 zip（PowerShell 运行）。

## 数据存在哪

所有数据都保存在程序文件夹里的「库存数据.json」中，不联网、不上传。备份 = 复制整个文件夹，或用软件右上角的「导出备份」。注意不要把文件夹放进 `C:\Program Files` 等系统目录（会存不了数据）。

## 技术栈

- Electron + 原生 JavaScript（无框架、无构建步骤，改完直接跑）
- [tesseract.js](https://github.com/naptha/tesseract.js) 做 OCR（语言包在 `langdata/`，识别完全本地完成）
- [SheetJS (xlsx)](https://sheetjs.com/) 读写 Excel
- 纯函数匹配算法在 `ocr-match.js`，可用 `node test-ocr-match.js` 跑单元测试

## 许可

[MIT](LICENSE)
